/**
 * HubSpot CRM connector — Sibyl Enterprise (licence feature `connector_hubspot`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Contacts, companies and deals (search, get, create, update), notes and
 * associations through the CRM v3/v4 APIs. Connect with OAuth (the
 * organization's public app) or a private app access token.
 */
import {
  int,
  objectSchema,
  optionalInt,
  optionalString,
  requireId,
  requireString,
  seg,
  str,
  strList
} from "../../../apps/gateway/src/connectors/common";
import { ConnectorError, type ConnectorAction, type ConnectorActionContext, type ConnectorDefinition, type JsonSchema } from "../../../apps/gateway/src/connectors/types";

const OBJECTS = ["contacts", "companies", "deals"] as const;
type CrmObject = (typeof OBJECTS)[number];

/** Default properties per object (enough for the model to tell records apart). */
const DEFAULT_PROPERTIES: Record<CrmObject, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage", "hs_lead_status", "lastmodifieddate"],
  companies: ["name", "domain", "industry", "city", "country", "numberofemployees", "annualrevenue", "lifecyclestage", "lastmodifieddate"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "lastmodifieddate"]
};

/** HubSpot-defined association type ids: note → object. */
const NOTE_ASSOCIATION: Record<CrmObject, number> = { contacts: 202, companies: 190, deals: 214 };

const objectField: JsonSchema = { type: "string", enum: [...OBJECTS], description: "Which CRM object." };
const propertiesField: JsonSchema = {
  type: "object",
  description: "Property values by internal name, e.g. {\"email\": \"a@b.com\", \"firstname\": \"Ana\"} or {\"dealname\": \"Renewal\", \"amount\": \"5000\", \"dealstage\": \"appointmentscheduled\"}.",
  additionalProperties: { type: ["string", "number", "boolean"] }
};

const crm = (ctx: ConnectorActionContext) => `${ctx.base("api")}/crm/v3/objects`;

function objectOf(input: Record<string, unknown>): CrmObject {
  const value = input.object;
  if (typeof value !== "string" || !(OBJECTS as readonly string[]).includes(value)) throw new ConnectorError("bad_input", '"object" must be contacts, companies or deals.');
  return value as CrmObject;
}

function propertiesOf(input: Record<string, unknown>): Record<string, string> {
  const value = input.properties;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("bad_input", '"properties" must be an object of property values.');
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,100}$/.test(key)) throw new ConnectorError("bad_input", `"${key}" is not a HubSpot property name (lowercase internal names).`);
    if (inner === null || inner === undefined) continue;
    if (!["string", "number", "boolean"].includes(typeof inner)) throw new ConnectorError("bad_input", `"${key}" must be text, a number or true/false.`);
    out[key] = String(inner);
  }
  if (Object.keys(out).length === 0) throw new ConnectorError("bad_input", '"properties" is empty.');
  return out;
}

interface CrmRecord {
  id: string;
  properties?: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  associations?: Record<string, { results?: Array<{ id: string; type?: string }> }>;
}

function recordView(object: CrmObject, record: CrmRecord) {
  return {
    object,
    id: record.id,
    properties: record.properties,
    updatedAt: record.updatedAt,
    associations: record.associations
      ? Object.fromEntries(Object.entries(record.associations).map(([key, value]) => [key, (value.results ?? []).map((r) => r.id)]))
      : undefined
  };
}

