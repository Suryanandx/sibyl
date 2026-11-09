/**
 * Native connectors: the shapes every connector shares.
 *
 * A connector is code plus a manifest. It declares how people sign in
 * (OAuth 2.0 with the organization's own app, or an API key), the action
 * groups an admin can switch on and off (each with the smallest scopes it
 * needs), and the actions. Each action becomes one brain tool named
 * `<connector>_<action>`; no prompts are bundled.
 *
 * Connector code never sees a token: it gets a `ConnectorHttp` client that
 * adds the connection's credentials, refreshes them, retries and trims.
 */
import type { FeatureId } from "@open-gpt-live/core";

/** JSON Schema (object) for an action's input. */
export type JsonSchema = Record<string, unknown>;

/** A value an app setting can carry into URL templates, e.g. `{tenant}`. */
export interface AppSettingField {
  name: string;
  label: string;
  help?: string;
  default: string;
  /** Allowed characters/shape (validated before it reaches a URL). */
  pattern: RegExp;
}

export interface OAuth2Auth {
  kind: "oauth2";
  /** May contain `{setting}` placeholders filled from the app settings. */
  authorizeUrl: string;
  tokenUrl: string;
  /** Scopes requested on every connection (sign-in identity, refresh tokens). */
  baseScopes: string[];
  pkce: boolean;
  /** Extra query parameters for the authorize URL. */
  authorizeParams?: Record<string, string>;
  /** How scopes are joined in the authorize URL (default " "). */
  scopeSeparator?: string;
  /**
   * Revoke tokens when a connection is removed. Default: when `revokeUrl` is
   * set, POST `token=<refresh token or access token>` (RFC 7009).
   */
  revokeUrl?: string;
  revoke?(input: RevokeInput): Promise<void>;
  /**
   * Authorize-URL parameter for scopes granted to the person's own user token
   * next to the app's token (Slack: "user_scope"). Groups list those in `userScopes`.
   */
  userScopeParam?: string;
  /**
   * A second token the vendor returns for the person who connected (Slack:
   * `authed_user.access_token` for user scopes such as search). Stored
   * encrypted with the connection; actions use it with `as: "user"`.
   */
  userGrant?(token: Record<string, unknown>): { accessToken?: string; scopes: string[] } | undefined;
}

export interface ApiKeyAuth {
  kind: "apiKey";
  fields: Array<{ name: string; label: string; help?: string; placeholder?: string }>;
  /** Build the request headers for a stored key. */
  headers(values: Record<string, string>): Record<string, string>;
}

export type ConnectorAuth = OAuth2Auth | ApiKeyAuth;

