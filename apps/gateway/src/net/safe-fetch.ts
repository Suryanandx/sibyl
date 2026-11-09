/**
 * The one way the gateway fetches a URL it did not choose itself (a page the
 * model picked, a monitor's feed, a plugin manifest, an API call with a
 * secret): `fetchPublic()`.
 *
 * - SSRF: only http(s) to public addresses. The host is resolved and every
 *   address checked before the request, each redirect is re-checked the same
 *   way, and the socket's own DNS lookup refuses private addresses again at
 *   connect time, so DNS rebinding can't slip through.
 * - Caps: redirects (default 3, followed for GET/HEAD only), time (default
 *   10 s for the whole exchange) and body size (default 2 MB, read lazily).
 * - `allowHosts` lets a caller bind every hop to its own rule (api_request:
 *   hosts the secrets may go to).
 * - `privateNetwork: true` (only for targets an operator opted into, e.g. an
 *   alert webhook on the internal network) skips the address checks; scheme,
 *   credential, redirect, time and size rules still apply.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ResolveHost = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const USER_AGENT = "Sibyl/0.3 (open-source assistant)";
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export type FetchPublicErrorCode = "blocked" | "https_required" | "too_many_redirects" | "bad_redirect" | "host_not_allowed";

/** A fetch refused by policy (never sent, or a redirect not followed). `url` is the refused target when known. */
export class FetchPublicError extends Error {
  constructor(
    message: string,
    readonly code: FetchPublicErrorCode,
    readonly url?: URL
  ) {
    super(message);
    this.name = "FetchPublicError";
  }
}

/** The address is private, reserved, local or unresolvable. */
export class BlockedUrlError extends FetchPublicError {
  constructor(message: string, url?: URL) {
    super(message, "blocked", url);
    this.name = "BlockedUrlError";
  }
}

/* ───────────── address checks ───────────── */

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4] // reserved + broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8] // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** IPv4 embedded in an IPv6 address (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::/96). */
function embeddedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return undefined;
}

/** True when the address is not a public unicast address. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(bare, "ipv6");
  }
  return true; // not an IP at all
}

const BLOCKED_HOSTNAMES = /(^|\.)(localhost|localdomain|internal|local|home\.arpa)$/i;

export const defaultResolveHost: ResolveHost = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) reject(error);
      else resolve(addresses.map(({ address, family }) => ({ address, family })));
    });
  });

/**
 * Validate a URL for an outbound fetch: http(s) only, no credentials, and every
 * address the host resolves to must be public. Throws BlockedUrlError.
 */
export async function assertPublicUrl(rawUrl: string | URL, resolveHost: ResolveHost = defaultResolveHost): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new BlockedUrlError("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`only http and https URLs are allowed (got ${url.protocol.replace(":", "")})`, url);
  }
  if (url.username || url.password) throw new BlockedUrlError("URLs with embedded credentials are not allowed", url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) throw new BlockedUrlError("URL has no host", url);
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new BlockedUrlError(`address ${hostname} is private or reserved`, url);
    return url;
  }
  if (BLOCKED_HOSTNAMES.test(hostname) || !hostname.includes(".")) {
    throw new BlockedUrlError(`host ${hostname} is not a public hostname`, url);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new BlockedUrlError(`could not resolve ${hostname}`, url);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`could not resolve ${hostname}`, url);
  const bad = addresses.find(({ address }) => isBlockedAddress(address));
  if (bad) throw new BlockedUrlError(`${hostname} resolves to private or reserved address ${bad.address}`, url);
  return url;
}

/** DNS lookup for sockets that refuses private addresses (closes the rebinding window). */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
    if (error) return (callback as (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void)(error, "", 0);
    const bad = addresses.find(({ address }) => isBlockedAddress(address));
    if (bad || addresses.length === 0) {
      const blockedError = Object.assign(new Error(`blocked private address for ${hostname}`), { code: "EBLOCKED" });
      return (callback as (err: NodeJS.ErrnoException | null, address: string, family?: number) => void)(blockedError, "", 0);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as (err: null, addresses: LookupAddress[]) => void)(null, addresses);
    }
    const first = addresses[0]!;
    return (callback as (err: null, address: string, family: number) => void)(null, first.address, first.family);
  });
};

let guardedAgent: Agent | undefined;

/** Shared undici dispatcher whose sockets only connect to public addresses. */
export function getGuardedDispatcher(): Agent {
  guardedAgent ??= new Agent({ connect: { lookup: guardedLookup }, connectTimeout: DEFAULT_FETCH_TIMEOUT_MS });
  return guardedAgent;
}

/** Raw network fetch through the guarded dispatcher (fetchPublic's default transport). */
export const guardedFetch: FetchLike = (input, init) =>
  undiciFetch(String(input), { ...(init as object), dispatcher: getGuardedDispatcher() }) as unknown as Promise<Response>;

/** Unguarded transport, only for `privateNetwork` targets. */
const plainFetch: FetchLike = (input, init) => undiciFetch(String(input), init as object) as unknown as Promise<Response>;

