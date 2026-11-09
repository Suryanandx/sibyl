/**
 * The Docker sandbox driver: one container per agent computer, created
 * through the Docker Engine API on its unix socket (no docker CLI needed, so
 * it also works from a gateway container with the socket mounted).
 *
 * Each container runs a Playwright browser server (Dockerfile.computer,
 * sandbox/server.cjs) as a
 * non-root user with a read-only root filesystem, no capabilities, no new
 * privileges, CPU / memory / process limits and no host mounts at all (the
 * file area stays on the gateway; downloads and uploads stream over the
 * Playwright connection). Its browser reaches the network only through the
 * gateway's egress proxy (see egress-proxy.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ComputersConfig } from "./config.js";

/** A running sandbox the gateway can drive. */
export interface Sandbox {
  id: string;
  /** Playwright server WebSocket endpoint (secret path). */
  endpoint: string;
  stop(): Promise<void>;
}

export interface SandboxSpec {
  agentId: string;
  workspaceId: string;
  /** The egress proxy the sandbox browser must use (fixed at launch inside the container). */
  proxy: { server: string; username: string; password: string };
}

export type Availability = { ok: true } | { ok: false; reason: string };

/** How sandboxes are made. Docker is the only driver; tests use a fake. */
export interface SandboxDriver {
  check(): Promise<Availability>;
  start(spec: SandboxSpec): Promise<Sandbox>;
  /** Remove sandboxes left over from an earlier run of the gateway. Returns how many. */
  cleanup(): Promise<number>;
}

export const SANDBOX_LABEL = "sibyl.computer";
/** Which gateway made a sandbox (a hash of its data directory), so cleanup never touches another gateway's. */
const OWNER_LABEL = "sibyl.gateway";
const SERVER_PORT = "3000/tcp";

/** The Docker socket: DOCKER_HOST (unix://…), else the usual places. */
export function dockerSocketPath(env: NodeJS.ProcessEnv): string | { error: string } {
  const host = env.DOCKER_HOST?.trim();
  if (host) {
    if (host.startsWith("unix://")) return host.slice("unix://".length);
    return { error: `DOCKER_HOST ${host} is not a unix socket; agent computers need the local Docker socket` };
  }
  for (const candidate of ["/var/run/docker.sock", join(homedir(), ".docker/run/docker.sock")]) {
    if (existsSync(candidate)) return candidate;
  }
  return { error: "Docker is not running (no Docker socket found)" };
}

interface DockerReply {
  status: number;
  body: unknown;
}

/** A small Docker Engine API client over the unix socket. */
export class DockerApi {
  constructor(private readonly socketPath: string) {}

