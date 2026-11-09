/**
 * The voice engines of one organization: whether GPT Realtime can be used,
 * its OpenAI key and the workspace switch.
 *
 * - The key: the organization's own, in its vault as MODEL_OPENAI (service
 *   "model.openai", only for api.openai.com), checked with OpenAI before it is
 *   saved; else OPENAI_API_KEY on a self-hosted server. Hosted organizations
 *   always use their own key (tenancy: one vault per organization). Values are
 *   never logged or returned.
 * - The workspace switch: workspace admins allow or block the premium engine
 *   (kv `voice-engine.policy.<workspace>`, allowed by default).
 */
import { DEFAULT_WORKSPACE_ID, type AuditActor, type Store } from "@open-gpt-live/core";
import { OpenAIRealtimeVoiceClient, type StreamingSTTWebSocketFactory } from "@open-gpt-live/adapters";
import type { VoiceEngineCapability, VoiceEngineKeyInfo, VoiceEngineView } from "@open-gpt-live/protocol";
import type { SecretVault } from "../secrets/vault.js";
import { modelOptions, realtimeEngineConfig, type RealtimeEngineConfig } from "./config.js";
import { REALTIME_VOICES } from "@open-gpt-live/protocol";

export const REALTIME_KEY_SECRET = "MODEL_OPENAI";
export const REALTIME_KEY_SERVICE = "model.openai";
const OPENAI_HOST = "api.openai.com";
const KEY_INFO_KV = "voice-engine.key.v1";
const policyKey = (workspaceId: string) => `voice-engine.policy.${workspaceId}`;