const actions: ConnectorAction[] = [
  {
    name: "search",
    group: "crm_read",
    title: "Search HubSpot",
    effect: "read",
    description:
      "Search HubSpot contacts, companies or deals by free text (name, e-mail, domain…) and/or exact property filters. Returns ids and key properties.",
    inputSchema: objectSchema(
      {
        object: objectField,
        query: str("Free-text search."),
        filters: {
          type: "array",
          maxItems: 6,
          description: "Property filters, all must match.",
          items: objectSchema(
            {
              property: str("Internal property name, e.g. dealstage, lifecyclestage, email."),
              operator: { type: "string", enum: ["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "CONTAINS_TOKEN", "HAS_PROPERTY", "NOT_HAS_PROPERTY"] },
              value: str("Value to compare with (not needed for HAS_PROPERTY).")
            },
            ["property", "operator"]
          )
        },
        properties: strList("Properties to return (default: a useful set)."),
        limit: int("Max records (default 10).", 1, 50)
      },
      ["object"]
    ),
    async run(input, ctx) {
      const object = objectOf(input);
      const filters = Array.isArray(input.filters)
        ? (input.filters as Array<Record<string, unknown>>).slice(0, 6).map((filter) => ({
            propertyName: requireString(filter, "property", 100),
            operator: requireString(filter, "operator", 30),
            ...(typeof filter.value === "string" || typeof filter.value === "number" ? { value: String(filter.value) } : {})
          }))
        : [];
      const properties = Array.isArray(input.properties) && input.properties.length ? (input.properties as string[]).slice(0, 40) : DEFAULT_PROPERTIES[object];
      const result = await ctx.http.post<{ total?: number; results?: CrmRecord[] }>(`${crm(ctx)}/${object}/search`, {
        ...(optionalString(input, "query", 300) ? { query: optionalString(input, "query", 300) } : {}),
        ...(filters.length ? { filterGroups: [{ filters }] } : {}),
        properties,
        limit: optionalInt(input, "limit", 1, 50, 10),
        sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }]
      });
      const records = (result.results ?? []).map((record) => recordView(object, record));
      return { summary: `Found ${result.total ?? records.length} ${object}.`, data: { total: result.total, records } };
    }
  },
  {
    name: "get",
    group: "crm_read",
    title: "Get a HubSpot record",
    effect: "read",
    description: "Read one HubSpot contact, company or deal by id, with its associated contacts, companies and deals.",
    inputSchema: objectSchema({ object: objectField, id: str("Record id."), properties: strList("Properties to return (default: a useful set).") }, ["object", "id"]),
    async run(input, ctx) {
      const object = objectOf(input);
      const properties = Array.isArray(input.properties) && input.properties.length ? (input.properties as string[]).slice(0, 60) : DEFAULT_PROPERTIES[object];
      const associations = OBJECTS.filter((other) => other !== object).join(",");
      const record = await ctx.http.get<CrmRecord>(`${crm(ctx)}/${object}/${seg(requireId(input, "id"))}`, { properties: properties.join(","), associations });
      return { data: recordView(object, record) };
    }
  },
  {
    name: "create",
    group: "crm_write",
    title: "Create a HubSpot record",
    effect: "write",
    description: "Create a HubSpot contact, company or deal with the given property values.",
    inputSchema: objectSchema({ object: objectField, properties: propertiesField }, ["object", "properties"]),
    async run(input, ctx) {
      const object = objectOf(input);
      const record = await ctx.http.post<CrmRecord>(`${crm(ctx)}/${object}`, { properties: propertiesOf(input) });
      return { summary: `Created ${object.slice(0, -1)} ${record.id}.`, data: recordView(object, record) };
    }
  },
  {
    name: "update",
    group: "crm_write",
    title: "Update a HubSpot record",
    effect: "write",
    description: "Change property values of a HubSpot contact, company or deal (only the properties given).",
    inputSchema: objectSchema({ object: objectField, id: str("Record id."), properties: propertiesField }, ["object", "id", "properties"]),
    async run(input, ctx) {
      const object = objectOf(input);
      const record = await ctx.http.patch<CrmRecord>(`${crm(ctx)}/${object}/${seg(requireId(input, "id"))}`, { properties: propertiesOf(input) });
      return { summary: "Record updated.", data: recordView(object, record) };
    }
  },
  {
    name: "add_note",
    group: "crm_write",
    title: "Add a note in HubSpot",
    effect: "write",
    description: "Add a note to HubSpot records (contacts, companies and/or deals) — e.g. a call summary or next steps.",
    inputSchema: objectSchema(
      {
        body: str("Note text."),
        contactIds: strList("Contact ids to attach it to.", 20),
        companyIds: strList("Company ids to attach it to.", 20),
        dealIds: strList("Deal ids to attach it to.", 20),
        timestamp: str("When it happened (ISO 8601; default now).")
      },
      ["body"]
    ),
    async run(input, ctx) {
      const targets: Array<{ object: CrmObject; ids: unknown }> = [
        { object: "contacts", ids: input.contactIds },
        { object: "companies", ids: input.companyIds },
        { object: "deals", ids: input.dealIds }
      ];
      const associations = targets.flatMap(({ object, ids }) =>
        (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string" && /^\d{1,20}$/.test(id)).map((id) => ({
          to: { id },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_ASSOCIATION[object] }]
        }))
      );
      if (associations.length === 0) throw new ConnectorError("bad_input", "Give at least one contact, company or deal id to attach the note to.");
      const when = optionalString(input, "timestamp", 64);
      const note = await ctx.http.post<CrmRecord>(`${crm(ctx)}/notes`, {
        properties: { hs_note_body: requireString(input, "body", 50_000), hs_timestamp: when && Number.isFinite(Date.parse(when)) ? new Date(Date.parse(when)).toISOString() : new Date().toISOString() },
        associations
      });
      return { summary: "Note added.", data: { noteId: note.id, attachedTo: associations.length } };
    }
  },
  {
    name: "associate",
    group: "crm_write",
    title: "Associate HubSpot records",
    effect: "write",
    description: "Link two HubSpot records with their default association (e.g. a contact to a company, a deal to a contact).",
    inputSchema: objectSchema(
      { fromObject: objectField, fromId: str("Record id."), toObject: objectField, toId: str("Record id.") },
      ["fromObject", "fromId", "toObject", "toId"]
    ),
    async run(input, ctx) {
      const from = objectOf({ object: input.fromObject });
      const to = objectOf({ object: input.toObject });
      if (from === to) throw new ConnectorError("bad_input", "Associate two different kinds of records.");
      await ctx.http.put(`${ctx.base("api")}/crm/v4/objects/${from}/${seg(requireId(input, "fromId"))}/associations/default/${to}/${seg(requireId(input, "toId"))}`);
      return "Records associated.";
    }
  }
];

