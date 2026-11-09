/**
 * ConnectorService: connections, OAuth, credentials and the brain tools.
 *
 * - Every action of every available connector is one tool in the registry
 *   (`google_gmail_search`, …). A tool is offered to a person only when a
 *   connection they may use exists (`isAvailable`), and runs with exactly
 *   that connection: their personal one first, else the workspace's shared
 *   one. Calls need `integrations.use`.
 * - Connections are personal (`integrations.connect_personal`; only their
 *   owner sees and uses them) or shared with one workspace
 *   (`integrations.connect_shared`).
 * - OAuth 2.0 authorization code + PKCE with the organization's own app
 *   (client ID/secret in the secrets vault, or SIBYL_<ID>_CLIENT_ID/SECRET).
 * - Access tokens refresh automatically (single flight, exponential backoff
 *   on transient failures); a revoked or expired grant turns the connection
 *   to "reconnect".
 * - Calls are logged (connector, action, status, duration) — never inputs,
 *   outputs or credentials. Nothing here calls a model.
 */
import { randomUUID } from "node:crypto";
import {
  AUDIT_ACTIONS,
  DEFAULT_WORKSPACE_ID,
  PERMISSIONS,
  auditActor,
  authorize,
  type AuditEvent,
  type Principal,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
  type Store
} from "@open-gpt-live/core";
import type {
  IntegrationConnectionView,
  IntegrationConnectorView,
  IntegrationsState
} from "@open-gpt-live/protocol";
import type { SecretVault } from "../secrets/vault.js";
import { ENTERPRISE_CONNECTORS, listConnectors, onConnectorsChanged } from "./catalog.js";
import { ConnectorHttpError, buildUrl, createConnectorHttp, hostMatches, type FetchLike } from "./http-client.js";
import { PendingStates, bindingMatches, createPkcePair, fillTemplate, isTokenResponse, type PendingAuthorization, type TokenResponse } from "./oauth.js";
import { ConnectionStore, type AppConfig } from "./store.js";
import { tenantPath } from "../tenancy/mode.js";
import { toModelText, trimValue } from "./trim.js";
import {
  ConnectorError,
  type ApiKeyAuth,
  type ConnectionRecord,
  type ConnectionScope,
  type ConnectorAction,
  type ConnectorActionContext,
  type ConnectorDefinition,
  type OAuth2Auth,
  type StoredCredentials
} from "./types.js";

export const CALLBACK_PATH = "/api/connectors/oauth/callback";
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;
const MAX_REFRESH_BACKOFF_MS = 15 * 60_000;
/** After this many failed refreshes in a row, ask for a reconnect. */
const MAX_REFRESH_FAILURES = 6;
const LAST_USED_WRITE_MS = 60_000;
/** Granted scopes of the person's own user token are kept as "user:<scope>" (OAuth2Auth.userGrant). */
const USER_SCOPE_PREFIX = "user:";

/** Test overrides for vendor endpoints (fake servers). */
export interface EndpointOverride {
  authorizeUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  apiBases?: Record<string, string>;
}

export interface ConnectorServiceOptions {
  store: Store;
  ownerId: string;
  /** Master key of the secrets vault (credentials are encrypted with it). */
  key: Buffer;
  /** Client ID/secret live here. Without it only SIBYL_<ID>_CLIENT_* env values work. */
  vault?: SecretVault;
  tools?: ToolRegistry;
  /** Open-source connectors (Google, Microsoft). Enterprise ones come from the catalogue. */
  builtins: ConnectorDefinition[];
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Audit trail (connects, changes, disconnects, app setup). */
  audit?: (event: AuditEvent) => void;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  createId?: () => string;
  endpoints?: Record<string, EndpointOverride>;
}

/** Who is acting, for connect/disconnect (the HTTP layer fills this in). */
export interface Actor {
  principal: Principal;
  /** Opaque value tying an OAuth flow to the browser session (hashed). */
  binding: string;
  name?: string;
}

export class ConnectorService {
  readonly store: ConnectionStore;
  private readonly pending: PendingStates;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private readonly createId: () => string;
  private readonly registered = new Map<string, string[]>();
  private readonly listeners = new Set<() => void>();
  private readonly refreshing = new Map<string, Promise<boolean>>();
  private readonly unsubscribeCatalog: () => void;
  private readonly lastUsedWrites = new Map<string, number>();
  private readonly appCache = new Map<string, { configured: boolean; clientId?: string; secrets?: string[] }>();

