import { parseMonitorInput, type MonitorView } from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { withStatus } from "./api";
import { emptyForm, formFromView, formToInput, parseValue } from "./form-state";

describe("monitor form", () => {
  test("builds input the gateway's strict parser accepts", () => {
    const form = {
      ...emptyForm(),
      name: "Big deals",
      kind: "tool" as const,
      toolName: "hubspot_search_deals",
      toolInput: "{\"query\":\"open\"}",
      filters: [
        { path: "properties.amount", op: "gt" as const, value: "50,000" },
        { path: "properties.dealstage", op: "changed" as const, value: "negotiation" },
        { path: "owner", op: "in" as const, value: "ana, ben" }
      ],
      ask: "Moved to Negotiation",
      channels: ["inbox" as const, "email" as const],
      taskOn: true,
      task: "Draft a follow-up"
    };
    const input = formToInput(form);
    expect(typeof input).toBe("object");
    expect(parseMonitorInput(input)).toEqual({ success: true, data: input });
    expect(input).toMatchObject({
      condition: {
        filter: [
          { path: "properties.amount", op: "gt", value: 50000 },
          { path: "properties.dealstage", op: "changed", value: "negotiation" },
          { path: "owner", op: "in", value: ["ana", "ben"] }
        ]
      },
      actions: [{ kind: "notify", channels: ["inbox", "email"] }, { kind: "task", instruction: "Draft a follow-up" }],
      budget: { dailyUsd: 0.5 }
    });
  });

  test("explains what is missing", () => {
    expect(formToInput(emptyForm())).toBe("Give the monitor a name.");
    expect(formToInput({ ...emptyForm(), name: "x", url: "nope" })).toMatch(/http/);
    expect(formToInput({ ...emptyForm(), name: "x", url: "https://a.test", channels: [] })).toMatch(/at least one action/);
    expect(parseValue("eq", "true")).toBe(true);
  });

  test("round-trips a view and merges live status", () => {
    const view: MonitorView = {
      id: "m1",
      name: "Feed",
      workspaceId: "default",
      createdBy: "u1",
      mine: true,
      source: { kind: "rss", url: "https://a.test/feed" },
      schedule: { everyMinutes: 60 },
      frequency: "every hour",
      condition: { ask: "About pricing?" },
      actions: [{ kind: "notify", channels: ["inbox"] }],
      dedupe: {},
      enabled: true,
      status: "active",
      lastError: "old",
      costTodayUsd: 0,
      costMonthUsd: 0,
      estimate: { typicalMonthUsd: 0.01, maxMonthUsd: 0.1 },
      createdAt: 1,
      updatedAt: 1
    };
    expect(formToInput(formFromView(view))).toMatchObject({ name: "Feed", source: view.source, schedule: { everyMinutes: 60 }, condition: { ask: "About pricing?" } });
    expect(withStatus(view, { id: "m1", status: "checking", enabled: true, costMonthUsd: 0.2 })).toMatchObject({ status: "checking", costMonthUsd: 0.2 });
    expect(withStatus(view, { id: "m1", status: "checking", enabled: true, costMonthUsd: 0.2 }).lastError).toBeUndefined();
  });
});
