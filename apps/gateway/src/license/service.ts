/**
 * The running instance's licence: where the key comes from, what it enables.
 *
 * Key sources, in order:
 *   1. SIBYL_LICENSE_KEY (operators; the Settings field is then read-only)
 *   2. the key pasted in Settings → Licence, stored in the kv store
 *      ("license.key", owner scope) so it survives restarts
 *
 * Nothing here talks to the network. The key itself is never logged or sent
 * to the browser.
 */
import {
  FEATURES,
  FEATURE_IDS,
  SIBYL_LICENSE_PUBLIC_KEYS,
  createFeatureGate,
  verifyLicense,
  type FeatureGate,
  type FeatureId,
  type LicenseVerification,
  type Store
} from "@open-gpt-live/core";

export const LICENSE_KV_KEY = "license.key";

export interface LicenseStateView {
  edition: FeatureGate["edition"];
  status: FeatureGate["status"];
  reason?: string;
  features: FeatureId[];
  licensee?: string;
  seats?: number;
  expiresAt?: string;
  /** "env": SIBYL_LICENSE_KEY (cannot be changed from the app). */
  source: "env" | "stored" | "none";
  /** Every enterprise feature, for the Settings list. */
  catalog: Array<{ id: FeatureId; title: string; description: string; enabled: boolean }>;
  /** Enterprise modules load at startup: a restart applies a changed key. */
  restartRequired: boolean;
}

export class LicenseError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface LicenseServiceOptions {
  env: NodeJS.ProcessEnv;
  store: Store;
  ownerId: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Override the embedded public keys (tests only). */
  publicKeys?: readonly string[];
  now?: () => number;
}

export class LicenseService {
  private token: string | undefined;
  private source: LicenseStateView["source"] = "none";
  private verification: LicenseVerification = { valid: false, reason: "missing" };
  private currentGate: FeatureGate = createFeatureGate();
  /** Features the enterprise modules were installed with (set by installLicense). */
  private installedFeatures: string | undefined;
  private readonly listeners = new Set<(state: LicenseStateView) => void>();

  constructor(private readonly options: LicenseServiceOptions) {}

  async init(): Promise<this> {
    const fromEnv = this.options.env.SIBYL_LICENSE_KEY?.trim();
    if (fromEnv) {
      this.token = fromEnv;
      this.source = "env";
    } else {
      const stored = await this.options.store.kv.get<string>(this.options.ownerId, LICENSE_KV_KEY);
      this.token = typeof stored === "string" && stored.trim() ? stored.trim() : undefined;
      this.source = this.token ? "stored" : "none";
    }
    this.evaluate();
    return this;
  }

  /** Current gate (re-checked when the key reaches its expiry). */
  get gate(): FeatureGate {
    const expiresAt = this.verification.valid ? this.verification.payload?.expiresAt : undefined;
    if (expiresAt && Date.parse(expiresAt) <= this.now()) {
      this.evaluate();
      this.options.log?.("license.expired", { licensee: this.currentGate.licensee, expiresAt });
      this.emit();
    }
    return this.currentGate;
  }

  /** Remember which features the enterprise modules were installed with. */
  markInstalled(): void {
    this.installedFeatures = this.currentGate.features.join(",");
  }

  state(): LicenseStateView {
    const gate = this.gate;
    return {
      edition: gate.edition,
      status: gate.status,
      ...(gate.reason ? { reason: gate.reason } : {}),
      features: gate.features,
      ...(gate.licensee !== undefined ? { licensee: gate.licensee } : {}),
      ...(gate.seats !== undefined ? { seats: gate.seats } : {}),
      ...(gate.expiresAt !== undefined ? { expiresAt: gate.expiresAt } : {}),
      source: this.source,
      catalog: FEATURE_IDS.map((id) => ({ id, ...FEATURES[id], enabled: gate.has(id) })),
      restartRequired: this.installedFeatures !== undefined && this.installedFeatures !== gate.features.join(",")
    };
  }

  /** Store a pasted key. Only a currently valid key is accepted. */
  async setKey(raw: unknown): Promise<LicenseStateView> {
    if (this.source === "env") {
      throw new LicenseError(409, "managed_by_env", "The licence key is set with SIBYL_LICENSE_KEY on the server; change it there.");
    }
    const token = typeof raw === "string" ? raw.trim() : "";
    const result = verifyLicense(token, this.publicKeys(), this.now());
    if (!result.valid) {
      throw new LicenseError(400, result.reason ?? "invalid", describeFailure(result.reason));
    }
    await this.options.store.kv.set(this.options.ownerId, LICENSE_KV_KEY, token);
    this.token = token;
    this.source = "stored";
    this.evaluate();
    this.log("license.updated");
    this.emit();
    return this.state();
  }

  /** Remove a stored key (back to the open-source edition). */
  async clearKey(): Promise<LicenseStateView> {
    if (this.source === "env") {
      throw new LicenseError(409, "managed_by_env", "The licence key is set with SIBYL_LICENSE_KEY on the server; remove it there.");
    }
    await this.options.store.kv.delete(this.options.ownerId, LICENSE_KV_KEY);
    this.token = undefined;
    this.source = "none";
    this.evaluate();
    this.log("license.removed");
    this.emit();
    return this.state();
  }

  subscribe(listener: (state: LicenseStateView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Startup log line: edition, status and features. Never the key. */
  logLoaded(): void {
    this.log("license.loaded");
  }

  private log(event: string): void {
    const gate = this.currentGate;
    this.options.log?.(event, {
      edition: gate.edition,
      status: gate.status,
      ...(gate.reason ? { reason: gate.reason } : {}),
      source: this.source,
      features: gate.features,
      ...(gate.licensee ? { licensee: gate.licensee, seats: gate.seats, expiresAt: gate.expiresAt } : {})
    });
  }

  private evaluate(): void {
    this.verification = verifyLicense(this.token, this.publicKeys(), this.now());
    this.currentGate = createFeatureGate(this.verification);
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // a closed session must not break the others
      }
    }
  }

  private publicKeys(): readonly string[] {
    return this.options.publicKeys ?? SIBYL_LICENSE_PUBLIC_KEYS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function describeFailure(reason: string | undefined): string {
  switch (reason) {
    case "missing":
      return "Paste a licence key.";
    case "expired":
      return "This licence key has expired.";
    case "not_yet_valid":
      return "This licence key is not valid yet (check the server clock).";
    case "bad_signature":
      return "This licence key was not issued for Sibyl Enterprise (signature check failed).";
    case "unsupported_version":
      return "This licence key format is not supported by this version of Sibyl.";
    default:
      return "This is not a valid Sibyl licence key.";
  }
}
