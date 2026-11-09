/**
 * Salesforce connector — Sibyl Enterprise (licence feature `connector_salesforce`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * SOQL queries (read-only), records (get, create, update) and logging calls
 * and tasks through the REST API, signed in with the organization's own
 * Connected App (OAuth 2.0 + PKCE). The instance URL comes from the token
 * response and must be a Salesforce host.
 */
import {
  bool,
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

export const SALESFORCE_API_VERSION = "v61.0";

const data = (ctx: ConnectorActionContext) => `${ctx.base("instance")}/services/data/${SALESFORCE_API_VERSION}`;

const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

function objectName(input: Record<string, unknown>): string {
  const value = requireString(input, "object", 80);
  if (!OBJECT_NAME.test(value)) throw new ConnectorError("bad_input", '"object" must be an API name like Account, Contact, Opportunity or My_Object__c.');
  return value;
}

function recordId(input: Record<string, unknown>, key = "id"): string {
  const value = requireId(input, key);
  if (!RECORD_ID.test(value)) throw new ConnectorError("bad_input", `"${key}" must be a 15- or 18-character Salesforce id.`);
  return value;
}

function fieldsOf(input: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const value = input.fields;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("bad_input", '"fields" must be an object of field values.');
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (!OBJECT_NAME.test(key)) throw new ConnectorError("bad_input", `"${key}" is not a field API name.`);
    if (inner !== null && !["string", "number", "boolean"].includes(typeof inner)) throw new ConnectorError("bad_input", `"${key}" must be text, a number, true/false or null.`);
    out[key] = inner as string | number | boolean | null;
  }
  if (Object.keys(out).length === 0) throw new ConnectorError("bad_input", '"fields" is empty.');
  return out;
}

/** Only SELECT statements (the API is read-only for queries anyway; this keeps intent clear). */
function soqlOf(input: Record<string, unknown>): string {
  const soql = requireString(input, "soql", 20_000).replace(/;\s*$/, "");
  if (!/^select\s/i.test(soql)) throw new ConnectorError("bad_input", "Only SOQL SELECT queries are allowed.");
  return soql;
}

const fieldsField: JsonSchema = {
  type: "object",
  description: "Field values by API name, e.g. {\"LastName\": \"Doe\", \"Email\": \"d@x.com\"} or {\"StageName\": \"Closed Won\"}.",
  additionalProperties: { type: ["string", "number", "boolean", "null"] }
};

interface QueryResult {
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
  records?: Array<Record<string, unknown>>;
}

const actions: ConnectorAction[] = [
  {
    name: "query",
    group: "records_read",
    title: "Query Salesforce (SOQL)",
    effect: "read",
    description:
      "Run a SOQL SELECT query, e.g. \"SELECT Id, Name, StageName, Amount, CloseDate FROM Opportunity WHERE IsClosed = false ORDER BY CloseDate LIMIT 20\". Use relationship fields (Account.Name) and LIMIT. Returns the records.",
    inputSchema: objectSchema({ soql: str("SOQL SELECT statement."), maxRecords: int("Max records to return (default 50).", 1, 500) }, ["soql"]),
    async run(input, ctx) {
      const records = await ctx.http.paginate<QueryResult, Record<string, unknown>>(
        { url: `${data(ctx)}/query`, query: { q: soqlOf(input) } },
        {
          items: (page) => page.records ?? [],
          next: (page) => (page.nextRecordsUrl && page.nextRecordsUrl.startsWith("/services/data/") ? `${ctx.base("instance")}${page.nextRecordsUrl}` : undefined),
          max: optionalInt(input, "maxRecords", 1, 500, 50)
        }
      );
      return { summary: `${records.length} record${records.length === 1 ? "" : "s"}.`, data: { records } };
    }
  },
  {
    name: "get_record",
    group: "records_read",
    title: "Get a Salesforce record",
    effect: "read",
    description: "Read one Salesforce record by object API name and id, optionally only some fields.",
    inputSchema: objectSchema({ object: str("Object API name, e.g. Account, Contact, Opportunity, Case."), id: str("Record id."), fields: strList("Field API names to return (default all).", 100) }, ["object", "id"]),
    async run(input, ctx) {
      const fields = Array.isArray(input.fields) ? (input.fields as unknown[]).filter((f): f is string => typeof f === "string" && OBJECT_NAME.test(f)) : [];
      const record = await ctx.http.get<Record<string, unknown>>(`${data(ctx)}/sobjects/${seg(objectName(input))}/${seg(recordId(input))}`, fields.length ? { fields: fields.join(",") } : undefined);
      return { data: record };
    }
  },
  {
    name: "create_record",
    group: "records_write",
    title: "Create a Salesforce record",
    effect: "write",
    description: "Create a Salesforce record (Lead, Contact, Account, Opportunity, Case, custom objects…) with the given field values.",
    inputSchema: objectSchema({ object: str("Object API name."), fields: fieldsField }, ["object", "fields"]),
    async run(input, ctx) {
      const object = objectName(input);
      const created = await ctx.http.post<{ id?: string; success?: boolean }>(`${data(ctx)}/sobjects/${seg(object)}`, fieldsOf(input));
      return { summary: `Created ${object} ${created.id ?? ""}.`.trim(), data: { id: created.id, object } };
    }
  },
  {
    name: "update_record",
    group: "records_write",
    title: "Update a Salesforce record",
    effect: "write",
    description: "Change field values of a Salesforce record (only the fields given).",
    inputSchema: objectSchema({ object: str("Object API name."), id: str("Record id."), fields: fieldsField }, ["object", "id", "fields"]),
    async run(input, ctx) {
      const object = objectName(input);
      const id = recordId(input);
      await ctx.http.patch(`${data(ctx)}/sobjects/${seg(object)}/${seg(id)}`, fieldsOf(input));
      return { summary: "Record updated.", data: { id, object } };
    }
  },
  {
    name: "log_activity",
    group: "records_write",
    title: "Log a call or task in Salesforce",
    effect: "write",
    description:
      "Log an activity as a Salesforce Task: a completed call (type call) or a to-do (type task). Link it to a person (whoId: Contact/Lead id) and/or a record (whatId: Account, Opportunity, Case… id).",
    inputSchema: objectSchema(
      {
        type: { type: "string", enum: ["call", "task"], description: "call: a logged, completed call; task: a to-do." },
        subject: str("Subject, e.g. 'Call with Ana about renewal'."),
        description: str("Notes / summary."),
        whoId: str("Contact or Lead id."),
        whatId: str("Account, Opportunity, Case or other record id."),
        dueDate: str("Activity / due date YYYY-MM-DD (default today)."),
        completed: bool("Mark completed (default: true for calls, false for tasks)."),
        priority: { type: "string", enum: ["High", "Normal", "Low"] }
      },
      ["subject"]
    ),
    async run(input, ctx) {
      const isCall = input.type !== "task";
      const due = optionalString(input, "dueDate", 10);
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new ConnectorError("bad_input", '"dueDate" must be YYYY-MM-DD.');
      const completed = typeof input.completed === "boolean" ? input.completed : isCall;
      const task: Record<string, unknown> = {
        Subject: requireString(input, "subject", 255),
        ActivityDate: due ?? new Date().toISOString().slice(0, 10),
        Status: completed ? "Completed" : "Not Started",
        Priority: typeof input.priority === "string" && ["High", "Normal", "Low"].includes(input.priority) ? input.priority : "Normal",
        ...(isCall ? { TaskSubtype: "Call" } : {}),
        ...(optionalString(input, "description", 32_000) ? { Description: optionalString(input, "description", 32_000) } : {}),
        ...(input.whoId ? { WhoId: recordId(input, "whoId") } : {}),
        ...(input.whatId ? { WhatId: recordId(input, "whatId") } : {})
      };
      const created = await ctx.http.post<{ id?: string }>(`${data(ctx)}/sobjects/Task`, task);
      return { summary: isCall ? "Call logged." : "Task created.", data: { id: created.id } };
    }
  }
];

