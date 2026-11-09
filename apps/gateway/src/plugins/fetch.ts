/**
 * Fetch a sibyl-plugin.json from a URL (https only) or a git repository
 * (only the manifest file, via the host's raw-file URL — nothing is cloned
 * and nothing is executed), with fetchPublic: https only, every hop checked
 * against private/local addresses, at most 3 redirects, 256 KB cap, 10 s
 * timeout.
 */
import { BlockedUrlError, FetchPublicError, fetchPublic, type FetchLike, type ResolveHost } from "../net/safe-fetch.js";
import { ManifestError, MAX_MANIFEST_BYTES } from "./manifest.js";

export const MANIFEST_FILE = "sibyl-plugin.json";

export interface ManifestFetchDeps {
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

/** Fetch the manifest text from an https URL. */
export async function fetchManifestText(rawUrl: string, deps: ManifestFetchDeps = {}, signal?: AbortSignal): Promise<{ text: string; finalUrl: string }> {
  try {
    new URL(rawUrl.trim());
  } catch {
    throw new ManifestError("That is not a valid URL.");
  }
  const tooLarge = () => new ManifestError(`The manifest is larger than ${MAX_MANIFEST_BYTES / 1024} KB.`);
  let response;
  try {
    response = await fetchPublic(rawUrl.trim(), {
      httpsOnly: true,
      maxBytes: MAX_MANIFEST_BYTES,
      headers: { accept: "application/json, text/plain;q=0.9" },
      ...(signal ? { signal } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {})
    });
  } catch (error) {
    if (error instanceof BlockedUrlError) throw new ManifestError(`That address is not allowed: ${error.message}.`);
    if (error instanceof FetchPublicError) {
      throw new ManifestError(error.code === "https_required" ? "Plugin manifests must be fetched over https." : `${error.message[0]!.toUpperCase()}${error.message.slice(1)}.`);
    }
    throw new ManifestError(`Could not fetch the manifest: ${(error as Error).message}`);
  }
  if (!response.ok) {
    await response.discard();
    throw new ManifestError(response.status === 404 ? `No ${MANIFEST_FILE} was found there (HTTP 404).` : `The server answered HTTP ${response.status}.`);
  }
  if (response.tooLarge) {
    await response.discard();
    throw tooLarge();
  }
  const { bytes, truncated } = await response.bytes();
  if (truncated) throw tooLarge();
  return { text: Buffer.from(bytes).toString("utf8"), finalUrl: response.url.toString() };
}

/**
 * The raw URL of sibyl-plugin.json in a git repository:
 * - GitHub:    https://github.com/o/r[.git][/tree/<ref>[/<dir>]]
 * - GitLab:    https://gitlab.com/o/r[.git][/-/tree/<ref>[/<dir>]]
 * - Bitbucket: https://bitbucket.org/o/r[.git][/src/<ref>[/<dir>]]
 * A URL that already ends in sibyl-plugin.json is used as is.
 */
export function gitManifestUrl(repo: string): string {
  let url: URL;
  const trimmed = repo.trim().replace(/^git\+/, "");
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ManifestError("That is not a repository URL.");
  }
  if (url.protocol !== "https:") throw new ManifestError("Use an https repository URL.");
  if (url.pathname.endsWith(`/${MANIFEST_FILE}`)) return url.toString();
  const parts = url.pathname.split("/").filter(Boolean);
  const clean = (part: string | undefined) => (part ?? "").replace(/\.git$/, "");
  const segment = /^[A-Za-z0-9_.-]{1,100}$/;
  const pathOf = (rest: string[]) => {
    if (!rest.every((part) => segment.test(part) && part !== "..")) throw new ManifestError("The repository path has unsupported characters.");
    return rest.length ? `${rest.join("/")}/` : "";
  };
  const owner = clean(parts[0]);
  const name = clean(parts[1]);
  if (!segment.test(owner) || !segment.test(name)) throw new ManifestError("The URL must name an owner and a repository.");
  switch (url.hostname) {
    case "github.com":
    case "www.github.com": {
      const ref = parts[2] === "tree" || parts[2] === "blob" ? parts[3] : undefined;
      const dir = ref ? pathOf(parts.slice(4)) : "";
      if (ref && !segment.test(ref)) throw new ManifestError("Unsupported branch name.");
      return `https://raw.githubusercontent.com/${owner}/${name}/${ref ?? "HEAD"}/${dir}${MANIFEST_FILE}`;
    }
    case "gitlab.com": {
      const at = parts.indexOf("-");
      const ref = at > 0 && (parts[at + 1] === "tree" || parts[at + 1] === "blob") ? parts[at + 2] : undefined;
      const dir = ref ? pathOf(parts.slice(at + 3)) : "";
      if (ref && !segment.test(ref)) throw new ManifestError("Unsupported branch name.");
      return `https://gitlab.com/${owner}/${name}/-/raw/${ref ?? "HEAD"}/${dir}${MANIFEST_FILE}`;
    }
    case "bitbucket.org": {
      const ref = parts[2] === "src" ? parts[3] : undefined;
      const dir = ref ? pathOf(parts.slice(4)) : "";
      if (ref && !segment.test(ref)) throw new ManifestError("Unsupported branch name.");
      return `https://bitbucket.org/${owner}/${name}/raw/${ref ?? "HEAD"}/${dir}${MANIFEST_FILE}`;
    }
    default:
      throw new ManifestError("Git installs support GitHub, GitLab and Bitbucket. For other hosts, use the raw URL of sibyl-plugin.json.");
  }
}