  constructor(private readonly options: ConnectorServiceOptions) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.createId = options.createId ?? randomUUID;
    this.pending = new PendingStates(this.now);
    this.store = new ConnectionStore({ store: options.store, ownerId: options.ownerId, key: options.key, log: options.log });
    this.unsubscribeCatalog = onConnectorsChanged(() => {
      this.syncTools();
      this.emit();
    });
  }

  async init(): Promise<this> {
    await this.store.load();
    this.syncTools();
    return this;
  }

  close(): void {
    this.unsubscribeCatalog();
    for (const names of this.registered.values()) for (const name of names) this.options.tools?.unregister(name);
    this.registered.clear();
    this.store.close();
    this.listeners.clear();
  }

  /** Called after any change to connections or connectors (WS push). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  definitions(): ConnectorDefinition[] {
    const out = new Map(this.options.builtins.map((def) => [def.id, def]));
    for (const def of listConnectors()) if (!out.has(def.id)) out.set(def.id, def);
    return [...out.values()];
  }

  definition(id: string): ConnectorDefinition | undefined {
    return this.definitions().find((def) => def.id === id);
  }

  /* ───────────── tools ───────────── */

  /** Register tools for every available connector; drop tools of removed ones. */
  private syncTools(): void {
    const tools = this.options.tools;
    if (!tools) return;
    const current = new Map(this.definitions().map((def) => [def.id, def]));
    for (const [id, names] of this.registered) {
      if (current.has(id)) continue;
      for (const name of names) tools.unregister(name);
      this.registered.delete(id);
    }
    for (const def of current.values()) {
      if (this.registered.has(def.id)) continue;
      const names: string[] = [];
      for (const action of def.actions) {
        const tool = this.toolFor(def, action);
        if (tools.get(tool.name)) {
          this.options.log("connectors.tool_name_taken", { tool: tool.name });
          continue;
        }
        tools.register(tool);
        names.push(tool.name);
      }
      this.registered.set(def.id, names);
      this.options.log("connectors.tools_registered", { connector: def.id, tools: names.length });
    }
  }

  toolFor(def: ConnectorDefinition, action: ConnectorAction): ToolDefinition {
    const groupTitle = def.groups.find((group) => group.id === action.group)?.title ?? action.group;
    return {
      name: `${def.id}_${action.name}`,
      title: action.title,
      description: `${def.name} · ${groupTitle}: ${action.description}`,
      inputSchema: action.inputSchema,
      effect: action.effect,
      ...(action.risk ? { risk: action.risk } : {}),
      source: "connector",
      provider: def.id,
      isAvailable: ({ principal, workspaceId }) => Boolean(this.usableConnection(def, action.group, principal, workspaceId)),
      run: (input, context) => this.runAction(def, action, input as Record<string, unknown>, context)
    };
  }

  private async runAction(def: ConnectorDefinition, action: ConnectorAction, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const startedAt = this.now();
    const workspaceId = context.workspaceId ?? DEFAULT_WORKSPACE_ID;
    if (context.principal && !authorize(context.principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId })) {
      return { content: `You don't have permission to use integrations in this workspace.`, isError: true };
    }
    const record = this.usableConnection(def, action.group, context.principal, workspaceId);
    if (!record) {
      return {
        content: `No ${def.name} connection with "${def.groups.find((g) => g.id === action.group)?.title ?? action.group}" enabled is available here. Ask the user to connect ${def.name} (or enable that action group) in Integrations.`,
        isError: true
      };
    }
    const tool = `${def.id}_${action.name}`;
    try {
      const actionContext = this.actionContext(def, record, context.signal, context.log);
      const result = await action.run(input ?? {}, actionContext);
      this.noteUsed(record);
      this.options.log("connectors.call", { connector: def.id, tool, connectionId: record.id, scope: record.scope, status: "ok", durationMs: this.now() - startedAt });
      if (typeof result === "string") return { content: toModelText(result) };
      const text = toModelText(result.data);
      return { content: result.summary ? `${result.summary}\n${text}` : text, data: trimValue(result.data) };
    } catch (error) {
      const message = this.describeFailure(def, record, error, context.signal);
      this.options.log("connectors.call", {
        connector: def.id,
        tool,
        connectionId: record.id,
        status: "error",
        httpStatus: error instanceof ConnectorHttpError ? error.status : undefined,
        durationMs: this.now() - startedAt
      });
      return { content: message, isError: true };
    }
  }

  private describeFailure(def: ConnectorDefinition, record: ConnectionRecord, error: unknown, signal: AbortSignal): string {
    if (signal.aborted) return "The request was cancelled.";
    if (error instanceof ConnectorHttpError) {
      const detail = error.detail ? ` (${error.detail})` : "";
      if (error.status === 401) {
        void this.setStatus(record.id, "reconnect", `${def.vendor} rejected the sign-in. Reconnect ${def.name}.`);
        return `${def.vendor} rejected the connection's sign-in${detail}. The user needs to reconnect ${def.name} in Integrations.`;
      }
      if (error.status === 403) return `${def.vendor} refused this action${detail}. The connected account may lack access, or the action group needs to be re-approved (reconnect).`;
      if (error.status === 404) return `${def.vendor} could not find that item${detail}. Check the id.`;
      if (error.status === 429) return `${def.vendor} is rate-limiting requests right now${detail}. Try again in a little while.`;
      if (error.status === 0) return `${def.vendor}: ${error.message}`;
      return `${def.vendor} answered HTTP ${error.status}${detail}.`;
    }
    if (error instanceof ConnectorError) return error.message;
    return `${def.name} failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  /** The connection a tool would use for this person (personal first, then shared). */
  usableConnection(def: ConnectorDefinition, group: string, principal: Principal | undefined, workspaceId: string | undefined): ConnectionRecord | undefined {
    const ws = workspaceId || DEFAULT_WORKSPACE_ID;
    if (principal && !authorize(principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: ws })) return undefined;
    if (!this.groupAllowed(def, group)) return undefined;
    const key = principal ? ownerKeyOf(principal) : undefined;
    const records = this.store.list().filter((record) => record.connectorId === def.id && !record.id.startsWith("probe-") && record.status !== "reconnect" && record.groups.includes(group));
    // Per-resource grants (Enterprise): a policy may limit who can use a given shared connection.
    const granted = (record: ConnectionRecord) =>
      record.scope === "personal" || !principal || authorize(principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: ws, resource: { kind: "connection", id: record.id } });
    const usable = (record: ConnectionRecord) => this.groupConsented(def, record, group) && granted(record);
    return (
      (key ? records.find((record) => record.scope === "personal" && record.ownerKey === key && usable(record)) : undefined) ??
      records.find((record) => record.scope === "workspace" && record.workspaceId === ws && usable(record))
    );
  }

  private groupAllowed(def: ConnectorDefinition, group: string): boolean {
    const allowed = this.store.app(def.id).allowedGroups;
    return !allowed || allowed.includes(group);
  }

  /** Were the group's scopes granted (when the vendor tells us)? */
  private groupConsented(def: ConnectorDefinition, record: ConnectionRecord, group: string): boolean {
    if (record.authKind !== "oauth2" || record.grantedScopes.length === 0) return true;
    const definition = def.groups.find((g) => g.id === group);
    const scopes = definition?.scopes ?? [];
    const granted = new Set(record.grantedScopes.map((scope) => scope.toLowerCase()));
    return (
      scopes.every((scope) => granted.has(scope.toLowerCase()) || granted.has(shortScope(scope).toLowerCase())) &&
      (definition?.userScopes ?? []).every((scope) => granted.has(`${USER_SCOPE_PREFIX}${scope}`.toLowerCase()))
    );
  }

  private noteUsed(record: ConnectionRecord): void {
    const at = this.now();
    const current = this.store.get(record.id);
    if (!current) return;
    current.lastUsedAt = at;
    const last = this.lastUsedWrites.get(record.id) ?? 0;
    if (at - last < LAST_USED_WRITE_MS) return;
    this.lastUsedWrites.set(record.id, at);
    void this.store.touch({ ...current }).catch(() => undefined);
    this.emit();
  }

  /* ───────────── HTTP for actions ───────────── */

  private actionContext(def: ConnectorDefinition, record: ConnectionRecord, signal: AbortSignal, log?: ToolContext["log"]): ConnectorActionContext {
    const bases = this.apiBases(def, record);
    const http = createConnectorHttp({
      fetch: this.fetchImpl,
      signal,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      hostAllowed: (host) => hostMatches(this.apiHostPatterns(def, record), host),
      authHeaders: (as) => this.authHeaders(def, record.id, as),
      onUnauthorized: () => (record.authKind === "oauth2" ? this.refresh(def, record.id, true) : Promise.resolve(false)),
      log: this.options.log
    });
    return {
      http,
      connection: {
        id: record.id,
        connectorId: record.connectorId,
        scope: record.scope,
        ...(record.account ? { account: record.account } : {}),
        metadata: { ...record.metadata }
      },
      base: (name) => {
        const base = bases[name];
        if (!base) throw new ConnectorError("unknown_base", `${def.id}: no API base "${name}"`);
        return base;
      },
      signal,
      log: log ?? this.options.log
    };
  }

  private apiBases(def: ConnectorDefinition, record?: ConnectionRecord): Record<string, string> {
    const overrides = this.options.endpoints?.[def.id]?.apiBases ?? {};
    const values = { ...this.appSettings(def), ...(record?.metadata ?? {}) };
    const out: Record<string, string> = {};
    for (const [name, template] of Object.entries(def.apiBases)) out[name] = (overrides[name] ?? fillTemplate(template, values)).replace(/\/+$/, "");
    return out;
  }

  /** Hosts credentials may go to: the connector's own plus test overrides. */
  private apiHostPatterns(def: ConnectorDefinition, record?: ConnectionRecord): string[] {
    const extra = Object.values(this.options.endpoints?.[def.id]?.apiBases ?? {}).map(hostOf).filter((h): h is string => Boolean(h));
    const fromMetadata = Object.values(record?.metadata ?? {})
      .filter((value) => /^https:\/\//.test(value))
      .map(hostOf)
      .filter((host): host is string => Boolean(host && hostMatches(def.apiHosts, host)));
    return [...def.apiHosts, ...extra, ...fromMetadata];
  }

  private async authHeaders(def: ConnectorDefinition, connectionId: string, as?: "user"): Promise<Record<string, string>> {
    const record = this.store.get(connectionId);
    const credentials = this.store.credentialsOf(connectionId);
    if (!record || !credentials) throw new ConnectorError("not_connected", `${def.name} is not connected any more. Reconnect it in Integrations.`);
    if (as === "user") {
      // The person's own token (e.g. Slack search); it is not refreshed here: a reconnect renews it.
      if (!credentials.userAccessToken) throw new ConnectorError("reconnect", `This ${def.name} action acts as the person who connected it. Reconnect ${def.name} with that action group switched on.`);
      return { authorization: `Bearer ${credentials.userAccessToken}` };
    }
    if (record.authKind === "apiKey") {
      const auth = def.auth.kind === "apiKey" ? def.auth : def.alternateAuth;
      if (!auth || !credentials.apiKey) throw new ConnectorError("not_connected", `${def.name} has no stored key. Reconnect it.`);
      return auth.headers(credentials.apiKey);
    }
    if (credentials.expiresAt !== undefined && credentials.expiresAt - REFRESH_EARLY_MS <= this.now()) {
      if (!(await this.refresh(def, connectionId, false))) {
        throw new ConnectorError("reconnect", `The ${def.vendor} sign-in expired or was revoked. The user needs to reconnect ${def.name} in Integrations.`);
      }
    }
    const token = this.store.credentialsOf(connectionId)?.accessToken;
    if (!token) throw new ConnectorError("not_connected", `${def.name} needs to be reconnected.`);
    return { authorization: `Bearer ${token}` };
  }

  /**
   * Refresh the access token (one at a time per connection). Resolves true
   * when a new token is in place. `force`: after a 401, even if not expired.
   */
  refresh(def: ConnectorDefinition, connectionId: string, force: boolean): Promise<boolean> {
    const running = this.refreshing.get(connectionId);
    if (running) return running;
    const task = this.refreshNow(def, connectionId, force).finally(() => this.refreshing.delete(connectionId));
    this.refreshing.set(connectionId, task);
    return task;
  }

  private async refreshNow(def: ConnectorDefinition, connectionId: string, force: boolean): Promise<boolean> {
    const record = this.store.get(connectionId);
    const credentials = this.store.credentialsOf(connectionId);
    if (!record || !credentials || def.auth.kind !== "oauth2") return false;
    if (!force && credentials.expiresAt !== undefined && credentials.expiresAt - REFRESH_EARLY_MS > this.now()) return true;
    if (!credentials.refreshToken) {
      await this.setStatus(connectionId, "reconnect", `The ${def.vendor} sign-in expired. Reconnect ${def.name}.`);
      return false;
    }
    if (record.retryAfter && record.retryAfter > this.now()) {
      const seconds = Math.ceil((record.retryAfter - this.now()) / 1000);
      throw new ConnectorError("refresh_backoff", `${def.vendor} sign-in refresh is failing; trying again in ${seconds}s.`);
    }
    const client = await this.clientCredentials(def);
    if (!client) {
      await this.setStatus(connectionId, "error", `The ${def.vendor} app credentials are missing. An admin needs to set them up again.`);
      return false;
    }
    try {
      const token = await this.tokenRequest(def, {
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret
      });
      const next: StoredCredentials = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        ...(typeof token.expires_in === "number" ? { expiresAt: this.now() + token.expires_in * 1000 } : {}),
        ...(credentials.userAccessToken ? { userAccessToken: credentials.userAccessToken } : {})
      };
      const current = this.store.get(connectionId) ?? record;
      const updated: ConnectionRecord = { ...current, status: "connected", updatedAt: this.now() };
      delete updated.statusMessage;
      delete updated.refreshFailures;
      delete updated.retryAfter;
      // The app token's scopes change with a refresh; the user token's grant stays.
      if (typeof token.scope === "string" && token.scope.trim()) {
        updated.grantedScopes = [...splitScopes(token.scope), ...current.grantedScopes.filter((scope) => scope.startsWith(USER_SCOPE_PREFIX))];
      }
      await this.store.put(updated, next);
      if (current.status !== "connected") this.emit();
      this.options.log("connectors.refreshed", { connector: def.id, connectionId });
      return true;
    } catch (error) {
      const permanent = error instanceof ConnectorHttpError && (error.status === 400 || error.status === 401);
      const current = this.store.get(connectionId) ?? record;
      const failures = (current.refreshFailures ?? 0) + 1;
      if (permanent || failures >= MAX_REFRESH_FAILURES) {
        await this.setStatus(connectionId, "reconnect", `The ${def.vendor} sign-in expired or was revoked. Reconnect ${def.name}.`);
        this.options.log("connectors.refresh_failed", { connector: def.id, connectionId, permanent: true, status: error instanceof ConnectorHttpError ? error.status : undefined });
        return false;
      }
      const wait = Math.min(MAX_REFRESH_BACKOFF_MS, 5_000 * 2 ** (failures - 1));
      await this.store.touch({ ...current, status: "error", statusMessage: `Couldn't refresh the ${def.vendor} sign-in; retrying.`, refreshFailures: failures, retryAfter: this.now() + wait, updatedAt: this.now() });
      this.emit();
      this.options.log("connectors.refresh_failed", { connector: def.id, connectionId, permanent: false, failures, retryInMs: wait });
      throw new ConnectorError("refresh_failed", `Couldn't refresh the ${def.vendor} sign-in right now. Try again shortly.`);
    }
  }

  private async tokenRequest(def: ConnectorDefinition, form: Record<string, string>): Promise<TokenResponse> {
    const tokenUrl = this.authUrl(def, "tokenUrl");
    const http = createConnectorHttp({
      fetch: this.fetchImpl,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      hostAllowed: (host) => host === new URL(tokenUrl).host || host === new URL(tokenUrl).hostname,
      authHeaders: async () => ({}),
      log: this.options.log
    });
    const token = await http.request<unknown>({ method: "POST", url: tokenUrl, form, headers: { accept: "application/json" } });
    // Some vendors (Slack) answer 200 with { ok: false, error } — the same as a 400 here.
    const failed = token.data as { ok?: unknown; error?: unknown } | undefined;
    if (failed && failed.ok === false) throw new ConnectorHttpError(400, "HTTP 400", typeof failed.error === "string" ? failed.error.slice(0, 120) : undefined);
    if (!isTokenResponse(token.data)) throw new ConnectorError("bad_token", `${def.vendor} returned an unexpected token response.`);
    return token.data;
  }

  private authUrl(def: ConnectorDefinition, which: "authorizeUrl" | "tokenUrl" | "revokeUrl"): string {
    const override = this.options.endpoints?.[def.id]?.[which];
    if (override) return override;
    if (def.auth.kind !== "oauth2") throw new ConnectorError("not_oauth", `${def.name} does not use OAuth`);
    const template = def.auth[which];
    if (!template) return "";
    return fillTemplate(template, this.appSettings(def));
  }

  private appSettings(def: ConnectorDefinition): Record<string, string> {
    const stored = this.store.app(def.id).settings ?? {};
    const out: Record<string, string> = {};
    for (const field of def.appSettings ?? []) {
      const value = stored[field.name] ?? this.options.env[`SIBYL_${def.id.toUpperCase()}_${field.name.toUpperCase()}`]?.trim() ?? field.default;
      out[field.name] = field.pattern.test(value) ? value : field.default;
    }
    return out;
  }

  private async setStatus(connectionId: string, status: ConnectionRecord["status"], message?: string): Promise<void> {
    const record = this.store.get(connectionId);
    if (!record) return;
    if (record.status === status && record.statusMessage === message) return;
    const next: ConnectionRecord = { ...record, status, updatedAt: this.now() };
    if (message) next.statusMessage = message;
    else delete next.statusMessage;
    await this.store.touch(next);
    this.options.log("connectors.status", { connector: record.connectorId, connectionId, status });
    this.emit();
  }

  /* ───────────── app credentials ───────────── */

  private secretNames(def: ConnectorDefinition): { id: string; secret: string } {
    const prefix = def.id.toUpperCase();
    return { id: `${prefix}_OAUTH_CLIENT_ID`, secret: `${prefix}_OAUTH_CLIENT_SECRET` };
  }

  /** Hosts the client secret may be sent to (token and revoke endpoints). */
  private credentialHosts(def: ConnectorDefinition): string[] {
    const hosts = new Set<string>();
    for (const which of ["tokenUrl", "revokeUrl"] as const) {
      const url = this.authUrl(def, which);
      const host = url ? hostnameOf(url) : undefined;
      if (host) hosts.add(host);
    }
    return [...hosts];
  }

  async clientCredentials(def: ConnectorDefinition): Promise<{ clientId: string; clientSecret: string; source: "vault" | "env" } | undefined> {
    const names = this.secretNames(def);
    const vault = this.options.vault;
    if (vault && (await vault.has(this.options.ownerId, names.id)) && (await vault.has(this.options.ownerId, names.secret))) {
      const host = this.credentialHosts(def)[0];
      try {
        const clientId = await vault.resolve(this.options.ownerId, names.id, { host });
        const clientSecret = await vault.resolve(this.options.ownerId, names.secret, { host });
        return { clientId, clientSecret, source: "vault" };
      } catch (error) {
        this.options.log("connectors.app_credentials_unusable", { connector: def.id, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    }
    const env = this.options.env;
    const clientId = env[`SIBYL_${def.id.toUpperCase()}_CLIENT_ID`]?.trim();
    const clientSecret = env[`SIBYL_${def.id.toUpperCase()}_CLIENT_SECRET`]?.trim();
    return clientId && clientSecret ? { clientId, clientSecret, source: "env" } : undefined;
  }

  /** Save the organization's app (client ID/secret, settings, allowed groups). Needs org.settings. */
  async setApp(
    principal: Principal,
    connectorId: string,
    input: { clientId?: unknown; clientSecret?: unknown; settings?: unknown; allowedGroups?: unknown; secrets?: unknown }
  ): Promise<void> {
    if (!authorize(principal, PERMISSIONS.ORG_SETTINGS)) throw new ConnectorError("forbidden", "Only organization owners and admins can set up integration apps.", 403);
    const def = this.requireDefinition(connectorId);
    // Validate the extra app secrets before anything is saved.
    const secrets: Array<{ name: string; label: string; value: string }> = [];
    if (input.secrets !== undefined) {
      if (!isRecord(input.secrets)) throw new ConnectorError("bad_request", "secrets must be an object");
      for (const [name, value] of Object.entries(input.secrets)) {
        const field = def.appSecrets?.find((candidate) => candidate.name === name);
        if (!field) throw new ConnectorError("bad_request", `Unknown app secret "${name.slice(0, 40)}"`);
        if (typeof value !== "string" || !value.trim() || value.length > 2048 || /\s/.test(value.trim())) throw new ConnectorError("bad_request", `${field.label} is not valid`);
        secrets.push({ name, label: field.label, value: value.trim() });
      }
      if (secrets.length && !this.options.vault) throw new ConnectorError("unavailable", "The secrets vault is not available (check SIBYL_SECRET_KEY), so app secrets can't be stored.", 409);
    }
    for (const secret of secrets) {
      await this.options.vault!.set(this.options.ownerId, {
        name: this.appSecretName(def, secret.name),
        value: secret.value,
        service: `${def.vendor} app`,
        description: `${secret.label} of the ${def.name} integration (Integrations).`,
        // Used on this gateway only (checking the vendor's signatures); never sent anywhere.
        allowedHosts: ["local"]
      });
    }
    const current = this.store.app(def.id);
    const next: AppConfig = { ...current, updatedAt: this.now() };
    if (input.settings !== undefined) {
      if (!isRecord(input.settings)) throw new ConnectorError("bad_request", "settings must be an object");
      const settings: Record<string, string> = { ...(current.settings ?? {}) };
      for (const field of def.appSettings ?? []) {
        const value = input.settings[field.name];
        if (value === undefined) continue;
        if (typeof value !== "string" || !field.pattern.test(value.trim())) throw new ConnectorError("bad_request", `${field.label} is not valid`);
        settings[field.name] = value.trim();
      }
      next.settings = settings;
    }
    if (input.allowedGroups !== undefined) {
      if (input.allowedGroups === null) delete next.allowedGroups;
      else {
        const groups = this.validGroups(def, input.allowedGroups, false);
        next.allowedGroups = groups;
      }
    }
    await this.store.setApp(def.id, next);
    const wantsCredentials = input.clientId !== undefined || input.clientSecret !== undefined;
    if (wantsCredentials || input.settings !== undefined) {
      if (def.auth.kind !== "oauth2") {
        if (wantsCredentials) throw new ConnectorError("bad_request", `${def.name} doesn't use OAuth app credentials`);
      } else {
        await this.saveClientCredentials(def, input.clientId, input.clientSecret);
      }
    }
    this.options.log("connectors.app_saved", { connector: def.id, credentials: wantsCredentials });
    this.options.audit?.({
      action: AUDIT_ACTIONS.CONNECTOR_APP_CHANGED,
      actor: auditActor(principal),
      target: { kind: "connector_app", id: def.id, name: def.name },
      details: { credentials: wantsCredentials, allowedGroups: next.allowedGroups ?? null }
    });
    this.emit();
  }

  private async saveClientCredentials(def: ConnectorDefinition, clientId: unknown, clientSecret: unknown): Promise<void> {
    const vault = this.options.vault;
    const names = this.secretNames(def);
    const hosts = this.credentialHosts(def);
    const text = (value: unknown, label: string) => {
      if (typeof value !== "string" || !value.trim() || value.length > 2048 || /\s/.test(value.trim())) throw new ConnectorError("bad_request", `${label} is not valid`);
      return value.trim();
    };
    if (clientId === undefined && clientSecret === undefined) {
      // Settings changed: keep the secrets but move their allowed hosts along (e.g. a new login host).
      if (!vault) return;
      for (const name of [names.id, names.secret]) {
        if (await vault.has(this.options.ownerId, name)) await vault.set(this.options.ownerId, { name, allowedHosts: hosts });
      }
      return;
    }
    if (!vault) throw new ConnectorError("unavailable", "The secrets vault is not available (check SIBYL_SECRET_KEY), so app credentials can't be stored.", 409);
    const exists = await vault.has(this.options.ownerId, names.secret);
    if (clientId !== undefined) {
      await vault.set(this.options.ownerId, {
        name: names.id,
        value: text(clientId, "Client ID"),
        service: `${def.vendor} OAuth app`,
        description: `Client ID of the ${def.name} integration (Integrations).`,
        allowedHosts: hosts
      });
    }
    if (clientSecret !== undefined) {
      await vault.set(this.options.ownerId, {
        name: names.secret,
        value: text(clientSecret, "Client secret"),
        service: `${def.vendor} OAuth app`,
        description: `Client secret of the ${def.name} integration (Integrations).`,
        allowedHosts: hosts
      });
    } else if (!exists) {
      throw new ConnectorError("bad_request", "Client secret is required");
    }
  }

  async removeApp(principal: Principal, connectorId: string): Promise<void> {
    if (!authorize(principal, PERMISSIONS.ORG_SETTINGS)) throw new ConnectorError("forbidden", "Only organization owners and admins can set up integration apps.", 403);
    const def = this.requireDefinition(connectorId);
    const names = this.secretNames(def);
    if (this.options.vault) {
      await this.options.vault.delete(this.options.ownerId, names.id);
      await this.options.vault.delete(this.options.ownerId, names.secret);
      for (const field of def.appSecrets ?? []) await this.options.vault.delete(this.options.ownerId, this.appSecretName(def, field.name));
    }
    this.options.log("connectors.app_removed", { connector: def.id });
    this.options.audit?.({ action: AUDIT_ACTIONS.CONNECTOR_APP_CHANGED, actor: auditActor(principal), target: { kind: "connector_app", id: def.id, name: def.name }, details: { removed: true } });
    this.emit();
  }

  private appSecretName(def: ConnectorDefinition, name: string): string {
    return `${def.id.toUpperCase()}_${name}`;
  }

  /**
   * An app secret (e.g. Slack's signing secret) for use on this gateway:
   * from the vault, else SIBYL_<CONNECTOR>_<NAME>. Never logged or sent out.
   */
  async appSecret(connectorId: string, name: string): Promise<string | undefined> {
    const def = this.definition(connectorId);
    if (!def?.appSecrets?.some((field) => field.name === name)) return undefined;
    const vault = this.options.vault;
    const stored = this.appSecretName(def, name);
    if (vault && (await vault.has(this.options.ownerId, stored))) {
      try {
        return await vault.resolve(this.options.ownerId, stored, { host: undefined });
      } catch (error) {
        this.options.log("connectors.app_secret_unusable", { connector: def.id, name, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    }
    return this.options.env[`SIBYL_${stored}`]?.trim() || undefined;
  }

  /** This organization started the OAuth flow with this state (hosted: the callback is routed by it). */
  ownsOAuthState(state: string): boolean {
    return this.pending.has(state);
  }

  /* ───────────── acting with one connection (agents in channels, notifications) ───────────── */

  /** Connections of a connector (no probes), for modules that act through one chosen connection. */
  connectionsOf(connectorId: string): ConnectionRecord[] {
    return this.store.list().filter((record) => record.connectorId === connectorId && !record.id.startsWith("probe-"));
  }

  /**
   * The action context of one connection: the same HTTP client (credentials,
   * refresh, retries, host checks) the connector's tools use. Throws when the
   * connection is gone or needs a reconnect.
   */
  contextFor(connectionId: string, signal: AbortSignal): ConnectorActionContext {
    const record = this.store.get(connectionId);
    const def = record ? this.definition(record.connectorId) : undefined;
    if (!record || !def) throw new ConnectorError("not_connected", "That connection no longer exists. Connect it again in Integrations.", 404);
    if (record.status === "reconnect") throw new ConnectorError("reconnect", `${def.name} needs to be reconnected in Integrations.`, 409);
    return this.actionContext(def, record, signal);
  }

  /** Run one action of a connector with a given connection (no tool, no approval: the caller decided). */
  async runActionAs(connectionId: string, actionName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ summary?: string; data: unknown }> {
    const context = this.contextFor(connectionId, signal);
    const def = this.definition(context.connection.connectorId)!;
    const action = def.actions.find((candidate) => candidate.name === actionName);
    if (!action) throw new ConnectorError("unknown_action", `${def.id}_${actionName} does not exist`);
    const startedAt = this.now();
    try {
      const result = await action.run(input, context);
      const used = this.store.get(connectionId);
      if (used) this.noteUsed(used);
      this.options.log("connectors.call", { connector: def.id, tool: `${def.id}_${action.name}`, connectionId, status: "ok", durationMs: this.now() - startedAt, direct: true });
      return typeof result === "string" ? { data: result } : result;
    } catch (error) {
      this.options.log("connectors.call", {
        connector: def.id,
        tool: `${def.id}_${action.name}`,
        connectionId,
        status: "error",
        httpStatus: error instanceof ConnectorHttpError ? error.status : undefined,
        durationMs: this.now() - startedAt,
        direct: true
      });
      const record = this.store.get(connectionId);
      throw new ConnectorError("action_failed", record ? this.describeFailure(def, record, error, signal) : String(error), 502);
    }
  }

  /* ───────────── connect ───────────── */

  /** Start an OAuth connection; returns the vendor URL to open. */
  async beginOAuth(
    actor: Actor,
    input: { connectorId: string; scope: unknown; groups?: unknown; workspaceId: string; connectionId?: string },
    redirectUri: string
  ): Promise<{ authorizeUrl: string }> {
    const def = this.requireDefinition(input.connectorId);
    if (def.auth.kind !== "oauth2") throw new ConnectorError("bad_request", `${def.name} connects with an API key`);
    const scope = this.checkConnectPermission(actor.principal, input.scope, input.workspaceId);
    let existing: ConnectionRecord | undefined;
    if (input.connectionId) {
      existing = this.store.get(input.connectionId);
      if (!existing || existing.connectorId !== def.id || !this.canManage(actor.principal, existing)) throw new ConnectorError("not_found", "Connection not found", 404);
    }
    const groups = input.groups === undefined ? (existing?.groups ?? this.defaultGroups(def)) : this.validGroups(def, input.groups, true);
    const client = await this.clientCredentials(def);
    if (!client) {
      throw new ConnectorError("not_configured", `${def.name} isn't set up yet: an organization admin needs to add the ${def.vendor} app's client ID and secret (Integrations → ${def.name} → Set up).`, 409);
    }
    const scopes = unique([...def.auth.baseScopes, ...groups.flatMap((id) => def.groups.find((g) => g.id === id)?.scopes ?? [])]);
    const pkce = def.auth.pkce ? createPkcePair() : undefined;
    const pending: Omit<PendingAuthorization, "createdAt"> = {
      connectorId: def.id,
      scope: existing?.scope ?? scope,
      workspaceId: existing?.workspaceId ?? input.workspaceId,
      ownerKey: ownerKeyOf(actor.principal),
      ...(actor.name ? { ownerName: actor.name } : {}),
      binding: actor.binding,
      ...(pkce ? { verifier: pkce.verifier } : {}),
      groups,
      scopes,
      redirectUri,
      ...(existing ? { connectionId: existing.id } : {})
    };
    const state = this.pending.create(pending);
    const userScopes = unique(groups.flatMap((id) => def.groups.find((g) => g.id === id)?.userScopes ?? []));
    const url = buildUrl(this.authUrl(def, "authorizeUrl"), {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(def.auth.scopeSeparator ?? " "),
      ...(def.auth.userScopeParam && userScopes.length ? { [def.auth.userScopeParam]: userScopes.join(def.auth.scopeSeparator ?? " ") } : {}),
      state,
      ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: "S256" } : {}),
      ...def.auth.authorizeParams
    });
    this.options.log("connectors.oauth_started", { connector: def.id, scope: pending.scope, groups });
    return { authorizeUrl: url.toString() };
  }

  /**
   * Finish the OAuth flow from the callback. `actor` is whoever the callback
   * request is signed in as (undefined: not signed in).
   */
  async completeOAuth(
    query: { state?: string | null; code?: string | null; error?: string | null },
    who: (pending: PendingAuthorization) => Promise<{ ok: boolean }>
  ): Promise<{ connection: ConnectionRecord; connector: ConnectorDefinition }> {
    const pending = query.state ? this.pending.take(query.state) : undefined;
    if (!pending) throw new ConnectorError("invalid_state", "This sign-in link has expired or was already used. Start connecting again from Integrations.", 400);
    if (!(await who(pending)).ok) {
      throw new ConnectorError("wrong_session", "This sign-in was started by someone else (or in another browser session). Start connecting again from Integrations.", 403);
    }
    const def = this.requireDefinition(pending.connectorId);
    if (def.auth.kind !== "oauth2") throw new ConnectorError("bad_request", "Not an OAuth connector");
    if (query.error) throw new ConnectorError("denied", query.error === "access_denied" ? `You declined access in ${def.vendor}. Nothing was connected.` : `${def.vendor} returned an error (${String(query.error).slice(0, 80)}).`, 400);
    if (!query.code || query.code.length > 4096) throw new ConnectorError("bad_request", "The sign-in response had no code.");
    const client = await this.clientCredentials(def);
    if (!client) throw new ConnectorError("not_configured", `${def.name} app credentials are missing.`, 409);
    let token: TokenResponse;
    try {
      token = await this.tokenRequest(def, {
        grant_type: "authorization_code",
        code: query.code,
        redirect_uri: pending.redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...(pending.verifier ? { code_verifier: pending.verifier } : {})
      });
    } catch (error) {
      const detail = error instanceof ConnectorHttpError && error.detail ? ` (${error.detail})` : "";
      throw new ConnectorError("token_exchange_failed", `${def.vendor} did not accept the sign-in${detail}. Check the app's client secret and redirect URI.`, 502);
    }
    const metadata = this.validMetadata(def, def.tokenMetadata?.(token) ?? {});
    const userGrant = def.auth.userGrant?.(token);
    const credentials: StoredCredentials = {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(typeof token.expires_in === "number" ? { expiresAt: this.now() + token.expires_in * 1000 } : {}),
      ...(userGrant?.accessToken ? { userAccessToken: userGrant.accessToken } : {})
    };
    const appScopes = typeof token.scope === "string" && token.scope.trim() ? splitScopes(token.scope) : pending.scopes;
    const record = await this.saveConnection(def, {
      scope: pending.scope,
      workspaceId: pending.workspaceId,
      ownerKey: pending.ownerKey,
      ...(pending.ownerName ? { ownerName: pending.ownerName } : {}),
      groups: pending.groups,
      grantedScopes: [...appScopes, ...(userGrant?.accessToken ? userGrant.scopes.map((scope) => `${USER_SCOPE_PREFIX}${scope}`) : [])],
      authKind: "oauth2",
      metadata,
      ...(pending.connectionId ? { connectionId: pending.connectionId } : {})
    }, credentials);
    return { connection: record, connector: def };
  }

  /** Connect with an API key (e.g. a HubSpot private app token). */
  async connectApiKey(
    actor: Actor,
    input: { connectorId: string; scope: unknown; groups?: unknown; workspaceId: string; credentials: unknown }
  ): Promise<ConnectionRecord> {
    const def = this.requireDefinition(input.connectorId);
    const auth: ApiKeyAuth | undefined = def.auth.kind === "apiKey" ? def.auth : def.alternateAuth;
    if (!auth) throw new ConnectorError("bad_request", `${def.name} connects with OAuth`);
    const scope = this.checkConnectPermission(actor.principal, input.scope, input.workspaceId);
    const groups = input.groups === undefined ? this.defaultGroups(def) : this.validGroups(def, input.groups, true);
    if (!isRecord(input.credentials)) throw new ConnectorError("bad_request", "credentials must be an object");
    const values: Record<string, string> = {};
    for (const field of auth.fields) {
      const value = input.credentials[field.name];
      if (typeof value !== "string" || !value.trim() || value.length > 4096 || /\s/.test(value.trim())) throw new ConnectorError("bad_request", `${field.label} is required`);
      values[field.name] = value.trim();
    }
    // Check the key before storing it.
    const probeId = `probe-${this.createId()}`;
    const probe: ConnectionRecord = this.newRecord(def, { scope, workspaceId: input.workspaceId, ownerKey: ownerKeyOf(actor.principal), groups, grantedScopes: [], authKind: "apiKey", metadata: {} }, probeId);
    await this.store.put(probe, { apiKey: values });
    let identity: { account?: string; accountName?: string } = {};
    try {
      if (def.identify) identity = await def.identify(this.actionContext(def, probe, AbortSignal.timeout(20_000)));
    } catch (error) {
      await this.store.remove(probeId);
      if (error instanceof ConnectorHttpError && (error.status === 401 || error.status === 403)) {
        throw new ConnectorError("rejected", `${def.vendor} rejected that key. Check it and its permissions.`, 400);
      }
      throw new ConnectorError("unreachable", `Couldn't check the key with ${def.vendor}: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    await this.store.remove(probeId);
    return this.saveConnection(def, {
      scope,
      workspaceId: input.workspaceId,
      ownerKey: ownerKeyOf(actor.principal),
      ...(actor.name ? { ownerName: actor.name } : {}),
      groups,
      grantedScopes: [],
      authKind: "apiKey",
      metadata: {},
      identity
    }, { apiKey: values });
  }

  private async saveConnection(
    def: ConnectorDefinition,
    input: {
      scope: ConnectionScope;
      workspaceId: string;
      ownerKey: string;
      ownerName?: string;
      groups: string[];
      grantedScopes: string[];
      authKind: "oauth2" | "apiKey";
      metadata: Record<string, string>;
      connectionId?: string;
      identity?: { account?: string; accountName?: string };
    },
    credentials: StoredCredentials
  ): Promise<ConnectionRecord> {
    // One personal connection per person and connector, one shared per workspace and connector.
    const existing =
      (input.connectionId ? this.store.get(input.connectionId) : undefined) ??
      this.store
        .list()
        .find((record) =>
          record.connectorId === def.id &&
          record.scope === input.scope &&
          (input.scope === "personal" ? record.ownerKey === input.ownerKey : record.workspaceId === input.workspaceId)
        );
    const base = existing ?? this.newRecord(def, input, this.createId());
    const record: ConnectionRecord = {
      ...base,
      groups: input.groups,
      grantedScopes: input.grantedScopes,
      authKind: input.authKind,
      metadata: input.metadata,
      status: "connected",
      updatedAt: this.now(),
      ...(input.scope === "workspace" && input.ownerName ? { createdByName: input.ownerName } : {})
    };
    delete record.statusMessage;
    delete record.refreshFailures;
    delete record.retryAfter;
    if (existing && existing.authKind === "oauth2" && input.authKind === "oauth2" && !credentials.refreshToken) {
      const previous = this.store.credentialsOf(existing.id)?.refreshToken;
      if (previous) credentials = { ...credentials, refreshToken: previous };
    }
    await this.store.put(record, credentials);
    // Who did we connect as (best effort; a failure doesn't undo the connection).
    let identity = input.identity;
    if (!identity && def.identify) {
      try {
        identity = await def.identify(this.actionContext(def, record, AbortSignal.timeout(20_000)));
      } catch (error) {
        this.options.log("connectors.identify_failed", { connector: def.id, connectionId: record.id, status: error instanceof ConnectorHttpError ? error.status : undefined });
      }
    }
    if (identity?.account || identity?.accountName) {
      const named: ConnectionRecord = { ...(this.store.get(record.id) ?? record), ...(identity.account ? { account: identity.account } : {}), ...(identity.accountName ? { accountName: identity.accountName } : {}) };
      await this.store.touch(named);
    }
    this.options.log("connectors.connected", { connector: def.id, connectionId: record.id, scope: record.scope, workspaceId: record.workspaceId, authKind: record.authKind, groups: record.groups });
    this.options.audit?.({
      action: AUDIT_ACTIONS.CONNECTOR_CONNECTED,
      actor: input.ownerKey.startsWith("user:") ? { kind: "user", userId: input.ownerKey.slice(5), ...(input.ownerName ? { name: input.ownerName } : {}) } : { kind: input.ownerKey === "token" ? "token" : "local" },
      workspaceId: record.workspaceId,
      target: { kind: "connection", id: record.id, name: def.name },
      details: { connector: def.id, scope: record.scope, authKind: record.authKind, groups: record.groups }
    });
    this.emit();
    return this.store.get(record.id) ?? record;
  }

  private newRecord(
    def: ConnectorDefinition,
    input: { scope: ConnectionScope; workspaceId: string; ownerKey: string; ownerName?: string; groups: string[]; grantedScopes: string[]; authKind: "oauth2" | "apiKey"; metadata: Record<string, string> },
    id: string
  ): ConnectionRecord {
    const at = this.now();
    return {
      id,
      connectorId: def.id,
      scope: input.scope,
      workspaceId: input.workspaceId,
      ownerKey: input.ownerKey,
      ...(input.ownerName ? { createdByName: input.ownerName } : {}),
      authKind: input.authKind,
      status: "connected",
      groups: input.groups,
      grantedScopes: input.grantedScopes,
      metadata: input.metadata,
      createdAt: at,
      updatedAt: at
    };
  }

  private validMetadata(def: ConnectorDefinition, metadata: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    const allowed = [...def.apiHosts, ...Object.values(this.options.endpoints?.[def.id]?.apiBases ?? {}).map(hostOf).filter((h): h is string => Boolean(h))];
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== "string" || value.length > 500) continue;
      if (/^https?:\/\//i.test(value)) {
        const host = hostOf(value);
        const overridden = Object.values(this.options.endpoints?.[def.id]?.apiBases ?? {}).some((base) => value.startsWith(base));
        if (!host || (!overridden && (!value.startsWith("https://") || !hostMatches(allowed, host)))) {
          throw new ConnectorError("bad_metadata", `${def.vendor} returned an unexpected address for ${key}.`, 502);
        }
        out[key] = value.replace(/\/+$/, "");
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  /* ───────────── manage ───────────── */

  async updateConnection(principal: Principal, id: string, input: { groups?: unknown }): Promise<ConnectionRecord> {
    const record = this.store.get(id);
    if (!record || !this.canSee(principal, record, record.workspaceId)) throw new ConnectorError("not_found", "Connection not found", 404);
    if (!this.canManage(principal, record)) throw new ConnectorError("forbidden", "You can't change this connection.", 403);
    const def = this.requireDefinition(record.connectorId);
    const next: ConnectionRecord = { ...record, updatedAt: this.now() };
    if (input.groups !== undefined) next.groups = this.validGroups(def, input.groups, true);
    await this.store.touch(next);
    this.options.log("connectors.updated", { connector: def.id, connectionId: id, groups: next.groups });
    this.options.audit?.({ action: AUDIT_ACTIONS.CONNECTOR_CHANGED, actor: auditActor(principal), workspaceId: record.workspaceId, target: { kind: "connection", id, name: def.name }, details: { groups: next.groups } });
    this.emit();
    return next;
  }

  /** Check the connection still works (and refresh who it is). */
  async testConnection(principal: Principal, id: string): Promise<ConnectionRecord> {
    const record = this.store.get(id);
    if (!record || !this.canSee(principal, record, record.workspaceId)) throw new ConnectorError("not_found", "Connection not found", 404);
    if (!this.canManage(principal, record)) throw new ConnectorError("forbidden", "You can't change this connection.", 403);
    const def = this.requireDefinition(record.connectorId);
    if (!def.identify) return record;
    try {
      const identity = await def.identify(this.actionContext(def, record, AbortSignal.timeout(20_000)));
      const next: ConnectionRecord = { ...(this.store.get(id) ?? record), status: "connected", updatedAt: this.now(), ...(identity.account ? { account: identity.account } : {}), ...(identity.accountName ? { accountName: identity.accountName } : {}) };
      delete next.statusMessage;
      await this.store.touch(next);
      this.emit();
      return next;
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 401) await this.setStatus(id, "reconnect", `${def.vendor} rejected the sign-in. Reconnect ${def.name}.`);
      else if (!(error instanceof ConnectorError && error.code === "refresh_backoff")) await this.setStatus(id, "error", this.describeFailure(def, record, error, new AbortController().signal));
      return this.store.get(id) ?? record;
    }
  }

  /** Remove a connection and revoke its tokens with the vendor (best effort). */
  async disconnect(principal: Principal, id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record || !this.canSee(principal, record, record.workspaceId)) throw new ConnectorError("not_found", "Connection not found", 404);
    if (!this.canManage(principal, record)) throw new ConnectorError("forbidden", "You can't remove this connection.", 403);
    const def = this.definition(record.connectorId);
    const credentials = this.store.credentialsOf(id);
    if (def && def.auth.kind === "oauth2" && record.authKind === "oauth2" && credentials?.accessToken) {
      await this.revoke(def, def.auth, credentials).catch((error: unknown) => {
        this.options.log("connectors.revoke_failed", { connector: def.id, connectionId: id, status: error instanceof ConnectorHttpError ? error.status : undefined });
      });
    }
    await this.store.remove(id);
    this.options.log("connectors.disconnected", { connector: record.connectorId, connectionId: id, scope: record.scope });
    this.options.audit?.({ action: AUDIT_ACTIONS.CONNECTOR_DISCONNECTED, actor: auditActor(principal), workspaceId: record.workspaceId, target: { kind: "connection", id, name: def?.name ?? record.connectorId }, details: { connector: record.connectorId, scope: record.scope } });
    this.emit();
  }

  private async revoke(def: ConnectorDefinition, auth: OAuth2Auth, credentials: StoredCredentials): Promise<void> {
    const client = await this.clientCredentials(def);
    if (!client || !credentials.accessToken) return;
    const revokeUrl = this.authUrl(def, "revokeUrl") || undefined;
    const fetchWithTimeout = (url: string, init: RequestInit) => this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "manual" });
    if (auth.revoke) {
      await auth.revoke({
        accessToken: credentials.accessToken,
        ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        ...(revokeUrl ? { revokeUrl } : {}),
        fetch: fetchWithTimeout
      });
      return;
    }
    if (!revokeUrl) return;
    const response = await fetchWithTimeout(revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: credentials.refreshToken ?? credentials.accessToken, client_id: client.clientId, client_secret: client.clientSecret }).toString()
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new ConnectorHttpError(response.status, `HTTP ${response.status}`);
  }

  /* ───────────── permissions ───────────── */

  private checkConnectPermission(principal: Principal, scope: unknown, workspaceId: string): ConnectionScope {
    if (scope !== "personal" && scope !== "workspace") throw new ConnectorError("bad_request", 'scope must be "personal" or "workspace"');
    if (scope === "workspace" && !authorize(principal, PERMISSIONS.INTEGRATIONS_CONNECT_SHARED, { workspaceId })) {
      throw new ConnectorError("forbidden", "Only workspace admins can connect an account for the whole workspace. Connect it just for yourself instead.", 403);
    }
    if (scope === "personal" && !authorize(principal, PERMISSIONS.INTEGRATIONS_CONNECT_PERSONAL, { workspaceId })) {
      throw new ConnectorError("forbidden", "You don't have permission to connect accounts in this workspace.", 403);
    }
    return scope;
  }

  /** Personal: only its owner. Shared: anyone who may use integrations in that workspace. */
  canSee(principal: Principal, record: ConnectionRecord, workspaceId: string): boolean {
    if (record.scope === "personal") return record.ownerKey === ownerKeyOf(principal);
    return record.workspaceId === workspaceId && authorize(principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId });
  }

  canManage(principal: Principal, record: ConnectionRecord): boolean {
    if (record.scope === "personal") {
      // Only its owner — even after losing connect rights they may still remove it.
      return record.ownerKey === ownerKeyOf(principal);
    }
    return authorize(principal, PERMISSIONS.INTEGRATIONS_CONNECT_SHARED, { workspaceId: record.workspaceId });
  }

  /* ───────────── views ───────────── */

  state(principal: Principal, workspaceId: string, origin?: string): IntegrationsState {
    const can = {
      use: authorize(principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId }),
      connectPersonal: authorize(principal, PERMISSIONS.INTEGRATIONS_CONNECT_PERSONAL, { workspaceId }),
      connectShared: authorize(principal, PERMISSIONS.INTEGRATIONS_CONNECT_SHARED, { workspaceId }),
      manageApps: authorize(principal, PERMISSIONS.ORG_SETTINGS)
    };
    const defs = this.definitions();
    const connectors: IntegrationConnectorView[] = defs.map((def) => this.connectorView(def, can.manageApps, origin));
    for (const placeholder of ENTERPRISE_CONNECTORS) {
      if (defs.some((def) => def.id === placeholder.id)) continue;
      connectors.push({
        id: placeholder.id,
        name: placeholder.name,
        vendor: placeholder.vendor,
        description: placeholder.description,
        edition: "enterprise",
        feature: placeholder.feature,
        available: false,
        authKinds: [],
        groups: []
      });
    }
    const connections = can.use
      ? this.store
          .list()
          .filter((record) => !record.id.startsWith("probe-") && this.canSee(principal, record, workspaceId))
          .map((record) => this.connectionView(principal, record))
      : [];
    return { connectors, connections, can };
  }

  private connectorView(def: ConnectorDefinition, admin: boolean, origin?: string): IntegrationConnectorView {
    const app = this.store.app(def.id);
    const settingsValues = this.appSettings(def);
    const authKinds: Array<"oauth2" | "apiKey"> = [def.auth.kind, ...(def.alternateAuth ? (["apiKey"] as const) : [])];
    const apiKey = def.auth.kind === "apiKey" ? def.auth : def.alternateAuth;
    return {
      id: def.id,
      name: def.name,
      vendor: def.vendor,
      description: def.description,
      edition: def.edition,
      ...(def.feature ? { feature: def.feature } : {}),
      available: true,
      authKinds,
      ...(apiKey ? { apiKeyFields: apiKey.fields.map((field) => ({ ...field })) } : {}),
      groups: def.groups.map((group) => ({
        id: group.id,
        title: group.title,
        description: group.description,
        scopes: [...group.scopes, ...(group.userScopes ?? []).map((scope) => `${USER_SCOPE_PREFIX}${scope}`)],
        defaultEnabled: group.defaultEnabled,
        allowed: !app.allowedGroups || app.allowedGroups.includes(group.id),
        actions: def.actions
          .filter((action) => action.group === group.id)
          .map((action) => ({ name: `${def.id}_${action.name}`, title: action.title, effect: action.effect, ...(action.risk ? { risk: action.risk } : {}) }))
      })),
      ...(def.auth.kind === "oauth2"
        ? {
            app: {
              configured: this.appConfiguredSync(def),
              ...(this.appSourceSync(def) ? { source: this.appSourceSync(def)! } : {}),
              ...(admin && this.clientIdSync(def) ? { clientId: this.clientIdSync(def)! } : {}),
              redirectUri: this.redirectUri(origin),
              settings: (def.appSettings ?? []).map((field) => ({ name: field.name, label: field.label, ...(field.help ? { help: field.help } : {}), value: settingsValues[field.name] ?? field.default })),
              ...(def.appSecrets?.length
                ? {
                    secrets: def.appSecrets.map((field) => ({
                      name: field.name,
                      label: field.label,
                      ...(field.help ? { help: field.help } : {}),
                      configured: Boolean(this.appCache.get(def.id)?.secrets?.includes(field.name)) || Boolean(this.options.env[`SIBYL_${this.appSecretName(def, field.name)}`]?.trim())
                    }))
                  }
                : {}),
              ...(def.appEndpoints?.length
                ? { endpoints: def.appEndpoints.map((endpoint) => ({ label: endpoint.label, url: `${this.publicOrigin(origin)}${tenantPath(this.options.ownerId, endpoint.path)}`, ...(endpoint.help ? { help: endpoint.help } : {}) })) }
                : {})
            }
          }
        : {}),
      setup: { ...def.setup, steps: [...def.setup.steps] }
    };
  }

  /** Client ID for admins (not secret). From the vault cache if present, else env. */
  private clientIdSync(def: ConnectorDefinition): string | undefined {
    return this.appCache.get(def.id)?.clientId ?? this.options.env[`SIBYL_${def.id.toUpperCase()}_CLIENT_ID`]?.trim() ?? undefined;
  }

  private appConfiguredSync(def: ConnectorDefinition): boolean {
    return Boolean(this.appCache.get(def.id)?.configured) || Boolean(this.options.env[`SIBYL_${def.id.toUpperCase()}_CLIENT_ID`]?.trim() && this.options.env[`SIBYL_${def.id.toUpperCase()}_CLIENT_SECRET`]?.trim());
  }

  private appSourceSync(def: ConnectorDefinition): "vault" | "env" | undefined {
    if (this.appCache.get(def.id)?.configured) return "vault";
    return this.appConfiguredSync(def) ? "env" : undefined;
  }

  /** Refresh the cached "is the app configured" facts (call before building a state). */
  async refreshAppCache(): Promise<void> {
    const vault = this.options.vault;
    for (const def of this.definitions()) {
      if (def.auth.kind !== "oauth2" || !vault) continue;
      const names = this.secretNames(def);
      const configured = (await vault.has(this.options.ownerId, names.id)) && (await vault.has(this.options.ownerId, names.secret));
      let clientId: string | undefined;
      if (configured) {
        try {
          clientId = await vault.resolve(this.options.ownerId, names.id, { host: this.credentialHosts(def)[0] });
        } catch {
          clientId = undefined;
        }
      }
      const secrets: string[] = [];
      for (const field of def.appSecrets ?? []) if (await vault.has(this.options.ownerId, this.appSecretName(def, field.name))) secrets.push(field.name);
      this.appCache.set(def.id, { configured, ...(clientId ? { clientId } : {}), secrets });
    }
  }

  async stateFor(principal: Principal, workspaceId: string, origin?: string): Promise<IntegrationsState> {
    await this.refreshAppCache();
    return this.state(principal, workspaceId, origin);
  }

  connectionView(principal: Principal, record: ConnectionRecord): IntegrationConnectionView {
    const def = this.definition(record.connectorId);
    const needsConsent = def ? record.groups.filter((group) => !this.groupConsented(def, record, group)) : [];
    return {
      id: record.id,
      connectorId: record.connectorId,
      scope: record.scope,
      workspaceId: record.workspaceId,
      mine: record.scope === "personal" && record.ownerKey === ownerKeyOf(principal),
      canManage: this.canManage(principal, record),
      ...(record.account ? { account: record.account } : {}),
      ...(record.accountName ? { accountName: record.accountName } : {}),
      ...(record.createdByName ? { createdByName: record.createdByName } : {}),
      status: record.status,
      ...(record.statusMessage ? { statusMessage: record.statusMessage } : {}),
      groups: [...record.groups],
      needsConsent,
      authKind: record.authKind,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {})
    };
  }

  /** The OAuth redirect URI: SIBYL_PUBLIC_GATEWAY_URL, else the request's origin. */
  redirectUri(origin?: string): string {
    return `${this.publicOrigin(origin)}${CALLBACK_PATH}`;
  }

  /** Where vendors reach this gateway: SIBYL_PUBLIC_GATEWAY_URL, else the request's origin. */
  publicOrigin(origin?: string): string {
    const configured = this.options.env.SIBYL_PUBLIC_GATEWAY_URL?.trim().replace(/\/+$/, "");
    return configured || origin || "http://localhost:8787";
  }

  /* ───────────── helpers ───────────── */

  private requireDefinition(id: string): ConnectorDefinition {
    const def = this.definition(id);
    if (!def) {
      const enterprise = ENTERPRISE_CONNECTORS.find((entry) => entry.id === id);
      if (enterprise) throw new ConnectorError("enterprise", `${enterprise.name} is part of Sibyl Enterprise and needs a licence with "${enterprise.feature}".`, 402);
      throw new ConnectorError("not_found", "Unknown connector", 404);
    }
    return def;
  }

  private defaultGroups(def: ConnectorDefinition): string[] {
    return def.groups.filter((group) => group.defaultEnabled && this.groupAllowed(def, group.id)).map((group) => group.id);
  }

  private validGroups(def: ConnectorDefinition, value: unknown, respectPolicy: boolean): string[] {
    if (!Array.isArray(value) || value.length > 50 || !value.every((item) => typeof item === "string")) throw new ConnectorError("bad_request", "groups must be a list of group ids");
    const known = new Set(def.groups.map((group) => group.id));
    const groups = unique(value as string[]);
    for (const group of groups) {
      if (!known.has(group)) throw new ConnectorError("bad_request", `Unknown action group "${group}"`);
      if (respectPolicy && !this.groupAllowed(def, group)) throw new ConnectorError("forbidden", `Your organization has turned off "${def.groups.find((g) => g.id === group)?.title ?? group}".`, 403);
    }
    return groups;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener (a closed socket) never breaks the others.
      }
    }
  }
}

/** Personal connections belong to "user:<id>", or the token/local owner. */
export function ownerKeyOf(principal: Principal): string {
  return principal.kind === "user" && principal.userId ? `user:${principal.userId}` : principal.kind;
}

function splitScopes(scope: string): string[] {
  return unique(scope.split(/[\s,]+/).filter(Boolean));
}

/** Microsoft reports "Mail.Read" for "https://graph.microsoft.com/Mail.Read". */
function shortScope(scope: string): string {
  const index = scope.lastIndexOf("/");
  return index >= 0 && scope.startsWith("https://graph.microsoft.com/") ? scope.slice(index + 1) : scope;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