/** Salesforce hosts an instance URL may point to. */
const SALESFORCE_HOSTS = [".salesforce.com", ".force.com", ".cloudforce.com", ".salesforce.mil", ".sfcrmproducts.cn"];

export const salesforceConnector: ConnectorDefinition = {
  id: "salesforce",
  name: "Salesforce",
  vendor: "Salesforce",
  description: "SOQL queries, records, and logging calls and tasks.",
  edition: "enterprise",
  feature: "connector_salesforce",
  appSettings: [
    {
      name: "loginHost",
      label: "Login host",
      help: "login.salesforce.com for production, test.salesforce.com for sandboxes, or your My Domain (acme.my.salesforce.com).",
      default: "login.salesforce.com",
      pattern: /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(salesforce|force)\.com$/
    }
  ],
  auth: {
    kind: "oauth2",
    authorizeUrl: "https://{loginHost}/services/oauth2/authorize",
    tokenUrl: "https://{loginHost}/services/oauth2/token",
    revokeUrl: "https://{loginHost}/services/oauth2/revoke",
    baseScopes: ["api", "refresh_token", "openid", "email"],
    pkce: true,
    authorizeParams: { prompt: "login consent" }
  },
  apiBases: { instance: "{instanceUrl}" },
  apiHosts: SALESFORCE_HOSTS,
  groups: [
    { id: "records_read", title: "Query and read", description: "Run SOQL queries and read records.", scopes: [], defaultEnabled: true },
    { id: "records_write", title: "Create, update, log activity", description: "Create and update records, log calls and tasks.", scopes: [], defaultEnabled: true }
  ],
  actions,
  setup: {
    consoleName: "Salesforce Setup",
    consoleUrl: "https://login.salesforce.com/lightning/setup/NavigationMenus/home",
    docsAnchor: "salesforce-enterprise",
    steps: [
      "In Salesforce Setup, open App Manager → New Connected App (or External Client App).",
      "Enable OAuth settings. Callback URL: the redirect URI shown below.",
      "Selected OAuth scopes: “Manage user data via APIs (api)”, “Perform requests at any time (refresh_token, offline_access)” and “Access unique user identifiers (openid)”. Require PKCE.",
      "Save, then copy the Consumer Key and Consumer Secret (Manage Consumer Details).",
      "Paste them here as client ID and client secret. Sandboxes: set the login host to test.salesforce.com."
    ]
  },
  tokenMetadata(token): Record<string, string> {
    const instanceUrl = typeof token.instance_url === "string" ? token.instance_url : undefined;
    return instanceUrl ? { instanceUrl } : {};
  },
  async identify(ctx) {
    const me = await ctx.http.get<{ email?: string; preferred_username?: string; name?: string; organization_id?: string }>(`${ctx.base("instance")}/services/oauth2/userinfo`);
    const account = me.preferred_username ?? me.email;
    return { ...(account ? { account } : {}), ...(me.name ? { accountName: me.name } : {}) };
  }
};
