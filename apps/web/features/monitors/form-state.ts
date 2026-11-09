/**
 * The monitor form's state and its conversion to/from the API shapes.
 * Kept free of React so it can be tested and reused.
 */
import type { MonitorChannelView, MonitorFilterOpView, MonitorFilterValue, MonitorInput, MonitorView } from "@open-gpt-live/protocol";

export type SourceKind = "tool" | "rss" | "webpage" | "webhook";

export interface FilterRow {
  path: string;
  op: MonitorFilterOpView;
  value: string;
}

export interface MonitorFormState {
  name: string;
  kind: SourceKind;
  toolName: string;
  /** JSON object text. */
  toolInput: string;
  url: string;
  everyMinutes: number;
  filters: FilterRow[];
  ask: string;
  channels: MonitorChannelView[];
  taskOn: boolean;
  task: string;
  agentId: string;
  dailyBudget: string;
  keyPath: string;
  enabled: boolean;
}

export const FREQUENCIES: Array<{ minutes: number; label: string }> = [
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 720, label: "Twice a day" },
  { minutes: 1440, label: "Once a day" }
];

export const OPS: Array<{ op: MonitorFilterOpView; label: string; needsValue: boolean }> = [
  { op: "eq", label: "is", needsValue: true },
  { op: "neq", label: "is not", needsValue: true },
  { op: "gt", label: "is more than", needsValue: true },
  { op: "gte", label: "is at least", needsValue: true },
  { op: "lt", label: "is less than", needsValue: true },
  { op: "lte", label: "is at most", needsValue: true },
  { op: "contains", label: "contains", needsValue: true },
  { op: "not_contains", label: "doesn't contain", needsValue: true },
  { op: "in", label: "is one of (comma separated)", needsValue: true },
  { op: "exists", label: "is set", needsValue: false },
  { op: "changed", label: "changed (to)", needsValue: false }
];

export function emptyForm(): MonitorFormState {
  return {
    name: "",
    kind: "rss",
    toolName: "",
    toolInput: "{}",
    url: "",
    everyMinutes: 15,
    filters: [],
    ask: "",
    channels: ["inbox"],
    taskOn: false,
    task: "",
    agentId: "",
    dailyBudget: "0.50",
    keyPath: "",
    enabled: true
  };
}

function valueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

export function formFromView(view: MonitorView): MonitorFormState {
  const form = emptyForm();
  form.name = view.name;
  form.kind = view.source.kind;
  if (view.source.kind === "tool") {
    form.toolName = view.source.toolName;
    form.toolInput = JSON.stringify(view.source.input ?? {}, null, 2);
  } else if (view.source.kind === "rss" || view.source.kind === "webpage") {
    form.url = view.source.url;
  }
  form.everyMinutes = view.schedule.everyMinutes;
  form.filters = (view.condition.filter ?? []).map((f) => ({ path: f.path, op: f.op, value: valueText(f.value) }));
  form.ask = view.condition.ask ?? "";
  form.channels = view.actions.flatMap((a) => (a.kind === "notify" ? a.channels : []));
  const task = view.actions.find((a) => a.kind === "task");
  form.taskOn = Boolean(task);
  form.task = task && task.kind === "task" ? task.instruction : "";
  form.agentId = view.agentId ?? "";
  form.dailyBudget = view.budget?.dailyUsd === undefined ? "" : String(view.budget.dailyUsd);
  form.keyPath = view.dedupe.keyPath ?? "";
  form.enabled = view.enabled;
  return form;
}

/** "50000" → 50000, "true" → true, "a, b" → ["a","b"] for "in". */
export function parseValue(op: MonitorFilterOpView, text: string): MonitorFilterValue | undefined {
  const trimmed = text.trim();
  if (op === "in") return trimmed ? trimmed.split(",").map((part) => scalar(part.trim())).filter((v) => v !== "") : [];
  if (!trimmed) return undefined;
  return scalar(trimmed);
}

function scalar(text: string): string | number | boolean {
  if (/^[-+]?\d+(\.\d+)?$/.test(text.replace(/,/g, "")) && /\d/.test(text)) return Number(text.replace(/,/g, ""));
  if (text === "true") return true;
  if (text === "false") return false;
  return text;
}

/** Build the API input; returns an error sentence when something is missing. */
export function formToInput(form: MonitorFormState): MonitorInput | string {
  if (!form.name.trim()) return "Give the monitor a name.";
  let source: MonitorInput["source"];
  if (form.kind === "tool") {
    if (!form.toolName) return "Pick what to watch.";
    let input: unknown;
    try {
      input = form.toolInput.trim() ? JSON.parse(form.toolInput) : {};
    } catch {
      return "The tool input must be valid JSON.";
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return "The tool input must be a JSON object.";
    source = { kind: "tool", toolName: form.toolName, input: input as Record<string, unknown> };
  } else if (form.kind === "webhook") {
    source = { kind: "webhook" };
  } else {
    if (!/^https?:\/\//i.test(form.url.trim())) return "Enter an http(s) address.";
    source = { kind: form.kind, url: form.url.trim() };
  }
  const filter = [];
  for (const row of form.filters) {
    if (!row.path.trim()) continue;
    const value = parseValue(row.op, row.value);
    const needsValue = OPS.find((o) => o.op === row.op)?.needsValue ?? true;
    if (needsValue && value === undefined) return `Add a value for the filter on “${row.path}”.`;
    filter.push({ path: row.path.trim(), op: row.op, ...(value === undefined ? {} : { value }) });
  }
  const actions: MonitorInput["actions"] = [];
  if (form.channels.length > 0) actions.push({ kind: "notify", channels: form.channels });
  if (form.taskOn) {
    if (!form.task.trim()) return "Describe the task to start.";
    actions.push({ kind: "task", instruction: form.task.trim() });
  }
  if (actions.length === 0) return "Choose at least one action: a notification or a task.";
  let budget: MonitorInput["budget"] = {};
  if (form.dailyBudget.trim()) {
    const daily = Number(form.dailyBudget);
    if (!Number.isFinite(daily) || daily <= 0) return "The daily budget must be a positive amount.";
    budget = { dailyUsd: daily };
  }
  return {
    name: form.name.trim(),
    source,
    schedule: { everyMinutes: form.everyMinutes },
    condition: { ...(filter.length ? { filter } : {}), ...(form.ask.trim() ? { ask: form.ask.trim() } : {}) },
    actions,
    dedupe: form.keyPath.trim() ? { keyPath: form.keyPath.trim() } : {},
    ...(form.agentId ? { agentId: form.agentId } : {}),
    budget,
    enabled: form.enabled
  };
}

/** Input field names of a tool's JSON schema (shown as a hint). */
export function schemaFields(schema: Record<string, unknown> | undefined): string[] {
  const properties = schema?.properties;
  return properties && typeof properties === "object" ? Object.keys(properties as Record<string, unknown>).slice(0, 12) : [];
}
