/**
 * Organizations (hosted Sibyl): creating one with its owner and first
 * workspace, and listing the organizations a person belongs to.
 *
 * Creating an organization needs a verified email address: a sign-up
 * ticket (core's SignupTicketVerifier) issued by the sign-up layer
 * (identity/signup.ts) after it verified the address; the operator API
 * issues the same tickets for tests.
 */
import { ORG_SETTINGS_KV_KEY, normalizeEmail, readOrgSettings, usdToMicros, type ExternalLogin, type OrganizationRecord, type Store, type UserRecord } from "@open-gpt-live/core";
import type { OrganizationView } from "@open-gpt-live/protocol";
import { SignupTickets } from "../identity/signup-tickets.js";
import { loadMasterKey } from "../secrets/crypto.js";
import { newOrgId } from "./mode.js";

export const ORG_NAME_MAX = 80;

export class OrganizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type { OrganizationView };

export interface CreateOrganizationInput {
  name: unknown;
  workspaceName?: unknown;
  owner: { email: unknown; name?: unknown; password?: unknown; passwordHash?: string; link?: Omit<ExternalLogin, "linkedAt"> };
  /** The address the sign-up layer verified; must be the owner's. */
  verifiedEmail: string;
}

/** Creates the owner inside the new organization (its identity service) and signs them in. */
export type CreateOwner = (orgId: string, input: { email: unknown; name: unknown; password?: unknown; passwordHash?: string; workspaceName?: string; emailVerifiedAt: number; link?: Omit<ExternalLogin, "linkedAt"> }) => Promise<{ user: UserRecord; token: string }>;

export class OrganizationService {
  /** Sign-up tickets (identity/signup-tickets.ts): issued by the sign-up layer and the operator API, redeemed here. */
  readonly tickets: SignupTickets;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      store: Store;
      env: NodeJS.ProcessEnv;
      now?: () => number;
      log?: (event: string, fields?: Record<string, unknown>) => void;
    }
  ) {
    this.now = options.now ?? Date.now;
    this.tickets = new SignupTickets(loadMasterKey(options.env).key, options.store, this.now);
  }

  /** Welcome credits granted to every new organization (SIBYL_CREDITS_WELCOME_USD, default 0). */
  welcomeCreditsUsd(): number {
    const raw = this.options.env.SIBYL_CREDITS_WELCOME_USD?.trim();
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) && value > 0 ? Math.min(value, 1_000) : 0;
  }

  /** A new organization, its owner (signed in, through the organization's identity service) and its first workspace. */
  async create(input: CreateOrganizationInput, createOwner: CreateOwner): Promise<{ organization: OrganizationRecord; user: UserRecord; token: string }> {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, ORG_NAME_MAX) : "";
    if (!name) throw new OrganizationError(400, "name_required", "Give your organization a name.");
    const email = typeof input.owner.email === "string" ? normalizeEmail(input.owner.email) : "";
    if (!email || normalizeEmail(input.verifiedEmail) !== email) {
      throw new OrganizationError(403, "email_not_verified", "Verify your email address first.");
    }
    const workspaceName = typeof input.workspaceName === "string" ? input.workspaceName.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const at = this.now();
    const organization: OrganizationRecord = { id: newOrgId(), name, createdAt: at };
    await this.options.store.organizations.create(organization);
    // Admin → Organization shows and edits the same name.
    await this.options.store.kv.set(organization.id, ORG_SETTINGS_KV_KEY, { ...(await readOrgSettings(this.options.store, organization.id)), name, updatedAt: at });
    // Granted before the organization's runtime first loads its balance.
    const welcome = this.welcomeCreditsUsd();
    if (welcome > 0) {
      await this.options.store.credits.append({ orgId: organization.id, idempotencyKey: "welcome", kind: "grant", amountMicros: usdToMicros(welcome), at, note: "Welcome credits" });
    }
    const { user, token } = await createOwner(organization.id, {
      email,
      name: input.owner.name,
      ...(input.owner.passwordHash ? { passwordHash: input.owner.passwordHash } : { password: input.owner.password }),
      ...(workspaceName ? { workspaceName } : {}),
      ...(input.owner.link ? { link: input.owner.link } : {}),
      emailVerifiedAt: at
    });
    const created = { ...organization, createdBy: user.id };
    await this.options.store.organizations.update(created);
    this.options.log?.("tenancy.organization_created", { orgId: organization.id, userId: user.id, welcomeUsd: welcome });
    return { organization: created, user, token };
  }

  /**
   * The organizations this person belongs to: every organization with an
   * active account for the same (verified) address. Without a verified
   * address, only the current one.
   */
  async listFor(user: UserRecord): Promise<OrganizationView[]> {
    const accounts = user.emailVerifiedAt === undefined ? [user] : (await this.options.store.identity.users.listByEmail(user.email)).filter((u) => u.disabledAt === undefined && u.removedAt === undefined);
    const records = await this.options.store.organizations.getMany(accounts.map((account) => account.orgId));
    const views: OrganizationView[] = [];
    for (const record of records) {
      const account = accounts.find((a) => a.orgId === record.id)!;
      const role = (await this.options.store.identity.memberships.listForUser(record.id, account.id)).find((m) => m.scope === "org")?.role;
      views.push({ id: record.id, name: record.name, current: record.id === user.orgId, ...(role ? { role } : {}) });
    }
    return views;
  }
}
