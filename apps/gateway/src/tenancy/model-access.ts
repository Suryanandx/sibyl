/**
 * Model access: which OpenRouter key an organization's model calls use.
 *
 * - Own key (BYOK): stored in the organization's vault as MODEL_OPENROUTER
 *   (service "model.openrouter", allowed host openrouter.ai), checked live
 *   with OpenRouter's key endpoint (GET /api/v1/key: label, limit, usage)
 *   before it is saved. It wins over everything else.
 * - Self-hosted without an own key: OPENROUTER_API_KEY from the server's
 *   environment ("server key"), as before.
 * - Hosted without an own key: the platform key, paid for with AI credits.
 *
 * The runtime is built for one key (`modelEnv`): adapters, tools, OCR,
 * embeddings and the scout all read it. Saving or removing the key reloads
 * the organization's runtime (open connections reconnect).
 */
import { createHash } from "node:crypto";
import type { AuditActor, Store } from "@open-gpt-live/core";
import type { ModelAccessMode, ModelAccessView, ModelKeyInfo } from "@open-gpt-live/protocol";
import { loadOrgKey } from "../secrets/crypto.js";
import { SecretVault } from "../secrets/vault.js";

export const MODEL_KEY_SECRET = "MODEL_OPENROUTER";
export const MODEL_KEY_SERVICE = "model.openrouter";
const STATUS_KV_KEY = "model-access.v1";
const OPENROUTER_HOST = "openrouter.ai";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

export type { ModelAccessMode, ModelAccessView, ModelKeyInfo };

