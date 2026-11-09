/**
 * AI credits: a prepaid balance per organization for model calls that run on
 * the platform's OpenRouter key (hosted organizations without their own key).
 *
 * - The ledger (`store.credits`) is append-only: grant, purchase, charge,
 *   refund, each with an idempotency key, in micro-USD.
 * - Every metered call of an organization in credits mode is charged: the
 *   cost OpenRouter reported (`usage.cost`, else the meter's estimate) plus
 *   SIBYL_CREDITS_MARGIN (a fraction, default 0).
 * - The usage policy blocks new calls once the balance is empty (scope
 *   "credits": the app shows "Add credits").
 * - Buying credits goes through a PaymentProvider. Only the test provider
 *   exists so far (SIBYL_PAYMENTS=test; never in production); platform
 *   operators grant credits with the platform API.
 */
import { randomUUID } from "node:crypto";
import { MICROS_PER_USD, microsToUsd, usdToMicros, type CreditEntry, type CreditEntryKind, type Store, type UsageEvent, type UsagePolicy } from "@open-gpt-live/core";
import type { CreditsView } from "@open-gpt-live/protocol";

export const CREDITS_BLOCKED_MESSAGE = "Your AI credits are used up. Add credits, or add your own OpenRouter key in Settings → Models.";
/** Largest single grant or purchase (USD). */
export const MAX_CREDIT_USD = 10_000;

export type { CreditsView };

export function creditsMargin(env: NodeJS.ProcessEnv): number {
  const raw = env.SIBYL_CREDITS_MARGIN?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error("SIBYL_CREDITS_MARGIN must be a fraction between 0 and 10 (0.2 = 20%)");
  return value;
}

/* ───────────── payment providers ───────────── */

export interface PaymentResult {
  status: "completed" | "pending";
  /** The provider's payment id: the ledger entry's idempotency key, so a retried webhook adds credits once. */
  paymentId: string;
  /** Where to send the person to pay (real providers). */
  checkoutUrl?: string;
}

/** The hook a payment provider plugs into (the real one is chosen later; see docs/hosting.md). */
export interface PaymentProvider {
  readonly id: string;
  purchase(input: { orgId: string; amountUsd: number; requestedBy: string }): Promise<PaymentResult>;
}

/** Completes every purchase at once without charging anyone. For development and tests only. */
export class TestPaymentProvider implements PaymentProvider {
  readonly id = "test";
  async purchase(): Promise<PaymentResult> {
    return { status: "completed", paymentId: `test-${randomUUID()}` };
  }
}

export function paymentProviderFromEnv(env: NodeJS.ProcessEnv): PaymentProvider | undefined {
  const name = env.SIBYL_PAYMENTS?.trim().toLowerCase();
  if (!name || name === "off" || name === "none") return undefined;
  if (name === "test") return new TestPaymentProvider();
  throw new Error(`SIBYL_PAYMENTS="${name}" is not a payment provider this build knows (only "test")`);
}

/* ───────────── the ledger, per organization ───────────── */

