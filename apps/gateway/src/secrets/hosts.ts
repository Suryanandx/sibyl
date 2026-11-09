/**
 * Host binding for secrets. Each secret lists where it may be sent:
 * - an exact hostname: `api.higgsfield.ai`
 * - a wildcard for subdomains: `*.myshopify.com` (any subdomain, not the apex)
 * - `local`: handed to a local (stdio) MCP server's environment
 */
import { isIP } from "node:net";

export const LOCAL_HOST = "local";
export const MAX_HOSTS = 10;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Normalise one allowed-host entry, or return undefined when invalid. */
export function normalizeHostPattern(raw: string): string | undefined {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (value === LOCAL_HOST) return value;
  if (!value || value.length > 253) return undefined;
  if (isIP(value)) return value;
  const wildcard = value.startsWith("*.");
  const host = wildcard ? value.slice(2) : value;
  const labels = host.split(".");
  // At least two labels: rejects bare names and `*.com` (half the internet).
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  if (/^\d+$/.test(labels.at(-1)!)) return undefined;
  return value;
}

/** Validate a list of allowed hosts (1–10 entries, deduplicated). */
export function normalizeHostList(raw: unknown): { hosts: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "allowedHosts must list at least one host" };
  if (raw.length > MAX_HOSTS) return { error: `allowedHosts can list at most ${MAX_HOSTS} hosts` };
  const hosts: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return { error: "allowedHosts must be strings" };
    const host = normalizeHostPattern(entry);
    if (!host) {
      return { error: `"${entry.slice(0, 80)}" is not a valid host (use api.example.com, *.example.com or local)` };
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { hosts };
}

/** True when `host` (a URL hostname, or undefined for local use) is allowed. */
export function hostAllowed(allowed: readonly string[], host: string | undefined): boolean {
  if (host === undefined) return allowed.includes(LOCAL_HOST);
  const target = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!target || target === LOCAL_HOST) return false;
  return allowed.some((pattern) => {
    if (pattern === LOCAL_HOST) return false;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === pattern;
  });
}
