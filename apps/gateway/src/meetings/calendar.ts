/**
 * Upcoming events from the person's Google or Microsoft calendar, to turn
 * into meetings. Reuses the connectors' own calendar actions (the tools
 * google_calendar_list_events / microsoft_outlook_list_events), so access,
 * tokens and refresh stay in one place; nothing runs when neither is connected.
 */
import { randomUUID } from "node:crypto";
import type { Principal, Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import type { MeetingCalendarEventView } from "@open-gpt-live/protocol";

const SOURCES = [
  { provider: "google", tool: "google_calendar_list_events" },
  { provider: "microsoft", tool: "microsoft_outlook_list_events" }
] as const;

export interface CalendarDeps {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  ownerId: string;
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface CalendarResult {
  /** Calendars that could be read ("google", "microsoft"). */
  connected: Array<"google" | "microsoft">;
  items: MeetingCalendarEventView[];
}

/** Events in the next `days` days from every connected calendar, soonest first. */
export async function upcomingEvents(deps: CalendarDeps, caller: { principal: Principal; workspaceId: string }, now: number, days = 7): Promise<CalendarResult> {
  const result: CalendarResult = { connected: [], items: [] };
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
  for (const source of SOURCES) {
    const tool = deps.tools.get(source.tool);
    if (!tool) continue;
    const available = tool.isAvailable ? await tool.isAvailable({ principal: caller.principal, workspaceId: caller.workspaceId }) : true;
    if (!available) continue;
    try {
      const output = await tool.run(
        { timeMin, timeMax, maxResults: 25 },
        {
          signal: AbortSignal.timeout(15_000),
          ownerId: deps.ownerId,
          runId: `meetings-calendar-${randomUUID()}`,
          principal: caller.principal,
          workspaceId: caller.workspaceId,
          store: deps.store,
          meter: deps.meter,
          log: deps.log
        }
      );
      if (output.isError) continue;
      result.connected.push(source.provider);
      const events = ((output.data as { events?: unknown[] } | undefined)?.events ?? []) as Array<Record<string, unknown>>;
      for (const event of events) {
        const item = eventOf(source.provider, event);
        if (item) result.items.push(item);
      }
    } catch (error) {
      deps.log("meetings.calendar_failed", { provider: source.provider, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.items.sort((a, b) => a.start - b.start);
  return result;
}

function eventOf(provider: "google" | "microsoft", event: Record<string, unknown>): MeetingCalendarEventView | undefined {
  const id = typeof event.id === "string" ? event.id : undefined;
  const title = (typeof event.summary === "string" && event.summary) || (typeof event.subject === "string" && event.subject) || "Untitled event";
  const start = parseTime(event.start);
  if (!id || start === undefined || event.allDay) return undefined;
  const end = parseTime(event.end);
  return { provider, eventId: id, title: title.slice(0, 140), start, ...(end !== undefined ? { end } : {}) };
}

/** Google: ISO with offset. Microsoft (as the connector shows it): "2026-11-10T09:00:00.0000000 (UTC)". */
export function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const match = /^(.+?)\s*\(([^)]+)\)$/.exec(value);
  const iso = match ? `${match[1]}${match[2] === "UTC" && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(match[1]!) ? "Z" : ""}` : value;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}
