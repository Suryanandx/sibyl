/**
 * SCIM bearer tokens — Sibyl Enterprise (licence feature `scim`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * The identity provider authenticates with `Authorization: Bearer <token>`.
 * Tokens belong to the organization, are shown once when created, and only
 * their SHA-256 is stored (`store.kv` `ee.scim.v1`). Several can exist at
 * once, so a token can be rotated without downtime.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Store } from "../../../packages/core/src/index";
import type { ScimTokenView } from "../../../packages/protocol/src/index";
import { DirectoryError } from "../directory/directory";

export const SCIM_KV_KEY = "ee.scim.v1";
const MAX_TOKENS = 10;
/** lastUsedAt is written at most this often. */
const TOUCH_MS = 5 * 60_000;

interface StoredToken {
  id: string;
  label: string;
  prefix: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export class ScimTokens {
  private cache: StoredToken[] | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { store: Store; orgId: string; now?: () => number }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async all(): Promise<StoredToken[]> {
    this.cache ??= (await this.options.store.kv.get<{ tokens?: StoredToken[] }>(this.options.orgId, SCIM_KV_KEY))?.tokens ?? [];
    return this.cache;
  }

  private save(change: (tokens: StoredToken[]) => StoredToken[]): Promise<void> {
    const run = this.writes.catch(() => undefined).then(async () => {
      const next = change([...(await this.all())]);
      await this.options.store.kv.set(this.options.orgId, SCIM_KV_KEY, { tokens: next });
      this.cache = next;
    });
    this.writes = run;
    return run;
  }

  async list(): Promise<ScimTokenView[]> {
    return (await this.all()).map(({ hash: _hash, ...view }) => view);
  }

  /** A new token; the secret is returned this once. */
  async create(label: unknown): Promise<{ token: ScimTokenView; secret: string }> {
    const name = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : "SCIM token";
    if ((await this.all()).length >= MAX_TOKENS) throw new DirectoryError(400, "too_many", `Up to ${MAX_TOKENS} SCIM tokens. Revoke an old one first.`);
    const secret = `scim_${randomBytes(32).toString("base64url")}`;
    const record: StoredToken = { id: randomUUID(), label: name, prefix: secret.slice(0, 10), hash: sha256(secret), createdAt: this.now() };
    await this.save((tokens) => [...tokens, record]);
    const { hash: _hash, ...view } = record;
    return { token: view, secret };
  }

  async revoke(id: string): Promise<void> {
    if (!(await this.all()).some((t) => t.id === id)) throw new DirectoryError(404, "not_found", "No such token.");
    await this.save((tokens) => tokens.filter((t) => t.id !== id));
  }

  /** The token's id when `secret` is a current token. */
  async verify(secret: string | undefined): Promise<string | undefined> {
    if (!secret || !secret.startsWith("scim_") || secret.length > 200) return undefined;
    const hash = sha256(secret);
    const token = (await this.all()).find((t) => t.hash === hash);
    if (!token) return undefined;
    const now = this.now();
    if (!token.lastUsedAt || now - token.lastUsedAt > TOUCH_MS) {
      void this.save((tokens) => tokens.map((t) => (t.id === token.id ? { ...t, lastUsedAt: now } : t))).catch(() => undefined);
    }
    return token.id;
  }
}
