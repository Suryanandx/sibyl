/**
 * Secrets over the WebSocket: the secure prompt (`secret.request` →
 * `secret.provide` / `secret.cancel`) and the Secrets panel (`secrets.list`,
 * `secret.update`, `secret.delete` → `secrets.state`).
 *
 * The value a user types arrives in `secret.provide` / `secret.update`, goes
 * straight into the vault and is never echoed, logged, stored in a
 * conversation or shown to the model.
 */
import {
  SECRET_EVENTS,
  type ClientMessage,
  type SecretRequestView,
  type SecretsClientMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { auditActor, type Principal } from "@open-gpt-live/core";
import { normalizeHostList } from "./hosts.js";
import { SecretError, type SecretVault } from "./vault.js";

export const SECRET_PROMPT_TTL_MS = 10 * 60 * 1000;

export type SecretPromptOutcome =
  | { status: "saved"; allowedHosts: string[] }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "unavailable"; reason: string };

export interface SecretPromptRequest {
  name: string;
  service: string;
  description: string;
  allowedHosts: string[];
  howToGet?: string;
  docsUrl?: string;
  replace: boolean;
}

export interface SecretsSession {
  /** Handle a secrets client message; false when it isn't one. */
  handle(message: ClientMessage): Promise<boolean>;
  dispose(): void;
}

interface SessionEntry {
  ownerId: string;
  send(message: ServerMessage): void;
  conversationId(): string | undefined;
  /** Who is on this connection (audit: secret changes by name, never the value). */
  principal?(): Principal | undefined;
  connectedAt: number;
}

interface PendingPrompt {
  ownerId: string;
  session: SessionEntry;
  view: SecretRequestView;
  resolve(outcome: SecretPromptOutcome): void;
}

export interface SecretsHubOptions {
  vault: SecretVault;
  createId(): string;
  now?(): number;
  ttlMs?: number;
  log?(event: string, fields?: Record<string, unknown>): void;
}

const SECRETS_TYPES = new Set<string>(Object.values(SECRET_EVENTS));

export function isSecretsClientMessage(message: ClientMessage): message is SecretsClientMessage {
  return SECRETS_TYPES.has(message.type);
}

/** Routes secret prompts to the right open app and applies panel changes. */
export class SecretsHub {
  private readonly sessions = new Set<SessionEntry>();
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly stopListening: () => void;

  constructor(private readonly options: SecretsHubOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SECRET_PROMPT_TTL_MS;
    this.stopListening = options.vault.onChange((ownerId) => void this.broadcastState(ownerId));
  }

  /** A WebSocket connection joins (one per open app). */
  connect(input: {
    ownerId: string;
    send(message: ServerMessage): void;
    conversationId(): string | undefined;
    principal?(): Principal | undefined;
  }): SecretsSession {
    const entry: SessionEntry = { ...input, connectedAt: this.now() };
    this.sessions.add(entry);
    return {
      handle: async (message) => {
        if (!isSecretsClientMessage(message)) return false;
        await this.handle(entry, message);
        return true;
      },
      dispose: () => {
        this.sessions.delete(entry);
        for (const [id, prompt] of this.pending) {
          if (prompt.session === entry) this.settle(id, { status: "unavailable", reason: "the app was closed before the key was entered" });
        }
      }
    };
  }