const S = (object: string, mode: "read" | "write") => `crm.objects.${object}.${mode}`;

export const hubspotConnector: ConnectorDefinition = {
  id: "hubspot",
  name: "HubSpot",
  vendor: "HubSpot",
  description: "Contacts, companies and deals; notes and associations.",
  edition: "enterprise",
  feature: "connector_hubspot",
  auth: {
    kind: "oauth2",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    baseScopes: ["oauth"],
    pkce: false,
    async revoke(input) {
      if (!input.refreshToken) return;
      const response = await input.fetch(`https://api.hubapi.com/oauth/v1/refresh-tokens/${encodeURIComponent(input.refreshToken)}`, { method: "DELETE" });
      await response.body?.cancel().catch(() => undefined);
    }
  },
  alternateAuth: {
    kind: "apiKey",
    fields: [{ name: "token", label: "Private app access token", help: "HubSpot → Settings → Integrations → Private apps → your app → Access token.", placeholder: "pat-…" }],
    headers: (values) => ({ authorization: `Bearer ${values.token}` })
  },
  apiBases: { api: "https://api.hubapi.com" },
  apiHosts: ["api.hubapi.com"],
  groups: [
    {
      id: "crm_read",
      title: "CRM: search and read",
      description: "Search and read contacts, companies and deals.",
      scopes: [S("contacts", "read"), S("companies", "read"), S("deals", "read")],
      defaultEnabled: true
    },
    {
      id: "crm_write",
      title: "CRM: create, update, notes",
      description: "Create and update records, add notes, link records.",
      scopes: [S("contacts", "write"), S("companies", "write"), S("deals", "write")],
      defaultEnabled: true
    }
  ],
  actions,
  setup: {
    consoleName: "HubSpot developer account",
    consoleUrl: "https://developers.hubspot.com/",
    docsAnchor: "hubspot-enterprise",
    steps: [
      "Simplest: in HubSpot, Settings → Integrations → Private apps → Create a private app with the CRM scopes for contacts, companies and deals (read, and write if wanted). Copy its access token and use “Connect with a token”.",
      "For OAuth instead: in a HubSpot developer account create a public app, add the redirect URI shown below and the scopes listed per action group.",
      "Paste the app's client ID and client secret here. They are stored encrypted in Sibyl's secrets vault."
    ]
  },
  async identify(ctx) {
    const account = await ctx.http.get<{ portalId?: number; uiDomain?: string; companyCurrency?: string }>(`${ctx.base("api")}/account-info/v3/details`);
    return { ...(account.portalId ? { account: `HubSpot portal ${account.portalId}` } : {}), ...(account.uiDomain ? { accountName: account.uiDomain } : {}) };
  }
};