export interface CreditsServiceOptions {
  store: Store;
  orgId: string;
  /** Model calls run on the platform key (no BYOK key): charge and gate them. */
  active: boolean;
  margin: number;
  payments?: PaymentProvider;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class CreditsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class CreditsService {
  readonly orgId: string;
  readonly active: boolean;
  private balance = 0;
  private readonly now: () => number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private writes = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: CreditsServiceOptions) {
    this.orgId = options.orgId;
    this.active = options.active;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** Read the balance from the ledger (the policy's check is synchronous). */
  async load(): Promise<this> {
    this.balance = await this.options.store.credits.balance(this.orgId);
    return this;
  }

  balanceUsd(): number {
    return microsToUsd(this.balance);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Add credits (grant, purchase, refund). Returns false when the idempotency key was already used. */
  async add(input: { kind: Exclude<CreditEntryKind, "charge">; amountUsd: number; idempotencyKey?: string; note?: string; reference?: string }): Promise<boolean> {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0 || input.amountUsd > MAX_CREDIT_USD) {
      throw new CreditsError(400, "invalid_amount", `Enter an amount between 0 and ${MAX_CREDIT_USD} USD.`);
    }
    const key = input.idempotencyKey?.trim() || `${input.kind}-${randomUUID()}`;
    if (key.length > 200) throw new CreditsError(400, "invalid_key", "The idempotency key is too long.");
    const added = await this.append({
      orgId: this.orgId,
      idempotencyKey: key,
      kind: input.kind,
      amountMicros: usdToMicros(input.amountUsd),
      at: this.now(),
      ...(input.reference ? { reference: input.reference.slice(0, 200) } : {}),
      ...(input.note ? { note: input.note.slice(0, 200) } : {})
    });
    this.log("credits.added", { orgId: this.orgId, kind: input.kind, amountUsd: input.amountUsd, added });
    return added;
  }

  /** Buy credits through the payment provider (test provider: added at once). */
  async purchase(amountUsd: number, requestedBy: string): Promise<PaymentResult & { balanceUsd: number }> {
    const provider = this.options.payments;
    if (!provider) throw new CreditsError(501, "payments_unavailable", "Buying credits isn't available yet. Ask the Sibyl team, or add your own OpenRouter key.");
    if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > MAX_CREDIT_USD) throw new CreditsError(400, "invalid_amount", `Buy between 1 and ${MAX_CREDIT_USD} USD of credits.`);
    const result = await provider.purchase({ orgId: this.orgId, amountUsd, requestedBy });
    if (result.status === "completed") {
      await this.add({ kind: "purchase", amountUsd, idempotencyKey: result.paymentId, reference: `${provider.id}:${result.paymentId}`, note: "Credits bought" });
    }
    return { ...result, balanceUsd: this.balanceUsd() };
  }

  /**
   * The ledger charge for one recorded model call (cost + margin), or
   * undefined when this call isn't paid with credits. The meter writes it in
   * the same store transaction as the usage event, so a restart never loses
   * a charge, and its idempotency key (`usage:<event id>`) never counts one
   * twice.
   */
  chargeFor(event: UsageEvent): CreditEntry | undefined {
    if (!this.active || event.ownerId !== this.orgId || !(event.costUsd > 0)) return undefined;
    const micros = Math.max(1, Math.round(event.costUsd * (1 + this.options.margin) * MICROS_PER_USD));
    return {
      orgId: this.orgId,
      idempotencyKey: `usage:${event.id}`,
      kind: "charge",
      amountMicros: -micros,
      at: event.at,
      reference: event.id,
      note: `${event.feature} · ${event.model}`.slice(0, 200)
    };
  }

  /**
   * The usage policy: blocks new calls when the balance is empty, and
   * charges every recorded call (in the usage event's own transaction). The
   * cached balance follows the charge at once; load() reads the ledger again.
   */
  policy(): UsagePolicy {
    return {
      check: (input) => {
        if (!this.active || input.ownerId !== this.orgId) return undefined;
        return this.balance > 0 ? undefined : { allowed: false, scope: "credits", message: CREDITS_BLOCKED_MESSAGE };
      },
      charge: (event) => this.chargeFor(event),
      recorded: (event) => {
        const entry = this.chargeFor(event);
        if (!entry) return;
        this.balance += entry.amountMicros;
        for (const listener of this.listeners) listener();
      }
    };
  }

  async view(limit = 20): Promise<CreditsView> {
    await this.writes;
    const entries = await this.options.store.credits.list(this.orgId, limit);
    return {
      balanceUsd: this.balanceUsd(),
      active: this.active,
      marginPercent: Math.round(this.options.margin * 1000) / 10,
      purchase: this.options.payments ? { available: true, provider: this.options.payments.id } : { available: false },
      entries: entries.map((entry) => ({ kind: entry.kind, amountUsd: microsToUsd(entry.amountMicros), at: entry.at, ...(entry.note ? { note: entry.note } : {}) }))
    };
  }

  /** Appends are serialized so the cached balance always equals the ledger's sum. */
  private append(entry: CreditEntry): Promise<boolean> {
    const run = this.writes.then(async () => {
      const added = await this.options.store.credits.append(entry);
      if (added) this.balance += entry.amountMicros;
      return added;
    });
    this.writes = run.then(
      () => undefined,
      () => undefined
    );
    void run.then((added) => {
      if (added) for (const listener of this.listeners) listener();
    }, () => undefined);
    return run;
  }
}
