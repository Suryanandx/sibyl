/**
 * Chat tools for monitors. The brain turns "tell me when a deal over $50k
 * moves to Negotiation" into a source (a read tool), cheap filters and, when
 * needed, a plain-language condition. Creating, pausing and deleting are
 * "write" tools: the approval sentence says what will be watched, how often,
 * what happens and what it will roughly cost per month.
 */
import { DEFAULT_WORKSPACE_ID, ownerPrincipal, type ToolContext, type ToolDefinition, type ToolResult } from "@open-gpt-live/core";
import { parseMonitorInput, type MonitorInput, type ParseResult } from "@open-gpt-live/protocol";
import { estimateWords, everyWords, formatUsd, sourceFromInput, sourceWords } from "./records.js";
import { MonitorError, type MonitorService } from "./service.js";

type MonitorTool = ToolDefinition<any, any> & { approvalSummary?(input: Record<string, unknown>): string | undefined };

const MONITOR_REF = { type: "string", description: "The monitor's id or exact name (see list_monitors)." };

const CREATE_HELP = [
  "Watch a source and tell the user (or start a task) when something matters, e.g. \"tell me when a deal over $50k moves to Negotiation\",",
  "\"email me when this page mentions a price change\", \"when a new post in this feed is about our product\".",
  "Pick the source:",
  "- kind \"tool\": any READ tool you have (connector tools like hubspot_search_deals, gmail_search, salesforce_query, calendar_list_events, drive_search, or MCP read tools), with the input it should be called with on every check. Prefer this for accounts the user connected.",
  "- kind \"rss\": an RSS/Atom feed URL. kind \"webpage\": a page URL (fires when its text changes). kind \"webhook\": another system POSTs to Sibyl.",
  "Then the condition, cheapest first: `filter` checks fields of each item (path like \"properties.amount\", ops eq, neq, gt, gte, lt, lte, contains, not_contains, in, exists, changed).",
  "Use op \"changed\" (optionally with value) for transitions, e.g. {path:\"properties.dealstage\",op:\"changed\",value:\"negotiation\"} plus {path:\"properties.amount\",op:\"gt\",value:50000}.",
  "Only add `ask` (plain language, checked by a small model on new items that passed the filters) when fields can't express it; it costs a little per check with new items.",
  "Only new items fire: the first check records what is there. Default action: notify in the inbox."
].join(" ");

const CREATE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short name, e.g. \"Big deals in Negotiation\"." },
    source: {
      type: "object",
      description: "What to watch.",
      properties: {
        kind: { type: "string", enum: ["tool", "rss", "webpage", "webhook"] },
        toolName: { type: "string", description: "kind tool: the read tool to call on every check." },
        input: { type: "object", description: "kind tool: the tool's input (same as when you call it).", additionalProperties: true },
        url: { type: "string", description: "kind rss/webpage: the address." }
      },
      required: ["kind"]
    },
    everyMinutes: { type: "integer", minimum: 5, description: "How often to check (5 minutes or more; default 15). Ignored for webhooks." },
    filter: {
      type: "array",
      description: "Structured checks on each item; all must pass.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "exists", "changed"] },
          value: { description: "Number, string, boolean or a list (for in)." }
        },
        required: ["path", "op"]
      }
    },
    ask: { type: "string", description: "Optional plain-language condition for what filters can't express." },
    notify: { type: "array", items: { type: "string", enum: ["inbox", "email", "slack", "teams"] }, description: "Where to tell the user (default inbox)." },
    task: { type: "string", description: "Optional: a task to start with what was found (e.g. \"draft a follow-up email for each deal\"). Writes still need approval." },
    dedupeKeyPath: { type: "string", description: "Optional: the item field that identifies it (default: id, guid, link or url)." },
    agentId: { type: "string", description: "Optional: run tasks as this agent." },
    dailyBudgetUsd: { type: "number", description: "Optional daily cost cap in USD (default 0.50)." }
  },
  required: ["name", "source"],
  additionalProperties: false
};

export const DEFAULT_MONITOR_DAILY_USD = 0.5;