export interface RevokeInput {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  /** URL with the app settings filled in. */
  revokeUrl?: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/** A switchable set of actions with the scopes they need. */
export interface ActionGroup {
  id: string;
  title: string;
  description: string;
  /** OAuth scopes this group adds (empty for API-key connectors or when the base scopes cover it). */
  scopes: string[];
  /** Switched on for new connections unless the person picks otherwise. */
  defaultEnabled: boolean;
  /** Scopes this group needs on the person's own user token (see OAuth2Auth.userScopeParam). */
  userScopes?: string[];
}

export interface ConnectorAction<Input = any> {
  /** snake_case; the tool is `<connector>_<name>`. */
  name: string;
  group: string;
  title: string;
  /** Written for the model: what it does, when to use it, what it returns. */
  description: string;
  inputSchema: JsonSchema;
  effect: "read" | "write";
  /** Sends, deletes or shares something: the approval card says so. */
  risk?: "high";
  run(input: Input, context: ConnectorActionContext): Promise<ConnectorActionResult>;
}

export type ConnectorActionResult =
  | string
  | {
      /** One line for the person ("Found 4 messages"). */
      summary?: string;
      /** What the model reads (trimmed by the framework). */
      data: unknown;
    };

export interface ConnectionInfo {
  id: string;
  connectorId: string;
  scope: ConnectionScope;
  /** Account the connection signed in as (e-mail, portal, org). */
  account?: string;
  /** Non-secret values captured at connect time (e.g. Salesforce instance URL). */
  metadata: Record<string, string>;
}

export interface ConnectorActionContext {
  http: ConnectorHttp;
  connection: ConnectionInfo;
  /** API base URL by name (see ConnectorDefinition.apiBases); honours test overrides. */
  base(name: string): string;
  signal: AbortSignal;
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Absolute URL; its host must be one of the connector's API hosts. */
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. */
  body?: unknown;
  /** Form body (application/x-www-form-urlencoded). */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** "json" (default), "text" or "buffer" (binary download). */
  responseType?: "json" | "text" | "buffer";
  /** Authenticate with the person's user token (OAuth2Auth.userGrant) instead of the app token. */
  as?: "user";
  /** Max response bytes for text/buffer (default 15 MB). */
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * Send no credentials (a pre-signed download URL the vendor handed out).
   * Any https host is allowed then; nothing secret goes with it.
   */
  unauthenticated?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

/** The one HTTP client connectors use: auth, timeouts, retries, refresh. */
export interface ConnectorHttp {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, query?: HttpRequest["query"], headers?: Record<string, string>): Promise<T>;
  post<T = unknown>(url: string, body?: unknown, query?: HttpRequest["query"]): Promise<T>;
  patch<T = unknown>(url: string, body?: unknown, query?: HttpRequest["query"]): Promise<T>;
  put<T = unknown>(url: string, body?: unknown, query?: HttpRequest["query"]): Promise<T>;
  delete<T = unknown>(url: string, query?: HttpRequest["query"]): Promise<T>;
  /**
   * Follow pages until `max` items: `next` returns the next request (or a
   * URL), undefined when done.
   */
  paginate<Page, Item>(
    first: HttpRequest,
    options: { items(page: Page): Item[]; next(page: Page): HttpRequest | string | undefined; max: number }
  ): Promise<Item[]>;
}

export interface ConnectorSetupGuide {
  /** Where the app is registered. */
  consoleUrl: string;
  consoleName: string;
  /** Ordered steps (plain text, shown in the UI and docs). */
  steps: string[];
  /** Anchor in docs/integrations.md. */
  docsAnchor: string;
}

/** A secret of the organization's app besides the OAuth client (e.g. Slack's signing secret). */
export interface AppSecretField {
  /** Upper snake case; stored in the vault as `<CONNECTOR>_<NAME>` (env fallback SIBYL_<CONNECTOR>_<NAME>). */
  name: string;
  label: string;
  help?: string;
}

/** An address on this gateway the vendor's app must be told about (e.g. Slack's Events URL). */
export interface AppEndpoint {
  label: string;
  /** Gateway path, e.g. "/api/presence/slack/events". */
  path: string;
  help?: string;
}

export interface IdentifyResult {
  account?: string;
  accountName?: string;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  vendor: string;
  description: string;
  /** "enterprise" connectors come from ee/ and need their licence feature. */
  edition: "oss" | "enterprise";
  feature?: FeatureId;
  auth: ConnectorAuth;
  /** Second way to connect (e.g. a HubSpot private app token next to OAuth). */
  alternateAuth?: ApiKeyAuth;
  /** Org-level settings filled into auth URLs (e.g. Microsoft tenant). */
  appSettings?: AppSettingField[];
  /** Further app secrets an admin pastes in setup (vault-encrypted, never shown again). */
  appSecrets?: AppSecretField[];
  /** Gateway addresses to register with the vendor's app (shown in setup). */
  appEndpoints?: AppEndpoint[];
  /** Named API base URLs (may use `{metadata}` placeholders, e.g. "{instanceUrl}"). */
  apiBases: Record<string, string>;
  /**
   * Hosts the connection's credentials may be sent to. Entries starting with
   * "." match any subdomain ("." + suffix).
   */
  apiHosts: string[];
  groups: ActionGroup[];
  actions: ConnectorAction[];
  setup: ConnectorSetupGuide;
  /** Who did we connect as (called right after connecting and by "test"). */
  identify?(context: ConnectorActionContext): Promise<IdentifyResult>;
  /** Non-secret values to keep from the token response (validated hosts only). */
  tokenMetadata?(token: Record<string, unknown>): Record<string, string>;
}

export type ConnectionScope = "personal" | "workspace";

export type ConnectionStatus = "connected" | "reconnect" | "error";

/** What is stored per connection (tokens live elsewhere, encrypted). */
export interface ConnectionRecord {
  id: string;
  connectorId: string;
  scope: ConnectionScope;
  /** Workspace it was created in; shared connections only work there. */
  workspaceId: string;
  /** Personal: the owner ("user:<id>", "token" or "local"). Shared: who connected it. */
  ownerKey: string;
  createdByName?: string;
  authKind: "oauth2" | "apiKey";
  account?: string;
  accountName?: string;
  status: ConnectionStatus;
  statusMessage?: string;
  /** Enabled action groups. */
  groups: string[];
  /** Scopes the vendor granted. */
  grantedScopes: string[];
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  /** Refresh backoff. */
  refreshFailures?: number;
  retryAfter?: number;
}

/** Encrypted at rest; never leaves connectors/. */
export interface StoredCredentials {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  /** API-key connections: the field values. */
  apiKey?: Record<string, string>;
  /** The person's own user token, when the vendor grants one next to the app token (Slack). */
  userAccessToken?: string;
}

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