  /**
   * Show the secure box in the reply of `runId` and wait for the user.
   * Resolves on save, cancel, timeout (10 min) or when the run is aborted.
   */
  ask(
    ownerId: string,
    request: SecretPromptRequest,
    run: { runId: string; conversationId?: string; signal: AbortSignal }
  ): Promise<SecretPromptOutcome> {
    const session = this.pickSession(ownerId, run.conversationId);
    if (!session) {
      return Promise.resolve({ status: "unavailable", reason: "nobody has Sibyl open to type the key (this runs in the background)" });
    }
    if (run.signal.aborted) return Promise.resolve({ status: "expired" });
    const createdAt = this.now();
    const view: SecretRequestView = {
      id: this.options.createId(),
      runId: run.runId,
      ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      name: request.name,
      service: request.service,
      description: request.description,
      allowedHosts: request.allowedHosts,
      ...(request.howToGet ? { howToGet: request.howToGet } : {}),
      ...(request.docsUrl ? { docsUrl: request.docsUrl } : {}),
      replace: request.replace,
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    return new Promise<SecretPromptOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(view.id, { status: "expired" }), this.ttlMs);
      const onAbort = (): void => this.settle(view.id, { status: "expired" });
      run.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(view.id, {
        ownerId,
        session,
        view,
        resolve: (outcome) => {
          clearTimeout(timer);
          run.signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        }
      });
      session.send({ type: SECRET_EVENTS.REQUEST, request: view });
      this.options.log?.("secrets.prompt_requested", { id: view.id, name: view.name, runId: view.runId });
    });
  }

  close(): void {
    this.stopListening();
    for (const id of [...this.pending.keys()]) this.settle(id, { status: "unavailable", reason: "the gateway is shutting down" });
    this.sessions.clear();
  }

  private async handle(session: SessionEntry, message: SecretsClientMessage): Promise<void> {
    const { vault } = this.options;
    switch (message.type) {
      case SECRET_EVENTS.PROVIDE:
        await this.provide(session, message.id, message.value, message.allowedHosts);
        return;
      case SECRET_EVENTS.CANCEL: {
        const prompt = this.pending.get(message.id);
        if (prompt && prompt.ownerId === session.ownerId) this.settle(message.id, { status: "cancelled" });
        return;
      }
      case SECRET_EVENTS.LIST:
        session.send({ type: SECRET_EVENTS.STATE, secrets: await vault.list(session.ownerId) });
        return;
      case SECRET_EVENTS.UPDATE:
        try {
          await vault.set(session.ownerId, {
            name: message.name,
            ...(message.value === undefined ? {} : { value: message.value }),
            ...(message.service === undefined ? {} : { service: message.service }),
            ...(message.description === undefined ? {} : { description: message.description }),
            ...(message.allowedHosts === undefined ? {} : { allowedHosts: message.allowedHosts })
          }, auditActor(session.principal?.()));
          // The vault's change listener pushes secrets.state to every open app.
        } catch (error) {
          session.send({ type: SECRET_EVENTS.STATE, secrets: await vault.list(session.ownerId), error: safeMessage(error) });
        }
        return;
      case SECRET_EVENTS.DELETE:
        if (!(await vault.delete(session.ownerId, message.name, auditActor(session.principal?.())))) {
          session.send({ type: SECRET_EVENTS.STATE, secrets: await vault.list(session.ownerId), error: `There is no secret named ${message.name}` });
        }
        return;
    }
  }

  private async provide(session: SessionEntry, id: string, value: string, hosts: string[] | undefined): Promise<void> {
    const prompt = this.pending.get(id);
    if (!prompt || prompt.ownerId !== session.ownerId) {
      session.send({ type: SECRET_EVENTS.RESOLVED, id, name: "", status: "expired", message: "This request is no longer open." });
      return;
    }
    const { view } = prompt;
    const parsed = normalizeHostList(hosts ?? view.allowedHosts);
    if ("error" in parsed) {
      session.send({ type: SECRET_EVENTS.RESOLVED, id, name: view.name, status: "invalid", message: parsed.error });
      return;
    }
    try {
      await this.options.vault.set(prompt.ownerId, {
        name: view.name,
        value,
        service: view.service,
        description: view.description,
        allowedHosts: parsed.hosts
      }, auditActor(session.principal?.()));
    } catch (error) {
      session.send({ type: SECRET_EVENTS.RESOLVED, id, name: view.name, status: "invalid", message: safeMessage(error) });
      return;
    }
    this.settle(id, { status: "saved", allowedHosts: parsed.hosts });
  }

  private settle(id: string, outcome: SecretPromptOutcome): void {
    const prompt = this.pending.get(id);
    if (!prompt) return;
    this.pending.delete(id);
    prompt.resolve(outcome);
    const status = outcome.status === "unavailable" ? "expired" : outcome.status;
    for (const session of this.sessions) {
      if (session.ownerId !== prompt.ownerId) continue;
      session.send({
        type: SECRET_EVENTS.RESOLVED,
        id,
        name: prompt.view.name,
        status,
        ...(outcome.status === "saved" ? { allowedHosts: outcome.allowedHosts } : {})
      });
    }
    this.options.log?.("secrets.prompt_resolved", { id, name: prompt.view.name, status: outcome.status });
  }

  /** The app showing this conversation, else the most recently connected one. */
  private pickSession(ownerId: string, conversationId: string | undefined): SessionEntry | undefined {
    const candidates = [...this.sessions].filter((session) => session.ownerId === ownerId);
    const match = conversationId ? candidates.filter((session) => session.conversationId() === conversationId) : [];
    const pool = match.length > 0 ? match : candidates;
    return pool.sort((a, b) => b.connectedAt - a.connectedAt)[0];
  }

  private async broadcastState(ownerId: string): Promise<void> {
    const secrets = await this.options.vault.list(ownerId);
    for (const session of this.sessions) {
      if (session.ownerId === ownerId) session.send({ type: SECRET_EVENTS.STATE, secrets });
    }
  }
}

/** Vault errors are written for users; anything else gets a generic text (never a value). */
function safeMessage(error: unknown): string {
  return error instanceof SecretError ? error.message : "The secret could not be saved.";
}