export class ModelAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Check a key with OpenRouter (GET /api/v1/key). Throws ModelAccessError when it is not usable. */
export async function checkOpenRouterKey(key: string, options: { fetch?: FetchLike; baseUrl?: string; now?: () => number } = {}): Promise<ModelKeyInfo> {
  const trimmed = key.trim();
  if (!/^[\x21-\x7e]{20,300}$/.test(trimmed)) throw new ModelAccessError(400, "invalid_key", "That doesn't look like an OpenRouter key (it starts with sk-or-).");
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(`${(options.baseUrl ?? OPENROUTER_API_BASE).replace(/\/+$/, "")}/key`, {
      headers: { authorization: `Bearer ${trimmed}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new ModelAccessError(502, "check_failed", "Couldn't reach OpenRouter to check the key. Try again in a moment.");
  }
  if (response.status === 401 || response.status === 403) throw new ModelAccessError(400, "invalid_key", "OpenRouter didn't accept this key. Check that you copied all of it.");
  if (!response.ok) throw new ModelAccessError(502, "check_failed", `OpenRouter couldn't check the key (HTTP ${response.status}). Try again in a moment.`);
  const body = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  const data = body.data ?? {};
  const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const limit = number(data.limit) ?? null;
  const usage = number(data.usage);
  const remaining = number(data.limit_remaining) ?? (limit !== null && usage !== undefined ? Math.max(0, limit - usage) : null);
  return {
    last4: trimmed.slice(-4),
    ...(typeof data.label === "string" && data.label ? { label: data.label.slice(0, 80) } : {}),
    limitUsd: limit,
    ...(usage !== undefined ? { usageUsd: usage } : {}),
    remainingUsd: remaining,
    ...(typeof data.is_free_tier === "boolean" ? { freeTier: data.is_free_tier } : {}),
    checkedAt: (options.now ?? Date.now)()
  };
}

/** A short, non-reversible id for a key (catalog caches, logs). */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex").slice(0, 16);
}

/**
 * Read an organization's own key before its runtime exists (the runtime is
 * built for the key). undefined: none stored, or the vault isn't available.
 */
export async function readOwnModelKey(input: { store: Store; env: NodeJS.ProcessEnv; orgId: string; log?: (event: string, fields?: Record<string, unknown>) => void }): Promise<string | undefined> {
  let vault: SecretVault;
  try {
    vault = new SecretVault({ store: input.store, key: loadOrgKey(input.env, input.orgId) });
  } catch {
    return undefined;
  }
  try {
    if (!(await vault.has(input.orgId, MODEL_KEY_SECRET))) return undefined;
    return await vault.resolve(input.orgId, MODEL_KEY_SECRET, { host: OPENROUTER_HOST });
  } catch (error) {
    input.log?.("model_access.key_unreadable", { orgId: input.orgId, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  } finally {
    vault.close();
  }
}

/**
 * The environment an organization's runtime is built with: its own key (or
 * the platform's) as OPENROUTER_API_KEY, and speech going to OpenRouter on
 * the same key unless the server points speech somewhere else.
 */
export function resolveModelAccess(input: { env: NodeJS.ProcessEnv; hosted: boolean; ownKey?: string }): { mode: ModelAccessMode; env: NodeJS.ProcessEnv; apiKey?: string } {
  const serverKey = input.env.OPENROUTER_API_KEY?.trim() || undefined;
  if (input.ownKey) {
    const env: NodeJS.ProcessEnv = { ...input.env, OPENROUTER_API_KEY: input.ownKey };
    if (!env.LLM_PROVIDER?.trim() && !env.OPENAI_BASE_URL?.trim()) env.LLM_PROVIDER = "openrouter";
    // Speech that would go to OpenRouter uses the same (own) key, never the server's.
    if (!env.STT_BASE_URL?.trim()) delete env.STT_API_KEY;
    if (!env.TTS_BASE_URL?.trim()) delete env.TTS_API_KEY;
    return { mode: "byok", env, apiKey: input.ownKey };
  }
  // Hosted without an own key: the platform key, paid with credits. Self-hosted: the server's key (if any).
  return { mode: input.hosted ? "credits" : "server", env: input.env, ...(serverKey ? { apiKey: serverKey } : {}) };
}

export interface ModelAccessServiceOptions {
  store: Store;
  orgId: string;
  vault: SecretVault | undefined;
  hosted: boolean;
  /** How the runtime was built (own key, server key, credits, none). */
  mode: ModelAccessMode;
  serverKey: boolean;
  /** Hosted: the organization's AI credits balance (USD). */
  creditsBalance?: () => number;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class ModelAccessService {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: ModelAccessServiceOptions) {
    // Removed or replaced in the Secrets panel too: same reload as from Settings → Models.
    options.vault?.onChange((ownerId) => {
      if (ownerId !== options.orgId) return;
      void options.vault!.has(ownerId, MODEL_KEY_SECRET).then((has) => {
        if (has !== (options.mode === "byok")) this.emit();
      });
    });
  }

  get mode(): ModelAccessMode {
    return this.options.mode;
  }

  /** Saved or removed: the organization's runtime is rebuilt for the new key. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status(input: { refresh?: boolean } = {}): Promise<ModelAccessView> {
    const balance = this.options.creditsBalance?.();
    const view: ModelAccessView = { mode: this.options.mode, hosted: this.options.hosted, serverKey: this.options.serverKey, ...(balance !== undefined ? { credits: { balanceUsd: balance } } : {}) };
    const vault = this.options.vault;
    if (!vault || !(await vault.has(this.options.orgId, MODEL_KEY_SECRET))) return view;
    let info = await this.options.store.kv.get<ModelKeyInfo>(this.options.orgId, STATUS_KV_KEY);
    if (input.refresh || !info) {
      try {
        const key = await vault.resolve(this.options.orgId, MODEL_KEY_SECRET, { host: OPENROUTER_HOST });
        info = await checkOpenRouterKey(key, this.checkOptions());
        await this.options.store.kv.set(this.options.orgId, STATUS_KV_KEY, info);
      } catch (error) {
        this.options.log?.("model_access.check_failed", { orgId: this.options.orgId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return info ? { ...view, key: info } : view;
  }

  /** Check the key with OpenRouter, then store it in the vault. */
  async save(key: unknown, actor: AuditActor): Promise<ModelAccessView> {
    const vault = this.requireVault();
    if (typeof key !== "string" || !key.trim()) throw new ModelAccessError(400, "key_required", "Paste your OpenRouter key.");
    const info = await checkOpenRouterKey(key, this.checkOptions());
    await vault.set(
      this.options.orgId,
      { name: MODEL_KEY_SECRET, value: key.trim(), service: MODEL_KEY_SERVICE, description: "The organization's OpenRouter key: every model call uses it.", allowedHosts: [OPENROUTER_HOST] },
      actor
    );
    await this.options.store.kv.set(this.options.orgId, STATUS_KV_KEY, info);
    this.options.log?.("model_access.key_saved", { orgId: this.options.orgId, last4: info.last4 });
    this.emit();
    return { ...(await this.status()), mode: "byok", key: info };
  }

  async remove(actor: AuditActor): Promise<void> {
    const vault = this.requireVault();
    const removed = await vault.delete(this.options.orgId, MODEL_KEY_SECRET, actor);
    await this.options.store.kv.delete(this.options.orgId, STATUS_KV_KEY);
    if (removed) {
      this.options.log?.("model_access.key_removed", { orgId: this.options.orgId });
      this.emit();
    }
  }

  private requireVault(): SecretVault {
    if (!this.options.vault) throw new ModelAccessError(503, "vault_unavailable", "The secrets vault isn't available on this server (check SIBYL_SECRET_KEY).");
    return this.options.vault;
  }

  private checkOptions() {
    return {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      ...(this.options.now ? { now: this.options.now } : {})
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener never breaks the save.
      }
    }
  }
}
