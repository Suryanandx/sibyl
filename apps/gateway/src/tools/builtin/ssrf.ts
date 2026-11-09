/**
 * SSRF guard for tools that fetch model-chosen URLs: only http(s) to public
 * addresses. Every resolved address is checked (before the request and again
 * at connect time via a guarded DNS lookup, so DNS rebinding can't slip
 * through), and redirects are followed manually and re-checked.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

export type ResolveHost = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export class BlockedUrlError extends Error {}

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
    throw new BlockedUrlError(`only http and https URLs are allowed (got ${url.protocol.replace(":", "")})`);
  }
  if (url.username || url.password) throw new BlockedUrlError("URLs with embedded credentials are not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) throw new BlockedUrlError("URL has no host");
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new BlockedUrlError(`address ${hostname} is private or reserved`);
    return url;
  }
  if (BLOCKED_HOSTNAMES.test(hostname) || !hostname.includes(".")) {
    throw new BlockedUrlError(`host ${hostname} is not a public hostname`);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new BlockedUrlError(`could not resolve ${hostname}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`could not resolve ${hostname}`);
  const bad = addresses.find(({ address }) => isBlockedAddress(address));
  if (bad) throw new BlockedUrlError(`${hostname} resolves to private or reserved address ${bad.address}`);
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
  guardedAgent ??= new Agent({ connect: { lookup: guardedLookup }, connectTimeout: 10_000 });
  return guardedAgent;
}
