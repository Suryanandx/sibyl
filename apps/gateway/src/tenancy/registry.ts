/**
 * The tenant registry: one runtime per organization.
 *
 * - Self-hosted: exactly one tenant ("owner"), built eagerly, never unloaded
 *   for being idle (it is rebuilt when its model key changes).
 * - Hosted: a tenant is built on first use (a request, a connection, a due
 *   job) from the same createRuntime code. Tenants share the one store
 *   connection and usage meter; each has its own services, bound to its
 *   organization.
 * - Idle tenants (no open connection, no running job, no request for
 *   SIBYL_TENANT_IDLE_MINUTES) are unloaded.
 * - One scheduler loop: every tick it wakes organizations with due work
 *   (routines, monitors) and then runs one scheduling pass in every loaded
 *   tenant. Jobs carry their organization: each runs in its own tenant.
 */

export interface TenantHandle {
  orgId: string;
  /** Running scheduled work (a routine run, a monitor check): not idle. */
  busy(): boolean;
  /** One scheduling pass (hosted: driven by the registry's loop). */
  tick?(): Promise<void>;
  close(): Promise<void>;
}

export interface TenantRegistryOptions<T extends TenantHandle> {
  hosted: boolean;
  build(orgId: string): Promise<T>;
  /** Organizations with work due now (wakes unloaded tenants). */
  dueOrganizations?(now: number): Promise<string[]>;
  idleMs?: number;
  tickMs?: number;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface Entry<T> {
  orgId: string;
  loading: Promise<T>;
  tenant?: T;
  holds: number;
  lastUsedAt: number;
}

export const DEFAULT_TENANT_IDLE_MS = 15 * 60_000;
export const SCHEDULER_TICK_MS = 30_000;

export function tenantIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.SIBYL_TENANT_IDLE_MINUTES?.trim();
  if (!raw) return DEFAULT_TENANT_IDLE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("SIBYL_TENANT_IDLE_MINUTES must be a positive number of minutes");
  return Math.round(minutes * 60_000);
}