/** The chat tool's flat input → the API's MonitorInput (validated by the protocol parser). */
export function toolInputToMonitorInput(input: Record<string, unknown>): ParseResult<MonitorInput> {
  const source = (input.source ?? {}) as Record<string, unknown>;
  const notify = Array.isArray(input.notify) && input.notify.length > 0 ? input.notify : ["inbox"];
  const actions: unknown[] = [{ kind: "notify", channels: notify }];
  if (typeof input.task === "string" && input.task.trim()) actions.push({ kind: "task", instruction: input.task });
  return parseMonitorInput({
    name: input.name,
    source: source.kind === "tool" ? { kind: "tool", toolName: source.toolName, input: source.input ?? {} } : source.kind === "webhook" ? { kind: "webhook" } : { kind: source.kind, url: source.url },
    schedule: { everyMinutes: typeof input.everyMinutes === "number" ? Math.round(input.everyMinutes) : 15 },
    condition: {
      ...(Array.isArray(input.filter) ? { filter: input.filter } : {}),
      ...(typeof input.ask === "string" && input.ask.trim() ? { ask: input.ask } : {})
    },
    actions,
    ...(typeof input.dedupeKeyPath === "string" && input.dedupeKeyPath ? { dedupe: { keyPath: input.dedupeKeyPath } } : {}),
    ...(typeof input.agentId === "string" && input.agentId ? { agentId: input.agentId } : {}),
    budget: { dailyUsd: typeof input.dailyBudgetUsd === "number" ? input.dailyBudgetUsd : DEFAULT_MONITOR_DAILY_USD }
  });
}

