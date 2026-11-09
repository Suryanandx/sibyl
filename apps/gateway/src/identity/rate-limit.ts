/**
 * Login rate limiting: failed attempts are counted per IP + email and per IP
 * alone inside a sliding window. A successful login clears the IP + email
 * counter. In memory only — a restart forgets, which is fine for one
 * gateway process.
 */
export interface RateLimitOptions {
  /** Window length (default 15 minutes). */
  windowMs?: number;
  /** Failed attempts allowed per IP + email inside the window (default 5). */
  perAccount?: number;
  /** Failed attempts allowed per IP inside the window (default 30). */
  perIp?: number;
  now?: () => number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly perAccount: number;
  private readonly perIp: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions = {}) {
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.perAccount = options.perAccount ?? 5;
    this.perIp = options.perIp ?? 30;
    this.now = options.now ?? Date.now;
  }

  /** Seconds until another attempt is allowed (0: allowed now). */
  retryAfter(ip: string, email: string): number {
    const account = this.recent(`a:${ip}|${email}`);
    const byIp = this.recent(`i:${ip}`);
    const blockedUntil = Math.max(
      account.length >= this.perAccount ? account[account.length - this.perAccount]! + this.windowMs : 0,
      byIp.length >= this.perIp ? byIp[byIp.length - this.perIp]! + this.windowMs : 0
    );
    return Math.max(0, Math.ceil((blockedUntil - this.now()) / 1000));
  }

  fail(ip: string, email: string): void {
    const at = this.now();
    for (const key of [`a:${ip}|${email}`, `i:${ip}`]) this.attempts.set(key, [...this.recent(key), at]);
    if (this.attempts.size > 10_000) this.sweep();
  }

  succeed(ip: string, email: string): void {
    this.attempts.delete(`a:${ip}|${email}`);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.attempts.get(key) ?? []).filter((at) => at > cutoff);
    if (list.length === 0) this.attempts.delete(key);
    return list;
  }

  private sweep(): void {
    for (const key of [...this.attempts.keys()]) this.recent(key);
  }
}
