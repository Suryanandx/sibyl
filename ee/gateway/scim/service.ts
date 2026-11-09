/**
 * SCIM 2.0 Users and Groups (RFC 7643/7644) — Sibyl Enterprise (licence feature `scim`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Mapping onto Sibyl:
 * - User: a Sibyl account. id = user id, userName = email (lower-cased),
 *   displayName/name.formatted = name, active = not turned off. New users
 *   join the organization as members and the directory's default workspace
 *   with its default role; they sign in through SSO.
 * - DELETE /Users/:id and active=false turn the account off (Sibyl never
 *   deletes people: their chats and records keep their author); every
 *   session ends at once. active=true turns it back on.
 * - Group: a directory group; the group → role rules (Admin → Single
 *   sign-on / Provisioning) turn membership into workspace roles.
 * Supported: filter `<attr> eq "<value>"` (userName, externalId,
 * emails.value, id; groups: displayName, externalId, id), startIndex/count
 * paging, PATCH add/replace/remove (Okta and Microsoft Entra forms).
 */
import { DuplicateEmailError, normalizeEmail, type UserRecord } from "../../../packages/core/src/index";
import { Directory, DirectoryError, type DirectoryGroup } from "../directory/directory";
import type { IdentityContext } from "../directory/context";

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const MAX_PAGE = 200;

/** A SCIM error (RFC 7644 §3.12). */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string
  ) {
    super(message);
    this.name = "ScimError";
  }
}

type Json = Record<string, unknown>;

export interface ListQuery {
  filter?: string;
  startIndex?: string;
  count?: string;
}

/** `attr eq "value"` → [attr, value] (lower-cased attribute). */
export function parseFilter(filter: string | undefined, allowed: string[]): [string, string] | undefined {
  if (!filter || !filter.trim()) return undefined;
  const match = /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!match) throw new ScimError(400, "Only filters of the form attribute eq \"value\" are supported.", "invalidFilter");
  const attribute = match[1]!.toLowerCase();
  if (!allowed.includes(attribute)) throw new ScimError(400, `Filtering on ${match[1]} is not supported.`, "invalidFilter");
  return [attribute, match[2]!.replace(/\\(.)/g, "$1")];
}

function page<T>(items: T[], query: ListQuery): { resources: T[]; startIndex: number; total: number } {
  const startIndex = Math.max(1, Number.parseInt(query.startIndex ?? "1", 10) || 1);
  const count = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(query.count ?? String(MAX_PAGE), 10) || 0));
  return { resources: items.slice(startIndex - 1, startIndex - 1 + count), startIndex, total: items.length };
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return undefined;
}