export class VoiceEngineError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface VoiceEngineServiceOptions {
  store: Store;
  orgId: string;
  vault: SecretVault | undefined;
  env: NodeJS.ProcessEnv;
  hosted: boolean;
  webSocketFactory: StreamingSTTWebSocketFactory;
  fetch?: FetchLike;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** The HTTPS API next to a Realtime WebSocket URL (wss://host/v1/realtime → https://host/v1). */
export function apiBaseFor(url: string | undefined): string {
  if (!url) return "https://api.openai.com/v1";
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/realtime\/?$/, "") || "/v1";
  return parsed.toString().replace(/\/+$/, "");
}

/** Check a key with OpenAI: it must be accepted, and ideally open the Realtime model. */
export async function checkOpenAIKey(key: string, input: { model: string; url?: string; fetch?: FetchLike; now?: () => number }): Promise<VoiceEngineKeyInfo> {
  const trimmed = key.trim();
  if (!/^[\x21-\x7e]{20,400}$/.test(trimmed)) throw new VoiceEngineError(400, "invalid_key", "That doesn't look like an OpenAI key (it starts with sk-).");
  const doFetch = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = apiBaseFor(input.url);
  const get = async (path: string) => {
    try {
      return await doFetch(`${base}${path}`, { headers: { authorization: `Bearer ${trimmed}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new VoiceEngineError(502, "check_failed", "Couldn't reach OpenAI to check the key. Try again in a moment.");
    }
  };
  const model = await get(`/models/${encodeURIComponent(input.model)}`);
  if (model.status === 401 || model.status === 403) throw new VoiceEngineError(400, "invalid_key", "OpenAI didn't accept this key. Check that you copied all of it.");
  let realtimeAccess = model.ok;
  if (!model.ok) {
    // 404: the key works but can't see this model (project limits); anything else: OpenAI had a problem.
    if (model.status !== 404) throw new VoiceEngineError(502, "check_failed", `OpenAI couldn't check the key (HTTP ${model.status}). Try again in a moment.`);
    const list = await get("/models");
    if (list.status === 401 || list.status === 403) throw new VoiceEngineError(400, "invalid_key", "OpenAI didn't accept this key. Check that you copied all of it.");
    realtimeAccess = false;
  }
  return { last4: trimmed.slice(-4), checkedAt: (input.now ?? Date.now)(), realtimeAccess };
}

export class VoiceEngineService {
  readonly config: RealtimeEngineConfig;
  private hasOrgKey = false;
  private readonly policies = new Map<string, boolean>();
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly log: NonNullable<VoiceEngineServiceOptions["log"]>;

  constructor(private readonly options: VoiceEngineServiceOptions) {
    this.log = options.log ?? (() => undefined);
    this.config = realtimeEngineConfig(options.env, { hosted: options.hosted, log: this.log });
    // Removed or replaced in the Secrets panel too.
    options.vault?.onChange((ownerId) => {
      if (ownerId === options.orgId) void this.refreshKey();
    });
  }

  async load(): Promise<this> {
    await this.refreshKey();
    await this.loadPolicy(DEFAULT_WORKSPACE_ID);
    return this;
  }

  /** Key or workspace switch changed: sessions re-send their capabilities. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get keySource(): VoiceEngineView["keySource"] {
    return this.hasOrgKey ? "org" : this.config.serverKey ? "server" : "none";
  }

  /** The workspace allows GPT Realtime (cached; unknown workspaces load in the background, allowed until then). */
  allowed(workspaceId: string): boolean {
    const known = this.policies.get(workspaceId);
    if (known === undefined) void this.loadPolicy(workspaceId);
    return known ?? true;
  }

  capability(workspaceId: string, sibylUsdPerMinute?: number): VoiceEngineCapability {
    const config = this.config;
    const reason = !config.enabled ? "disabled" : this.keySource === "none" ? "no_key" : !this.allowed(workspaceId) ? "blocked" : undefined;
    return {
      default: config.defaultEngine,
      realtime: {
        available: !reason,
        ...(reason ? { unavailableReason: reason } : {}),
        models: modelOptions(config),
        voices: [...REALTIME_VOICES],
        defaultModel: config.defaultModel,
        defaultVoice: config.defaultVoice
      },
      ...(sibylUsdPerMinute !== undefined ? { sibylUsdPerMinute } : {})
    };
  }

  async view(workspaceId: string, sibylUsdPerMinute?: number): Promise<VoiceEngineView> {
    await this.loadPolicy(workspaceId);
    const info = this.hasOrgKey ? await this.options.store.kv.get<VoiceEngineKeyInfo>(this.options.orgId, KEY_INFO_KV) : undefined;
    return {
      ...this.capability(workspaceId, sibylUsdPerMinute),
      keySource: this.keySource,
      ...(info ? { key: info } : {}),
      allowRealtime: this.allowed(workspaceId),
      hosted: this.options.hosted
    };
  }

  /** The key GPT Realtime uses now (never logged). */
  async resolveKey(): Promise<{ key: string; source: "org" | "server" } | undefined> {
    const vault = this.options.vault;
    if (vault && (await vault.has(this.options.orgId, REALTIME_KEY_SECRET))) {
      return { key: await vault.resolve(this.options.orgId, REALTIME_KEY_SECRET, { host: OPENAI_HOST }), source: "org" };
    }
    return this.config.serverKey ? { key: this.config.serverKey, source: "server" } : undefined;
  }

  /** Open a Realtime session with the key in use. */
  async connect(model: string, signal?: AbortSignal): Promise<{ client: OpenAIRealtimeVoiceClient; ownKey: boolean }> {
    const resolved = await this.resolveKey();
    if (!resolved) throw new VoiceEngineError(400, "no_key", "Add an OpenAI key to use GPT Realtime.");
    const client = await OpenAIRealtimeVoiceClient.connect({
      apiKey: resolved.key,
      model,
      webSocketFactory: this.options.webSocketFactory,
      ...(this.config.url ? { url: this.config.url } : {}),
      ...(signal ? { signal } : {})
    });
    // The organization's own key pays OpenAI directly: never charged as AI credits.
    return { client, ownKey: resolved.source === "org" };
  }

  async saveKey(key: unknown, actor: AuditActor): Promise<VoiceEngineKeyInfo> {
    const vault = this.requireVault();
    if (typeof key !== "string" || !key.trim()) throw new VoiceEngineError(400, "key_required", "Paste your OpenAI key.");
    const info = await checkOpenAIKey(key, this.checkInput());
    await vault.set(
      this.options.orgId,
      {
        name: REALTIME_KEY_SECRET,
        value: key.trim(),
        service: REALTIME_KEY_SERVICE,
        description: "The organization's OpenAI key: GPT Realtime voice uses it.",
        allowedHosts: [OPENAI_HOST]
      },
      actor
    );
    await this.options.store.kv.set(this.options.orgId, KEY_INFO_KV, info);
    this.log("voice_engine.key_saved", { orgId: this.options.orgId, last4: info.last4, realtimeAccess: info.realtimeAccess });
    await this.refreshKey();
    return info;
  }

  async removeKey(actor: AuditActor): Promise<void> {
    const vault = this.requireVault();
    const removed = await vault.delete(this.options.orgId, REALTIME_KEY_SECRET, actor);
    await this.options.store.kv.delete(this.options.orgId, KEY_INFO_KV);
    if (removed) this.log("voice_engine.key_removed", { orgId: this.options.orgId });
    await this.refreshKey();
  }

  /** Check the key in use with OpenAI now. */
  async testKey(): Promise<{ ok: boolean; message: string }> {
    const resolved = await this.resolveKey();
    if (!resolved) return { ok: false, message: "There's no OpenAI key to test." };
    try {
      const info = await checkOpenAIKey(resolved.key, this.checkInput());
      if (resolved.source === "org") await this.options.store.kv.set(this.options.orgId, KEY_INFO_KV, info);
      return info.realtimeAccess
        ? { ok: true, message: `The key works and can use ${this.config.defaultModel}.` }
        : { ok: false, message: `OpenAI accepted the key, but it can't use ${this.config.defaultModel}. Check the project's model access at OpenAI.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "The key check failed." };
    }
  }

  async setPolicy(workspaceId: string, allowRealtime: unknown): Promise<void> {
    if (typeof allowRealtime !== "boolean") throw new VoiceEngineError(400, "invalid_policy", "allowRealtime must be true or false.");
    await this.options.store.kv.set(this.options.orgId, policyKey(workspaceId), { allowRealtime });
    this.policies.set(workspaceId, allowRealtime);
    this.log("voice_engine.policy_changed", { orgId: this.options.orgId, workspaceId, allowRealtime });
    this.emit();
  }

  private async loadPolicy(workspaceId: string): Promise<void> {
    if (this.loading.has(workspaceId)) return;
    this.loading.add(workspaceId);
    try {
      const stored = await this.options.store.kv.get<{ allowRealtime?: boolean }>(this.options.orgId, policyKey(workspaceId));
      const allowed = stored?.allowRealtime !== false;
      const changed = this.policies.get(workspaceId) !== allowed;
      this.policies.set(workspaceId, allowed);
      if (changed && !allowed) this.emit();
    } catch (error) {
      this.log("voice_engine.policy_load_failed", { workspaceId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.loading.delete(workspaceId);
    }
  }

  private async refreshKey(): Promise<void> {
    const has = Boolean(await this.options.vault?.has(this.options.orgId, REALTIME_KEY_SECRET).catch(() => false));
    if (has === this.hasOrgKey) return;
    this.hasOrgKey = has;
    this.emit();
  }

  private requireVault(): SecretVault {
    if (!this.options.vault) throw new VoiceEngineError(503, "vault_unavailable", "The secrets vault isn't available on this server (check SIBYL_SECRET_KEY).");
    return this.options.vault;
  }

  private checkInput() {
    return {
      model: this.config.defaultModel,
      ...(this.config.url ? { url: this.config.url } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.now ? { now: this.options.now } : {})
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener never breaks a change.
      }
    }
  }
}