  call(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<DockerReply> {
    return new Promise((resolvePromise, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: { host: "docker", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
          timeout: timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              // Plain-text replies (ping) stay as text.
            }
            resolvePromise({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error(`Docker API ${method} ${path} timed out`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

function dockerMessage(reply: DockerReply): string {
  const message = (reply.body as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : `HTTP ${reply.status}`;
}

export class DockerDriver implements SandboxDriver {
  private readonly api: DockerApi | undefined;
  private readonly socketError: string | undefined;
  private readonly owner: string;

  constructor(
    private readonly config: ComputersConfig,
    env: NodeJS.ProcessEnv
  ) {
    this.owner = createHash("sha256").update(config.dataDir).digest("hex").slice(0, 16);
    const socket = dockerSocketPath(env);
    if (typeof socket === "string") this.api = new DockerApi(socket);
    else this.socketError = socket.error;
  }

  async check(): Promise<Availability> {
    if (!this.api) return { ok: false, reason: this.socketError ?? "Docker is not available" };
    try {
      const ping = await this.api.call("GET", "/_ping", undefined, 3_000);
      if (ping.status !== 200) return { ok: false, reason: `Docker is not responding (${dockerMessage(ping)})` };
    } catch {
      return { ok: false, reason: "Docker is not running (its socket does not answer)" };
    }
    const image = await this.api.call("GET", `/images/${encodeURIComponent(this.config.image)}/json`, undefined, 5_000);
    if (image.status === 404) {
      return { ok: false, reason: `The sandbox image ${this.config.image} is not built yet (docker build -f Dockerfile.computer -t ${this.config.image} .)` };
    }
    if (image.status !== 200) return { ok: false, reason: `Docker could not check the sandbox image (${dockerMessage(image)})` };
    return { ok: true };
  }

  async start(spec: SandboxSpec): Promise<Sandbox> {
    const api = this.api;
    if (!api) throw new Error(this.socketError ?? "Docker is not available");
    const token = randomBytes(24).toString("base64url");
    const { config } = this;
    const name = `sibyl-computer-${spec.agentId.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}-${randomBytes(3).toString("hex")}`;
    const create = await api.call("POST", `/containers/create?name=${encodeURIComponent(name)}`, {
      Image: config.image,
      User: "pwuser",
      Env: [`SIBYL_COMPUTER_PATH=${token}`, `SIBYL_COMPUTER_PROXY=${JSON.stringify(spec.proxy)}`],
      Labels: { [SANDBOX_LABEL]: "1", [OWNER_LABEL]: this.owner, "sibyl.agent": spec.agentId, "sibyl.workspace": spec.workspaceId },
      ExposedPorts: { [SERVER_PORT]: {} },
      HostConfig: {
        AutoRemove: true,
        Init: true,
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m", "/home/pwuser": "rw,nosuid,nodev,size=256m,uid=1001,gid=1001" },
        ShmSize: 256 * 1024 * 1024,
        NanoCpus: Math.round(config.cpus * 1e9),
        Memory: config.memoryMb * 1024 * 1024,
        MemorySwap: config.memoryMb * 1024 * 1024,
        PidsLimit: config.pids,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        // Lets the browser reach the egress proxy on the host (Linux; Docker Desktop has it built in).
        ExtraHosts: ["host.docker.internal:host-gateway"],
        ...(config.network ? { NetworkMode: config.network } : { PortBindings: { [SERVER_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }] } })
      }
    });
    if (create.status !== 201) throw new Error(`Docker could not create the sandbox (${dockerMessage(create)})`);
    const id = (create.body as { Id: string }).Id;
    const remove = async (): Promise<void> => {
      // AutoRemove deletes it once stopped; force-remove covers a container that never started.
      await api.call("DELETE", `/containers/${id}?force=true`, undefined, 15_000).catch(() => undefined);
    };
    try {
      const started = await api.call("POST", `/containers/${id}/start`);
      if (started.status !== 204 && started.status !== 304) throw new Error(`Docker could not start the sandbox (${dockerMessage(started)})`);
      const inspect = await api.call("GET", `/containers/${id}/json`);
      const settings = (inspect.body as { NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null>; Networks?: Record<string, { IPAddress?: string }> } })
        .NetworkSettings;
      let address: string | undefined;
      if (config.network) {
        const ip = settings?.Networks?.[config.network]?.IPAddress;
        if (ip) address = `${ip}:3000`;
      } else {
        const port = settings?.Ports?.[SERVER_PORT]?.[0]?.HostPort;
        if (port) address = `127.0.0.1:${port}`;
      }
      if (!address) throw new Error("Docker started the sandbox but gave it no address");
      return { id, endpoint: `ws://${address}/${token}`, stop: remove };
    } catch (error) {
      await remove();
      throw error;
    }
  }

  async cleanup(): Promise<number> {
    if (!this.api) return 0;
    const filters = encodeURIComponent(JSON.stringify({ label: [`${SANDBOX_LABEL}=1`, `${OWNER_LABEL}=${this.owner}`] }));
    const list = await this.api.call("GET", `/containers/json?all=true&filters=${filters}`).catch(() => undefined);
    if (!list || list.status !== 200 || !Array.isArray(list.body)) return 0;
    for (const container of list.body as Array<{ Id: string }>) {
      await this.api.call("DELETE", `/containers/${container.Id}?force=true`).catch(() => undefined);
    }
    return list.body.length;
  }
}