function opWords(op: string): string {
  return (
    { eq: "is", neq: "is not", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", not_contains: "doesn't contain", in: "is one of", exists: "is set", changed: "changed" } as Record<string, string>
  )[op] ?? op;
}

/** "when properties.amount > 50000 and properties.dealstage changed to negotiation, and “…”" */
export function conditionWords(input: MonitorInput): string {
  const parts = (input.condition.filter ?? []).map((f) => {
    if (f.op === "changed") return f.value === undefined ? `${f.path} changes` : `${f.path} changes to ${JSON.stringify(f.value)}`;
    if (f.op === "exists") return `${f.path} is set`;
    return `${f.path} ${opWords(f.op)} ${JSON.stringify(f.value)}`;
  });
  if (input.condition.ask) parts.push(`“${input.condition.ask}”`);
  return parts.length ? parts.join(" and ") : "anything new appears";
}

export function actionWords(input: MonitorInput): string {
  return input.actions
    .map((action) =>
      action.kind === "notify" ? `tell you (${action.channels.join(", ")})` : `start a task: ${action.instruction.length > 120 ? `${action.instruction.slice(0, 119)}…` : action.instruction}`
    )
    .join(" and ");
}

export function createMonitorTools(service: MonitorService): MonitorTool[] {
  const caller = (context: ToolContext) => ({
    principal: context.principal ?? ownerPrincipal(context.ownerId, "local"),
    workspaceId: context.workspaceId ?? DEFAULT_WORKSPACE_ID
  });
  const fail = (error: unknown): ToolResult => ({ content: error instanceof Error ? error.message : String(error), isError: true });

  const create: MonitorTool = {
    name: "create_monitor",
    title: "Create a monitor",
    description: CREATE_HELP,
    inputSchema: CREATE_SCHEMA,
    effect: "write",
    source: "builtin",
    provider: "monitors",
    approvalSummary(input) {
      const result = toolInputToMonitorInput(input);
      if (!result.success) return undefined;
      const parsed = result.data;
      const when = parsed.source.kind === "webhook" ? "whenever the webhook is called" : everyWords(parsed.schedule.everyMinutes);
      const estimate = service.estimate({
        source: sourceFromInput(parsed.source, ""),
        schedule: parsed.schedule,
        condition: parsed.condition,
        actions: parsed.actions,
        ...(parsed.budget ? { budget: parsed.budget } : {})
      });
      const budget = parsed.budget?.dailyUsd === undefined ? "" : ` Daily cap ${formatUsd(parsed.budget.dailyUsd)}.`;
      return `Sibyl will create the monitor “${parsed.name}”: watch ${sourceWords(parsed.source)} ${when}, and ${actionWords(parsed)} when ${conditionWords(parsed)}. Estimated cost: ${estimateWords(estimate)}.${budget}`;
    },
    async run(input, context) {
      const result = toolInputToMonitorInput(input);
      if (!result.success) return { content: `Could not create the monitor: ${result.error}.`, isError: true };
      const parsed = result.data;
      try {
        const { monitor, webhook } = await service.create(caller(context), parsed);
        const hook = webhook ? ` Deliveries go to POST ${webhook.path}, signed with the secret ${webhook.secretRef} (shown once in Monitors).` : "";
        return {
          content: `Created the monitor “${monitor.name}” (id ${monitor.id}). It checks ${monitor.frequency}; the first check records what's there, then you hear about anything new that matches. Estimated cost: ${estimateWords(monitor.estimate)}.${hook}`,
          data: { monitor }
        };
      } catch (error) {
        return fail(error instanceof MonitorError ? new Error(`Could not create the monitor: ${error.message}`) : error);
      }
    }
  };

  const list: MonitorTool = {
    name: "list_monitors",
    title: "List monitors",
    description: "List the user's monitors (what they watch, how often, status, last fired, cost this month).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    source: "builtin",
    provider: "monitors",
    async run(_input, context) {
      try {
        const { monitors } = await service.list(caller(context));
        if (monitors.length === 0) return { content: "No monitors yet.", data: { monitors } };
        const lines = monitors.map((m) => {
          const fired = m.lastFiredAt ? `last fired ${new Date(m.lastFiredAt).toISOString()}` : "never fired";
          const status = m.status === "paused" ? `paused${m.pausedReason ? ` (${m.pausedReason})` : ""}` : m.status === "error" ? `error: ${m.lastError ?? ""}` : m.status;
          return `- ${m.name} (id ${m.id}): ${m.frequency}, ${status}, ${fired}, ${formatUsd(m.costMonthUsd)} this month${m.mine ? "" : " (someone else's)"}`;
        });
        return { content: lines.join("\n"), data: { monitors } };
      } catch (error) {
        return fail(error);
      }
    }
  };

  const pause: MonitorTool = {
    name: "pause_monitor",
    title: "Pause or resume a monitor",
    description: "Pause a monitor (it stops checking), or resume it with resume: true.",
    inputSchema: {
      type: "object",
      properties: { monitor: MONITOR_REF, resume: { type: "boolean", description: "true to resume instead of pausing." } },
      required: ["monitor"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "monitors",
    approvalSummary(input) {
      return `Sibyl will ${input.resume === true ? "resume" : "pause"} the monitor “${String(input.monitor ?? "")}”.`;
    },
    async run(input, context) {
      try {
        const who = caller(context);
        const monitor = await service.resolve(who, String(input.monitor ?? ""));
        const view = await service.pause(who, monitor.id, input.resume !== true);
        return { content: `${view.enabled ? "Resumed" : "Paused"} “${view.name}”.${view.enabled ? ` It checks ${view.frequency}.` : ""}`, data: { monitor: view } };
      } catch (error) {
        return fail(error);
      }
    }
  };

  const remove: MonitorTool = {
    name: "delete_monitor",
    title: "Delete a monitor",
    description: "Delete a monitor and its history.",
    inputSchema: { type: "object", properties: { monitor: MONITOR_REF }, required: ["monitor"], additionalProperties: false },
    effect: "write",
    source: "builtin",
    provider: "monitors",
    approvalSummary(input) {
      return `Sibyl will delete the monitor “${String(input.monitor ?? "")}” and its history.`;
    },
    async run(input, context) {
      try {
        const who = caller(context);
        const monitor = await service.resolve(who, String(input.monitor ?? ""));
        await service.remove(who, monitor.id);
        return { content: `Deleted “${monitor.name}”.` };
      } catch (error) {
        return fail(error);
      }
    }
  };

  return [create, list, pause, remove];
}