function text(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

export class ScimService {
  constructor(private readonly context: IdentityContext) {}

  private get directory(): Directory {
    return this.context.directory;
  }

  private get users() {
    return this.context.store.identity.users;
  }

  /* ───────────── users ───────────── */

  async userResource(user: UserRecord, baseUrl: string): Promise<Json> {
    const record = (await this.directory.record(user.id)) ?? {};
    const groups = (await this.directory.listGroups()).filter((g) => g.members.includes(user.id));
    const created = new Date(user.createdAt).toISOString();
    return {
      schemas: [USER_SCHEMA],
      id: user.id,
      ...(record.externalId ? { externalId: record.externalId } : {}),
      userName: user.email,
      displayName: user.name,
      name: {
        formatted: user.name,
        ...(record.givenName ? { givenName: record.givenName } : {}),
        ...(record.familyName ? { familyName: record.familyName } : {})
      },
      emails: [{ value: user.email, type: "work", primary: true }],
      active: user.disabledAt === undefined,
      groups: groups.map((g) => ({ value: g.id, display: g.displayName, $ref: `${baseUrl}/Groups/${g.id}` })),
      meta: { resourceType: "User", created, lastModified: created, location: `${baseUrl}/Users/${user.id}` }
    };
  }

  async listUsers(query: ListQuery, baseUrl: string): Promise<Json> {
    const filter = parseFilter(query.filter, ["username", "externalid", "emails.value", "id"]);
    // People removed from the organization aren't in it any more.
    let users = (await this.users.list(this.context.orgId)).filter((u) => u.removedAt === undefined).sort((a, b) => a.createdAt - b.createdAt);
    if (filter) {
      const [attribute, value] = filter;
      if (attribute === "username" || attribute === "emails.value") users = users.filter((u) => u.email === normalizeEmail(value));
      else if (attribute === "id") users = users.filter((u) => u.id === value);
      else {
        const id = await this.directory.findByExternalId(value);
        users = users.filter((u) => u.id === id);
      }
    }
    const { resources, startIndex, total } = page(users, query);
    return {
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: resources.length,
      Resources: await Promise.all(resources.map((u) => this.userResource(u, baseUrl)))
    };
  }

  async getUser(id: string): Promise<UserRecord> {
    const user = await this.users.get(this.context.orgId, id);
    if (!user || user.removedAt !== undefined) throw new ScimError(404, `User ${id} not found.`);
    return user;
  }

  async createUser(body: Json): Promise<UserRecord> {
    const fields = userFields(body);
    if (!fields.email) throw new ScimError(400, "userName must be the person's email address.", "invalidValue");
    // Someone removed from the organization in Sibyl can be provisioned again (their old account comes back fresh).
    if (await this.directory.activeByEmail(fields.email)) throw new ScimError(409, `A user with userName ${fields.email} already exists.`, "uniqueness");
    if (fields.externalId && (await this.directory.findByExternalId(fields.externalId))) throw new ScimError(409, "A user with this externalId already exists.", "uniqueness");
    const user = await this.directory.provision({
      email: fields.email,
      createdBy: "scim",
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.externalId ? { externalId: fields.externalId } : {}),
      ...(fields.givenName ? { givenName: fields.givenName } : {}),
      ...(fields.familyName ? { familyName: fields.familyName } : {}),
      ...(fields.active === false ? { active: false } : {})
    });
    this.context.log("scim.user_created", { userId: user.id });
    return user;
  }

  /** PUT: replace the attributes Sibyl keeps. */
  async replaceUser(id: string, body: Json): Promise<UserRecord> {
    const user = await this.getUser(id);
    const fields = userFields(body);
    if (!fields.email) throw new ScimError(400, "userName must be the person's email address.", "invalidValue");
    return this.applyUser(user, { ...fields, active: fields.active ?? true });
  }

  async patchUser(id: string, body: Json): Promise<UserRecord> {
    const user = await this.getUser(id);
    const record = (await this.directory.record(user.id)) ?? {};
    const fields: UserFieldsInput = {};
    for (const op of patchOperations(body)) {
      if (op.op === "remove") {
        if (op.path === "externalid") fields.externalId = "";
        else if (op.path === "name.givenname") fields.givenName = "";
        else if (op.path === "name.familyname") fields.familyName = "";
        continue;
      }
      const values: Array<[string, unknown]> = op.path ? [[op.path, op.value]] : Object.entries((op.value as Json) ?? {}).map(([k, v]) => [k.toLowerCase(), v]);
      for (const [path, value] of values) {
        switch (path) {
          case "active":
            fields.active = asBool(value);
            if (fields.active === undefined) throw new ScimError(400, "active must be true or false.", "invalidValue");
            break;
          case "username":
            fields.email = text(value, 254) ? normalizeEmail(text(value, 254)!) : undefined;
            break;
          case "displayname":
          case "name.formatted":
            fields.name = text(value, 80);
            break;
          case "name.givenname":
            fields.givenName = text(value) ?? "";
            break;
          case "name.familyname":
            fields.familyName = text(value) ?? "";
            break;
          case "name": {
            const name = (value ?? {}) as Json;
            if (name.givenName !== undefined) fields.givenName = text(name.givenName) ?? "";
            if (name.familyName !== undefined) fields.familyName = text(name.familyName) ?? "";
            if (name.formatted !== undefined) fields.name = text(name.formatted, 80);
            break;
          }
          case "externalid":
            fields.externalId = text(value) ?? "";
            break;
          case "emails":
          case 'emails[type eq "work"].value':
          case "emails[primary eq true].value": {
            const email = Array.isArray(value) ? text((value.find((e: Json) => e?.primary) ?? value[0])?.value, 254) : text(value, 254);
            if (email) fields.email = normalizeEmail(email);
            break;
          }
          default:
            // Attributes Sibyl doesn't keep (title, phoneNumbers, enterprise extension…) are accepted and ignored.
            break;
        }
      }
    }
    return this.applyUser(user, {
      ...fields,
      // Keep what wasn't patched.
      name: fields.name ?? user.name,
      email: fields.email ?? user.email,
      ...(fields.givenName === undefined && record.givenName ? { givenName: record.givenName } : {}),
      ...(fields.familyName === undefined && record.familyName ? { familyName: record.familyName } : {})
    });
  }

  private async applyUser(user: UserRecord, fields: UserFieldsInput): Promise<UserRecord> {
    let next: UserRecord = { ...user };
    if (fields.email && fields.email !== user.email) {
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/.test(fields.email)) throw new ScimError(400, "userName must be an email address.", "invalidValue");
      next.email = fields.email;
    }
    const name = fields.name ?? ([fields.givenName, fields.familyName].filter(Boolean).join(" ") || undefined);
    if (name) next.name = name.slice(0, 80);
    if (next.email !== user.email || next.name !== user.name) {
      try {
        await this.users.upsert(next);
      } catch (error) {
        if (error instanceof DuplicateEmailError) throw new ScimError(409, `A user with userName ${next.email} already exists.`, "uniqueness");
        throw error;
      }
      this.context.bridge().changed({ kind: "user", userId: user.id });
    }
    if (fields.externalId !== undefined) {
      if (fields.externalId) {
        const other = await this.directory.findByExternalId(fields.externalId);
        if (other && other !== user.id) throw new ScimError(409, "Another user has this externalId.", "uniqueness");
      }
      await this.directory.updateRecord(user.id, { externalId: fields.externalId || undefined });
    }
    if (fields.givenName !== undefined || fields.familyName !== undefined) {
      await this.directory.updateRecord(user.id, {
        ...(fields.givenName !== undefined ? { givenName: fields.givenName || undefined } : {}),
        ...(fields.familyName !== undefined ? { familyName: fields.familyName || undefined } : {})
      });
    }
    if (fields.active === false && next.disabledAt === undefined) next = await this.deactivate(user.id);
    else if (fields.active === true && next.disabledAt !== undefined) next = await this.directory.reactivate(user.id);
    this.context.log("scim.user_updated", { userId: user.id, ...(fields.active !== undefined ? { active: fields.active } : {}) });
    return (await this.users.get(this.context.orgId, user.id)) ?? next;
  }

  async deactivate(id: string): Promise<UserRecord> {
    try {
      const user = await this.directory.deactivate(id);
      this.context.log("scim.user_deactivated", { userId: id });
      return user;
    } catch (error) {
      if (error instanceof DirectoryError) throw new ScimError(error.status, error.message, error.status === 409 ? "mutability" : undefined);
      throw error;
    }
  }

  /* ───────────── groups ───────────── */

  groupResource(group: DirectoryGroup, users: Map<string, UserRecord>, baseUrl: string): Json {
    return {
      schemas: [GROUP_SCHEMA],
      id: group.id,
      ...(group.externalId ? { externalId: group.externalId } : {}),
      displayName: group.displayName,
      members: group.members.map((id) => ({ value: id, display: users.get(id)?.email ?? id, $ref: `${baseUrl}/Users/${id}` })),
      meta: { resourceType: "Group", created: new Date(group.createdAt).toISOString(), lastModified: new Date(group.updatedAt).toISOString(), location: `${baseUrl}/Groups/${group.id}` }
    };
  }

  async userMap(): Promise<Map<string, UserRecord>> {
    return new Map((await this.users.list(this.context.orgId)).map((u) => [u.id, u]));
  }

  async listGroups(query: ListQuery & { excludedAttributes?: string }, baseUrl: string): Promise<Json> {
    const filter = parseFilter(query.filter, ["displayname", "externalid", "id"]);
    let groups = await this.directory.listGroups();
    if (filter) {
      const [attribute, value] = filter;
      groups = groups.filter((g) =>
        attribute === "displayname" ? g.displayName.toLowerCase() === value.toLowerCase() : attribute === "id" ? g.id === value : g.externalId === value
      );
    }
    const { resources, startIndex, total } = page(groups, query);
    const users = await this.userMap();
    const withoutMembers = /\bmembers\b/i.test(query.excludedAttributes ?? "");
    return {
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources.map((g) => {
        const resource = this.groupResource(g, users, baseUrl);
        if (withoutMembers) delete resource.members;
        return resource;
      })
    };
  }

  async getGroup(id: string): Promise<DirectoryGroup> {
    const group = await this.directory.getGroup(id);
    if (!group) throw new ScimError(404, `Group ${id} not found.`);
    return group;
  }

  async createGroup(body: Json): Promise<DirectoryGroup> {
    const displayName = text(body.displayName);
    if (!displayName) throw new ScimError(400, "displayName is required.", "invalidValue");
    return this.saveGroup({ displayName, ...(text(body.externalId) ? { externalId: text(body.externalId)! } : {}), members: memberIds(body.members) });
  }

  async replaceGroup(id: string, body: Json): Promise<DirectoryGroup> {
    await this.getGroup(id);
    const displayName = text(body.displayName);
    if (!displayName) throw new ScimError(400, "displayName is required.", "invalidValue");
    return this.saveGroup({ id, displayName, ...(text(body.externalId) ? { externalId: text(body.externalId)! } : {}), members: memberIds(body.members) });
  }

  async patchGroup(id: string, body: Json): Promise<DirectoryGroup> {
    const group = await this.getGroup(id);
    let displayName = group.displayName;
    let externalId = group.externalId;
    let members = [...group.members];
    for (const op of patchOperations(body)) {
      const memberFilter = /^members\[value eq "([^"]+)"\]$/i.exec(op.rawPath ?? "");
      if (op.path === "members" || memberFilter) {
        const ids = memberFilter ? [memberFilter[1]!] : memberIds(op.value);
        if (op.op === "add") members = [...new Set([...members, ...ids])];
        else if (op.op === "remove") members = op.value === undefined && !memberFilter ? [] : members.filter((m) => !ids.includes(m));
        else members = ids;
        continue;
      }
      const values: Array<[string, unknown]> = op.path ? [[op.path, op.value]] : Object.entries((op.value as Json) ?? {}).map(([k, v]) => [k.toLowerCase(), v]);
      for (const [path, value] of values) {
        if (path === "displayname" && op.op !== "remove") displayName = text(value) ?? displayName;
        else if (path === "externalid") externalId = op.op === "remove" ? undefined : text(value);
        else if (path === "members") members = op.op === "add" ? [...new Set([...members, ...memberIds(value)])] : memberIds(value);
      }
    }
    return this.saveGroup({ id, displayName, ...(externalId ? { externalId } : {}), members });
  }

  private async saveGroup(input: { id?: string; displayName: string; externalId?: string; members: string[] }): Promise<DirectoryGroup> {
    try {
      const group = await this.directory.saveGroup(input);
      this.context.log(input.id ? "scim.group_updated" : "scim.group_created", { groupId: group.id, members: group.members.length });
      return group;
    } catch (error) {
      if (error instanceof DirectoryError) throw new ScimError(error.status, error.message, error.status === 409 ? "uniqueness" : error.status === 404 ? undefined : "invalidValue");
      throw error;
    }
  }

  async deleteGroup(id: string): Promise<void> {
    await this.getGroup(id);
    await this.directory.deleteGroup(id);
    this.context.log("scim.group_deleted", { groupId: id });
  }
}

