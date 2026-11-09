/**
 * The model-facing side of secrets:
 * - request_secret: ask the user for a key in a secure box (the box is the consent)
 * - list_secrets:   what is connected (names, services, hosts — never values)
 * - api_request:    call an HTTP API with `${secret:NAME}` resolved server-side,
 *                   only for hosts the secret allows (needs approval); sent
 *                   with fetchPublic, every hop bound to those hosts
 */
import type { ToolDefinition, ToolResult } from "@open-gpt-live/core";
import { FetchPublicError, fetchPublic, isTextualType, type FetchLike, type ResolveHost } from "../net/safe-fetch.js";
import { describeError } from "../tools/builtin/http.js";
import { hostAllowed, normalizeHostList } from "./hosts.js";
import { referencedSecrets, SECRET_NAME, SECRET_REF, SecretError, type SecretVault } from "./vault.js";
import type { SecretsHub } from "./ws.js";

export const API_MAX_REDIRECTS = 3;
export const API_MAX_BYTES = 1024 * 1024;
export const API_MAX_CHARS = 8_000;
const API_TIMEOUT_MS = 20_000;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const FORBIDDEN_HEADERS = /^(host|content-length|connection|transfer-encoding|upgrade|keep-alive|te|trailer|proxy-.*)$/i;

export interface SecretToolsOptions {
  vault: SecretVault;
  hub: SecretsHub;
  /** Test seams. */
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

export function createSecretTools(options: SecretToolsOptions): ToolDefinition<any, any>[] {
  return [requestSecretTool(options), listSecretsTool(options), apiRequestTool(options)];
}

/* ───────────── request_secret ───────────── */

interface RequestSecretInput {
  name?: unknown;
  service?: unknown;
  description?: unknown;
  allowedHosts?: unknown;
  howToGet?: unknown;
  docsUrl?: unknown;
  replace?: unknown;
}

function requestSecretTool({ vault, hub }: SecretToolsOptions): ToolDefinition<RequestSecretInput> {
  return {
    name: "request_secret",
    title: "Ask for an API key",
    description: [
      "Ask the user for an API key, token or password in a secure box shown in the chat, and store it encrypted.",
      "Use this whenever an integration needs a credential. NEVER ask the user to paste a key into the chat.",
      "You never see the value: afterwards, reference it as ${secret:NAME} in api_request (headers, query or body) or MCP configs.",
      "allowedHosts are the only hosts the key will ever be sent to (exact host like api.example.com, or *.example.com). Use \"local\" for a local MCP server's environment.",
      "If the secret already exists this returns immediately; pass replace: true only when the user wants to change it."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "UPPER_SNAKE_CASE name, e.g. HIGGSFIELD_API_KEY" },
        service: { type: "string", description: "Service name shown to the user, e.g. Higgsfield" },
        description: { type: "string", description: "One sentence: why it's needed and what it will be used for" },
        allowedHosts: { type: "array", items: { type: "string" }, description: "Hosts the key may be sent to, e.g. [\"api.higgsfield.ai\"]" },
        howToGet: { type: "string", description: "Short steps for finding or creating the key" },
        docsUrl: { type: "string", description: "https link to the page where the key is created" },
        replace: { type: "boolean", description: "Ask again even though the secret exists" }
      },
      required: ["name", "service", "description", "allowedHosts"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    provider: "secrets",
    async run(input, context): Promise<ToolResult> {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!SECRET_NAME.test(name)) return fail("name must be UPPER_SNAKE_CASE, up to 64 characters (e.g. HIGGSFIELD_API_KEY)");
      const service = text(input.service, 80);
      if (!service) return fail("service is required (e.g. \"Higgsfield\")");
      const description = text(input.description, 500);
      if (!description) return fail("description is required: say why the key is needed");
      const hosts = normalizeHostList(input.allowedHosts);
      if ("error" in hosts) return fail(hosts.error);
      const howToGet = text(input.howToGet, 500);
      let docsUrl: string | undefined;
      if (input.docsUrl !== undefined && input.docsUrl !== "") {
        try {
          const url = new URL(String(input.docsUrl));
          if (url.protocol !== "https:" || url.username || url.password) throw new Error();
          docsUrl = url.toString().slice(0, 500);
        } catch {
          return fail("docsUrl must be an https link");
        }
      }
      const replace = input.replace === true;

      const existing = await vault.get(context.ownerId, name);
      if (existing && !replace) {
        return {
          content: `${name} is already saved (${existing.service}, allowed for ${existing.allowedHosts.join(", ")}). Use it as \${secret:${name}}. Pass replace: true only if the user wants to change it.`
        };
      }

      const outcome = await hub.ask(
        context.ownerId,
        {
          name,
          service,
          description,
          allowedHosts: hosts.hosts,
          ...(howToGet ? { howToGet } : {}),
          ...(docsUrl ? { docsUrl } : {}),
          replace: Boolean(existing)
        },
        { runId: context.runId, ...(context.conversationId ? { conversationId: context.conversationId } : {}), signal: context.signal }
      );
      switch (outcome.status) {
        case "saved":
          return { content: `Saved ${name} (allowed for ${outcome.allowedHosts.join(", ")}). Use it as \${secret:${name}}.` };
        case "cancelled":
          return { content: "User cancelled. Do not ask again unless they bring it up." };
        case "expired":
          return { content: "The request expired without an answer. Nothing was saved." };
        case "unavailable":
          return fail(`could not ask: ${outcome.reason}. The user can add ${name} under Secrets in the app.`);
      }
    }
  };
}