export class TenantRegistry<T extends TenantHandle> {
  readonly hosted: boolean;
  private readonly entries = new Map<string, Entry<T>>();
  private readonly unloadListeners = new Set<(orgId: string) => void>();
  private readonly reloads = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private readonly idleMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: TenantRegistryOptions<T>) {
    this.hosted = options.hosted;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.idleMs = options.idleMs ?? DEFAULT_TENANT_IDLE_MS;
  }

  /** The tenant of an organization, built on first use. */
  async get(orgId: string): Promise<T> {
    if (this.closed) throw new Error("the gateway is shutting down");
    await this.reloads.get(orgId);
    let entry = this.entries.get(orgId);
    if (!entry) {
      const created: Entry<T> = { orgId, holds: 0, lastUsedAt: this.now(), loading: Promise.resolve(undefined as unknown as T) };
      created.loading = this.load(created);
      this.entries.set(orgId, created);
      entry = created;
    }
    entry.lastUsedAt = this.now();
    return entry.loading;
  }

  /** A loaded tenant, without loading it. */
  peek(orgId: string): T | undefined {
    return this.entries.get(orgId)?.tenant;
  }

  loaded(): T[] {
    return [...this.entries.values()].flatMap((entry) => (entry.tenant ? [entry.tenant] : []));
  }

  /** Keep a tenant loaded while something (a WebSocket connection) uses it. Returns the release. */
  hold(orgId: string): () => void {
    const entry = this.entries.get(orgId);
    if (!entry) return () => undefined;
    entry.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holds = Math.max(0, entry.holds - 1);
      entry.lastUsedAt = this.now();
    };
  }

  touch(orgId: string): void {
    const entry = this.entries.get(orgId);
    if (entry) entry.lastUsedAt = this.now();
  }

  /** Listeners run when a tenant is unloaded (idle, reload, shutdown): close its connections. */
  onUnload(listener: (orgId: string) => void): () => void {
    this.unloadListeners.add(listener);
    return () => this.unloadListeners.delete(listener);
  }

  /**
   * Rebuild a tenant (its model key changed). Coalesced: several requests
   * in a row rebuild once. The next get() waits for it.
   */
  reload(orgId: string): Promise<void> {
    const pending = this.reloads.get(orgId);
    if (pending) return pending;
    const run = new Promise<void>((resolve) => setTimeout(resolve, 50))
      .then(async () => {
        const entry = this.entries.get(orgId);
        if (!entry) return;
        this.log("tenancy.reloading", { orgId });
        await this.unload(entry, "reload");
        // Self-hosted: the one tenant is always there.
        if (!this.hosted && !this.closed) {
          const created: Entry<T> = { orgId, holds: 0, lastUsedAt: this.now(), loading: Promise.resolve(undefined as unknown as T) };
          created.loading = this.load(created);
          this.entries.set(orgId, created);
          await created.loading.catch(() => undefined);
        }
      })
      .finally(() => this.reloads.delete(orgId));
    this.reloads.set(orgId, run);
    return run;
  }

  /** Hosted: start the scheduler loop and the idle sweep. */
  start(tickMs = this.options.tickMs ?? SCHEDULER_TICK_MS): void {
    if (!this.hosted || this.timer) return;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** One pass: wake organizations with due work, run each loaded tenant's scheduler, unload idle ones. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /** Unload tenants nobody used for idleMs (tests call it directly). */
  async sweep(now = this.now()): Promise<string[]> {
    const unloaded: string[] = [];
    for (const entry of [...this.entries.values()]) {
      if (!this.hosted || !entry.tenant || entry.holds > 0 || now - entry.lastUsedAt < this.idleMs || this.reloads.has(entry.orgId)) continue;
      if (entry.tenant.busy()) {
        entry.lastUsedAt = now;
        continue;
      }
      await this.unload(entry, "idle");
      unloaded.push(entry.orgId);
    }
    return unloaded;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => undefined);
    await Promise.allSettled([...this.reloads.values()]);
    for (const entry of [...this.entries.values()]) await this.unload(entry, "shutdown");
  }

  private async load(entry: Entry<T>): Promise<T> {
    const startedAt = this.now();
    try {
      const tenant = await this.options.build(entry.orgId);
      if (this.entries.get(entry.orgId) !== entry || this.closed) {
        // Unloaded or shutting down while it was being built.
        await tenant.close().catch(() => undefined);
        throw new Error("the organization was unloaded while loading");
      }
      entry.tenant = tenant;
      this.log("tenancy.loaded", { orgId: entry.orgId, ms: this.now() - startedAt, loaded: this.entries.size });
      return tenant;
    } catch (error) {
      if (this.entries.get(entry.orgId) === entry) this.entries.delete(entry.orgId);
      this.log("tenancy.load_failed", { orgId: entry.orgId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async unload(entry: Entry<T>, reason: "idle" | "reload" | "shutdown"): Promise<void> {
    if (this.entries.get(entry.orgId) === entry) this.entries.delete(entry.orgId);
    const tenant = entry.tenant ?? (await entry.loading.catch(() => undefined));
    if (!tenant) return;
    for (const listener of this.unloadListeners) {
      try {
        listener(entry.orgId);
      } catch {
        // A listener never stops the unload.
      }
    }
    try {
      await tenant.close();
    } catch (error) {
      this.log("tenancy.close_failed", { orgId: entry.orgId, error: error instanceof Error ? error.message : String(error) });
    }
    this.log("tenancy.unloaded", { orgId: entry.orgId, reason, loaded: this.entries.size });
  }

  private async pass(): Promise<void> {
    if (this.closed) return;
    try {
      const due = (await this.options.dueOrganizations?.(this.now())) ?? [];
      for (const orgId of new Set(due)) {
        if (!this.entries.has(orgId)) await this.get(orgId).catch(() => undefined);
      }
    } catch (error) {
      this.log("tenancy.wake_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    await Promise.allSettled(this.loaded().map((tenant) => tenant.tick?.()));
    await this.sweep();
  }
}