/* ───────────── parsing ───────────── */

interface UserFieldsInput {
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  externalId?: string;
  active?: boolean;
}

function userFields(body: Json): UserFieldsInput {
  const emails = Array.isArray(body.emails) ? (body.emails as Json[]) : [];
  const primary = emails.find((e) => e?.primary === true) ?? emails[0];
  const userName = text(body.userName, 254);
  const emailCandidate = userName && userName.includes("@") ? userName : text(primary?.value, 254);
  const name = (body.name ?? {}) as Json;
  const givenName = text(name.givenName);
  const familyName = text(name.familyName);
  const display = text(body.displayName, 80) ?? text(name.formatted, 80) ?? ([givenName, familyName].filter(Boolean).join(" ") || undefined);
  const active = asBool(body.active);
  return {
    ...(emailCandidate ? { email: normalizeEmail(emailCandidate) } : {}),
    ...(display ? { name: display } : {}),
    ...(givenName ? { givenName } : {}),
    ...(familyName ? { familyName } : {}),
    ...(text(body.externalId) ? { externalId: text(body.externalId)! } : {}),
    ...(active !== undefined ? { active } : {})
  };
}

function memberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((m) => (typeof m === "object" && m !== null ? (m as Json).value : undefined)).filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 128);
}

interface PatchOperation {
  op: "add" | "replace" | "remove";
  /** Lower-cased path ("" when absent). */
  path?: string;
  rawPath?: string;
  value?: unknown;
}

function patchOperations(body: Json): PatchOperation[] {
  if (!Array.isArray(body.schemas) || !body.schemas.includes(PATCH_SCHEMA)) throw new ScimError(400, `PATCH bodies use the ${PATCH_SCHEMA} schema.`, "invalidSyntax");
  const operations = body.Operations ?? body.operations;
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 1000) throw new ScimError(400, "Operations must be a non-empty list.", "invalidSyntax");
  return operations.map((raw) => {
    const operation = (raw ?? {}) as Json;
    const op = typeof operation.op === "string" ? operation.op.toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") throw new ScimError(400, `Unknown operation ${String(operation.op)}.`, "invalidSyntax");
    const rawPath = typeof operation.path === "string" ? operation.path.trim() : undefined;
    // Drop a schema URN prefix ("urn:…:User:active" → "active").
    const path = rawPath ? rawPath.replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, "").toLowerCase() : undefined;
    return { op, ...(path ? { path, rawPath } : {}), ...(operation.value !== undefined ? { value: operation.value } : {}) };
  });
}