/** The scheme and credential rules of assertPublicUrl without the address checks. */
function assertHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`only http and https URLs are allowed (got ${url.protocol.replace(":", "")})`, url);
  }
  if (url.username || url.password) throw new BlockedUrlError("URLs with embedded credentials are not allowed", url);
  return url;
}

/** True when a fetch failed because the connect-time lookup refused a private address. */
function blockedAtConnect(error: unknown): boolean {
  return (error as { cause?: { code?: string } } | undefined)?.cause?.code === "EBLOCKED";
}

/* ───────────── content types ───────────── */

/** "text/html; charset=utf-8" → "text/html". */
export function mimeOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-ndjson))/i;

/** Text a person or model can read (text/*, JSON, XML, YAML, …); false for binary types. */
export function isTextualType(mime: string): boolean {
  return TEXTUAL.test(mime);
}

/** Decode a body by its declared charset, else an HTML <meta charset>, else UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* ───────────── fetchPublic ───────────── */

export interface FetchPublicOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** For the whole exchange, body included (default 10 s). */
  timeoutMs?: number;
  /** Redirects followed for GET/HEAD (default 3); other methods never follow. */
  maxRedirects?: number;
  /** Body cap for bytes()/text() (default 2 MB). */
  maxBytes?: number;
  /** Refuse plain http (FetchPublicError "https_required"). */
  httpsOnly?: boolean;
  /** Extra rule for every hop (the first request included); false refuses with "host_not_allowed". */
  allowHosts?: (url: URL) => boolean | Promise<boolean>;
  /** Allow private and local addresses (an operator-approved internal target). Default false. */
  privateNetwork?: boolean;
  /** Test seams: the transport (default: the guarded dispatcher) and DNS. */
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

export interface PublicResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  /** The URL that answered (after redirects). */
  url: URL;
  /** Lower-case MIME type without parameters ("" when absent). */
  mime: string;
  /** content-length when the server declared one. */
  declaredBytes?: number;
  /** True when the declared length is over maxBytes. */
  tooLarge: boolean;
  /** Set on a 3xx that was not followed (a non-GET/HEAD request). */
  location?: URL;
  /** The body, capped at maxBytes (read once). */
  bytes(): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  /** The body decoded as text (charset aware), capped at maxBytes. */
  text(): Promise<{ text: string; truncated: boolean }>;
  /** Drop the body without reading it. */
  discard(): Promise<void>;
}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    return { bytes: all.slice(0, maxBytes), truncated: all.byteLength > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function wrap(response: Response, url: URL, maxBytes: number, location?: URL): PublicResponse {
  const declared = Number(response.headers.get("content-length"));
  const declaredBytes = response.headers.has("content-length") && Number.isFinite(declared) ? declared : undefined;
  let read: Promise<{ bytes: Uint8Array; truncated: boolean }> | undefined;
  const bytes = () => (read ??= readCapped(response, maxBytes));
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    url,
    mime: mimeOf(response.headers.get("content-type")),
    ...(declaredBytes !== undefined ? { declaredBytes } : {}),
    tooLarge: declaredBytes !== undefined && declaredBytes > maxBytes,
    ...(location ? { location } : {}),
    bytes,
    async text() {
      const { bytes: body, truncated } = await bytes();
      return { text: decodeBody(body, response.headers.get("content-type") ?? ""), truncated };
    },
    async discard() {
      if (!read) await response.body?.cancel().catch(() => undefined);
    }
  };
}

/**
 * Fetch a public URL with the SSRF checks and caps above. Throws
 * FetchPublicError (BlockedUrlError for private/unresolvable targets) for
 * anything refused by policy; network errors and timeouts pass through.
 */
export async function fetchPublic(rawUrl: string | URL, options: FetchPublicOptions = {}): Promise<PublicResponse> {
  const transport = options.fetch ?? (options.privateNetwork ? plainFetch : guardedFetch);
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const method = (options.method ?? "GET").toUpperCase();
  const follows = method === "GET" || method === "HEAD";
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers = { "user-agent": USER_AGENT, ...options.headers };

  let current = String(rawUrl);
  for (let hop = 0; ; hop += 1) {
    if (options.httpsOnly && !/^https:/i.test(current.trim())) throw new FetchPublicError("only https URLs are allowed", "https_required");
    const url = options.privateNetwork ? assertHttpUrl(current) : await assertPublicUrl(current, resolveHost);
    if (options.allowHosts && !(await options.allowHosts(url))) {
      throw new FetchPublicError(`${url.hostname} is not allowed here`, "host_not_allowed", url);
    }
    let response: Response;
    try {
      response = await transport(url.toString(), {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        redirect: "manual",
        signal
      });
    } catch (error) {
      if (blockedAtConnect(error)) throw new BlockedUrlError(`${url.hostname} resolves to a private address`, url);
      throw error;
    }
    const target = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!target) return wrap(response, url, maxBytes);
    let next: URL;
    try {
      next = new URL(target, url);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchPublicError("redirected to an invalid location", "bad_redirect");
    }
    if (!follows) return wrap(response, url, maxBytes, next);
    await response.body?.cancel().catch(() => undefined);
    if (hop >= maxRedirects) throw new FetchPublicError(`too many redirects (more than ${maxRedirects})`, "too_many_redirects", next);
    current = next.toString();
  }
}