/* ───────────── list_secrets ───────────── */

function listSecretsTool({ vault }: SecretToolsOptions): ToolDefinition<Record<string, never>> {
  return {
    name: "list_secrets",
    title: "Check connected keys",
    description:
      "List the API keys and tokens the user has stored (names, services and allowed hosts only — never values). Use before request_secret or api_request to see what is connected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    source: "builtin",
    provider: "secrets",
    async run(_input, context): Promise<ToolResult> {
      const secrets = await vault.list(context.ownerId);
      if (secrets.length === 0) return { content: "No secrets are stored yet. Use request_secret to ask the user for one." };
      const lines = secrets.map(
        (s) => `- ${s.name} (${s.service}) → ${s.allowedHosts.join(", ")}${s.readable ? "" : " [unreadable: ask the user to enter it again]"}`
      );
      return {
        content: `Stored secrets (reference as \${secret:NAME}):\n${lines.join("\n")}`,
        data: secrets.map(({ name, service, allowedHosts, readable }) => ({ name, service, allowedHosts, readable }))
      };
    }
  };
}

/* ───────────── api_request ───────────── */

interface ApiRequestInput {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  query?: unknown;
  body?: unknown;
}

function apiRequestTool(options: SecretToolsOptions): ToolDefinition<ApiRequestInput> {
  return {
    name: "api_request",
    title: "Call an API",
    description: [
      "Make an HTTPS request to a public API, e.g. a service the user connected with a key.",
      "Put credentials as ${secret:NAME} anywhere in headers, query, body or the URL's query — they are filled in on the server, only for hosts the secret allows; you never see them.",
      "The response body (truncated) comes back with any secret values masked."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...METHODS], description: "HTTP method (default GET)" },
        url: { type: "string", description: "Full https URL" },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "e.g. {\"Authorization\": \"Bearer ${secret:HIGGSFIELD_API_KEY}\"}" },
        query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "Query parameters" },
        body: { description: "JSON object/array (sent as application/json) or a raw string" }
      },
      required: ["url"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "secrets",
    async run(input, context): Promise<ToolResult> {
      const owner = context.ownerId;
      const vault = options.vault;
      const method = (typeof input.method === "string" ? input.method.toUpperCase() : "GET") as (typeof METHODS)[number];
      if (!METHODS.includes(method)) return fail(`method must be one of ${METHODS.join(", ")}`);
      if (typeof input.url !== "string" || !input.url.trim() || input.url.length > 4_000) return fail("url must be a full https URL");
      const rawUrl = input.url.trim();

      const headersIn = stringRecord(input.headers, "headers");
      if ("error" in headersIn) return fail(headersIn.error);
      const queryIn = stringRecord(input.query, "query", true);
      if ("error" in queryIn) return fail(queryIn.error);
      let bodyText: string | undefined;
      let bodyIsJson = false;
      if (input.body !== undefined && input.body !== null) {
        if (method === "GET" || method === "HEAD") return fail(`${method} requests can't have a body`);
        if (typeof input.body === "string") bodyText = input.body;
        else {
          bodyText = JSON.stringify(input.body);
          bodyIsJson = true;
        }
        if (bodyText.length > 200_000) return fail("body is too large (max 200 KB)");
      }

      // Where is it going? Parse with references masked: they may not pick the host.
      let target: URL;
      try {
        target = new URL(rawUrl.replace(SECRET_REF, "SIBYLSECRETREF"));
      } catch {
        return fail("url is not a valid URL");
      }
      if (target.hostname.toLowerCase().includes("sibylsecretref") || target.username || target.password) {
        return fail("secrets can't be used in the URL's host or user info");
      }
      const used = new Set<string>([
        ...referencedSecrets(rawUrl),
        ...Object.entries(headersIn.value).flatMap(([k, v]) => [...referencedSecrets(k), ...referencedSecrets(v)]),
        ...Object.entries(queryIn.value).flatMap(([k, v]) => [...referencedSecrets(k), ...referencedSecrets(v)]),
        ...(bodyText ? referencedSecrets(bodyText) : [])
      ]);
      if (used.size > 0 && target.protocol !== "https:") return fail("secrets are only sent over https");
      const host = target.hostname.toLowerCase();

      // Resolve on the server, only for hosts every referenced secret allows.
      let url: URL;
      const headers: Record<string, string> = {};
      let body: string | undefined;
      try {
        url = new URL(await vault.resolveRefs(owner, rawUrl, { host, encode: encodeURIComponent }));
        if (url.hostname.toLowerCase() !== host) return fail("the URL's host changed after filling in secrets");
        for (const [key, value] of Object.entries(queryIn.value)) {
          url.searchParams.append(await vault.resolveRefs(owner, key, { host }), await vault.resolveRefs(owner, value, { host }));
        }
        for (const [key, value] of Object.entries(headersIn.value)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(key) || FORBIDDEN_HEADERS.test(key)) return fail(`header "${key.slice(0, 60)}" is not allowed`);
          headers[key.toLowerCase()] = await vault.resolveRefs(owner, value, { host });
        }
        if (bodyText !== undefined) {
          body = await vault.resolveRefs(owner, bodyText, {
            host,
            ...(bodyIsJson ? { encode: (value: string) => JSON.stringify(value).slice(1, -1) } : {})
          });
          if (bodyIsJson && !headers["content-type"]) headers["content-type"] = "application/json";
        }
      } catch (error) {
        if (error instanceof SecretError) return fail(error.message);
        return fail("could not prepare the request");
      }
      headers.accept ??= "application/json, text/*;q=0.9, */*;q=0.5";

      const redact = (text: string): Promise<string> => vault.redact(owner, text);
      const shown = (target: URL): Promise<string> => redact(`${target.origin}${target.pathname}`);
      // The host-binding rule: a request that carries secrets only goes (and is
      // only redirected) over https to hosts every one of those secrets allows.
      const secretsMayGo = async (target: URL): Promise<boolean> => {
        if (used.size === 0) return true;
        if (target.protocol !== "https:") return false;
        const refusals = await Promise.all([...used].map((name) => secretRefuses(vault, owner, name, target.hostname.toLowerCase())));
        return !refusals.some(Boolean);
      };
      try {
        const response = await fetchPublic(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: context.signal,
          timeoutMs: API_TIMEOUT_MS,
          maxRedirects: API_MAX_REDIRECTS,
          maxBytes: API_MAX_BYTES,
          allowHosts: secretsMayGo,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.resolveHost ? { resolveHost: options.resolveHost } : {})
        });
        if (response.location) {
          await response.discard();
          return { content: `HTTP ${response.status} redirect to ${await shown(response.location)} (not followed for ${method}).`, isError: response.status >= 400 };
        }
        const contentType = response.mime;
        const { bytes, truncated } = await response.bytes();
        let text: string;
        if (method === "HEAD" || bytes.byteLength === 0) text = "(empty body)";
        else if (!contentType || isTextualType(contentType)) text = new TextDecoder("utf-8").decode(bytes);
        else text = `(binary body: ${bytes.byteLength} bytes of ${contentType})`;
        const cut = text.length > API_MAX_CHARS;
        const shownBody = await redact(cut ? `${text.slice(0, API_MAX_CHARS)}\n…[truncated ${text.length - API_MAX_CHARS} characters]` : text);
        const host = response.url.hostname;
        const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${contentType ? ` (${contentType})` : ""} from ${host}${truncated ? " — body capped at 1 MB" : ""}`;
        return {
          content: `${statusLine}\n\n${shownBody}`,
          isError: response.status >= 400,
          data: { status: response.status, contentType, host, secrets: [...used] }
        };
      } catch (error) {
        if (error instanceof FetchPublicError) {
          if (error.code === "host_not_allowed" && error.url) {
            return fail(`the API redirected to ${await shown(error.url)}; not followed because the request carries secrets (${[...used].join(", ")}) that are not allowed there`);
          }
          if (error.code === "too_many_redirects") return fail(`too many redirects (last: ${error.url ? await shown(error.url) : "unknown"})`);
          if (error.code === "bad_redirect") return fail("the API redirected to an invalid location");
          return fail(`blocked: ${error.message}`);
        }
        if (error instanceof SecretError) return fail(error.message);
        return fail(await redact(`request failed: ${describeError(error, context.signal)}`));
      }
    }
  };
}

/** True when `name` may NOT be sent to `host`. */
async function secretRefuses(vault: SecretVault, ownerId: string, name: string, host: string): Promise<boolean> {
  const meta = await vault.get(ownerId, name);
  return !meta || !hostAllowed(meta.allowedHosts, host);
}

function stringRecord(value: unknown, what: string, scalars = false): { value: Record<string, string> } | { error: string } {
  if (value === undefined || value === null) return { value: {} };
  if (typeof value !== "object" || Array.isArray(value)) return { error: `${what} must be an object of strings` };
  const out: Record<string, string> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) return { error: `${what} has too many entries` };
  for (const [key, item] of entries) {
    if (typeof item === "string") out[key] = item;
    else if (scalars && (typeof item === "number" || typeof item === "boolean")) out[key] = String(item);
    else return { error: `${what}.${key.slice(0, 60)} must be a string` };
    if (/[\r\n]/.test(out[key]!) || /[\r\n]/.test(key)) return { error: `${what}.${key.slice(0, 60)} can't contain line breaks` };
  }
  return { value: out };
}


function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}
