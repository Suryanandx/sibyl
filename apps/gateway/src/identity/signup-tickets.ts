/**
 * Sign-up tickets: proof that someone verified their email address (link,
 * code, Google or Microsoft) and may now create an organization.
 *
 * - Sealed with AES-256-GCM under a key derived (HKDF) from the secrets
 *   master key, so the content (it can carry the password's scrypt hash)
 *   is neither readable nor changeable by the browser holding it.
 * - Short-lived (30 minutes) and single-use: `redeem()` records the ticket's
 *   id once its organization exists, and `verify()` refuses it from then on.
 *   Redeemed ids are kept (in the store) until the ticket would have expired.
 *
 * Implements core's SignupTicketVerifier; POST /api/orgs (tenancy/hosted.ts)
 * verifies and redeems, the operator API issues tickets for tests.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { normalizeEmail, type SignupTicket, type SignupTicketVerifier, type Store } from "@open-gpt-live/core";

export const SIGNUP_TICKET_TTL_MS = 30 * 60_000;
/** Platform-level records (no organization yet) live under this store owner. */
export const SIGNUP_OWNER = "_signup";
const USED_KEY = "signup.tickets.redeemed.v1";
const PROVIDERS = new Set<SignupTicket["provider"]>(["password", "magic_link", "google", "microsoft"]);

interface Sealed {
  t: SignupTicket;
  /** Ticket id (single use). */
  j: string;
  /** Expiry (ms). */
  x: number;
}

export class SignupTickets implements SignupTicketVerifier {
  private readonly key: Buffer;
  private readonly now: () => number;
  /** Serializes writes of the redeemed list. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    master: Buffer,
    private readonly store: Pick<Store, "kv">,
    now: () => number = Date.now
  ) {
    this.key = Buffer.from(hkdfSync("sha256", master, Buffer.from("sibyl.signup-ticket.v2", "utf8"), Buffer.alloc(0), 32));
    this.now = now;
  }

  issue(ticket: SignupTicket, ttlMs = SIGNUP_TICKET_TTL_MS): { ticket: string; expiresAt: number } {
    const expiresAt = this.now() + ttlMs;
    const body: Sealed = { t: { ...ticket, email: normalizeEmail(ticket.email) }, j: randomBytes(12).toString("base64url"), x: expiresAt };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const sealed = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    return { ticket: [iv, sealed, cipher.getAuthTag()].map((part) => part.toString("base64url")).join("."), expiresAt };
  }

  /** The ticket and its expiry, or undefined (tampered, expired, malformed or already redeemed). */
  async open(ticket: string): Promise<{ ticket: SignupTicket; expiresAt: number; id: string } | undefined> {
    const sealed = this.unseal(ticket);
    if (!sealed || sealed.x <= this.now()) return undefined;
    if ((await this.redeemed()).some((entry) => entry.j === sealed.j)) return undefined;
    return { ticket: sealed.t, expiresAt: sealed.x, id: sealed.j };
  }

  async verify(ticket: string): Promise<SignupTicket | undefined> {
    return (await this.open(ticket))?.ticket;
  }

  async redeem(ticket: string): Promise<void> {
    const sealed = this.unseal(ticket);
    if (!sealed) return;
    const write = this.writing.then(async () => {
      const now = this.now();
      const kept = (await this.redeemed()).filter((entry) => entry.x > now && entry.j !== sealed.j);
      await this.store.kv.set(SIGNUP_OWNER, USED_KEY, [...kept, { j: sealed.j, x: sealed.x }]);
    });
    this.writing = write.catch(() => undefined);
    await write;
  }

  private async redeemed(): Promise<Array<{ j: string; x: number }>> {
    const list = await this.store.kv.get<Array<{ j: string; x: number }>>(SIGNUP_OWNER, USED_KEY);
    return Array.isArray(list) ? list : [];
  }

  private unseal(ticket: string): Sealed | undefined {
    if (typeof ticket !== "string" || ticket.length > 4096) return undefined;
    const parts = ticket.split(".");
    if (parts.length !== 3) return undefined;
    try {
      const [iv, data, tag] = parts.map((part) => Buffer.from(part, "base64url")) as [Buffer, Buffer, Buffer];
      if (iv.length !== 12 || tag.length !== 16) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const body = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as Partial<Sealed>;
      const t = body.t;
      if (!t || typeof t.email !== "string" || !PROVIDERS.has(t.provider) || typeof body.j !== "string" || typeof body.x !== "number") return undefined;
      return body as Sealed;
    } catch {
      return undefined;
    }
  }
}
