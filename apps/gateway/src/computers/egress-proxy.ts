/**
 * The network policy for agent computers: every sandbox browser is launched
 * with this gateway-side HTTP proxy, and the proxy only lets it reach public
 * internet addresses. It uses the same checks as every other outbound fetch
 * (net/safe-fetch.ts): `assertPublicUrl` before connecting and
 * `guardedLookup` at connect time, so private, loopback, link-local (cloud
 * metadata) and reserved ranges are refused, DNS rebinding included.
 *
 * Each sandbox gets its own credentials (Proxy-Authorization: Basic), so the
 * proxy serves nobody else and every refusal is attributed to one sandbox.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { assertPublicUrl, guardedLookup, type ResolveHost } from "../net/safe-fetch.js";

export interface ProxyCredentials {
  username: string;
  password: string;
}

export interface EgressProxyOptions {
  bind: string;
  port: number;
  /** A sandbox's request was refused (shown in its timeline). */
  onBlocked?(username: string, target: string, reason: string): void;
  /** Test seam for DNS. */
  resolveHost?: ResolveHost;
  /** Test seam: open the upstream TCP connection (default: net.connect with the guarded lookup). */
  connect?(host: string, port: number): Socket;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const CONNECT_TIMEOUT_MS = 15_000;

export class EgressProxy {
  private server: Server | undefined;
  private readonly users = new Map<string, Buffer>();
  private readonly sockets = new Set<Socket>();
  port = 0;

  constructor(private readonly options: EgressProxyOptions) {}

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = createServer((req, res) => void this.forward(req, res));
    server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => void this.tunnel(req, socket, head));
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.bind, () => resolvePromise());
    });
    this.server = server;
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : this.options.port;
    return this.port;
  }

  /** New credentials for one sandbox. */
  issue(): ProxyCredentials {
    const username = `sbx-${randomBytes(6).toString("hex")}`;
    const password = randomBytes(24).toString("base64url");
    this.users.set(username, Buffer.from(password));
    return { username, password };
  }

  revoke(username: string): void {
    this.users.delete(username);
  }

  async close(): Promise<void> {
    this.users.clear();
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }

  /** The sandbox the request belongs to, or undefined (bad or missing credentials). */
  private user(headers: IncomingHttpHeaders): string | undefined {
    const header = headers["proxy-authorization"];
    if (typeof header !== "string" || !header.startsWith("Basic ")) return undefined;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split < 0) return undefined;
    const username = decoded.slice(0, split);
    const expected = this.users.get(username);
    const given = Buffer.from(decoded.slice(split + 1));
    if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return username;
  }

  private blocked(username: string, target: string, error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    this.options.onBlocked?.(username, target, reason);
    return reason;
  }

  private open(host: string, port: number): Socket {
    if (this.options.connect) return this.options.connect(host, port);
    return netConnect({ host, port, lookup: guardedLookup, timeout: CONNECT_TIMEOUT_MS });
  }

  /** CONNECT host:port (https, wss). */
  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    const username = this.user(req.headers);
    if (!username) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="sibyl"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = req.url ?? "";
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65_535) {
      client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const host = match[1]!;
    try {
      await assertPublicUrl(`https://${host.includes(":") ? `[${host}]` : host}:${port}/`, this.options.resolveHost);
    } catch (error) {
      const reason = this.blocked(username, target, error);
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
      return;
    }
    const upstream = this.open(host, port);
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("timeout", () => upstream.destroy(new Error("connect timed out")));
    upstream.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EBLOCKED") this.blocked(username, target, error);
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    client.once("close", () => upstream.destroy());
  }

  /** Plain http:// requests (absolute URL in the request line). */
  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const username = this.user(req.headers);
    if (!username) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="sibyl"', "content-length": "0" }).end();
      return;
    }
    let url: URL;
    try {
      url = await assertPublicUrl(req.url ?? "", this.options.resolveHost);
      if (url.protocol !== "http:") throw new Error("only http goes through the proxy without CONNECT");
    } catch (error) {
      const reason = this.blocked(username, req.url ?? "", error);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(`Blocked by Sibyl: ${reason}`);
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    }
    const upstream = httpRequest(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        lookup: guardedLookup,
        timeout: CONNECT_TIMEOUT_MS
      },
      (reply) => {
        const out: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(reply.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
        }
        res.writeHead(reply.statusCode ?? 502, out);
        reply.pipe(res);
      }
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EBLOCKED" || (error as { cause?: { code?: string } }).cause?.code === "EBLOCKED") this.blocked(username, url.toString(), error);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end();
    });
    req.pipe(upstream);
  }
}
