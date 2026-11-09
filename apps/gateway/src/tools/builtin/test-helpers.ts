/** Shared fakes for built-in tool tests. */
import { createMemoryStore, type ToolContext, type UsageEvent } from "@open-gpt-live/core";
import type { FetchLike } from "./http.js";

export interface FakeCall {
  url: string;
  init?: RequestInit;
}

/** A fetch that answers from a route function and records calls. */
export function fakeFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return route(String(input), init);
  }) as FetchLike & { calls: FakeCall[] };
  impl.calls = calls;
  return impl;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function testContext(overrides: Partial<ToolContext> = {}): ToolContext & { recorded: Array<Omit<UsageEvent, "id" | "at">> } {
  const recorded: Array<Omit<UsageEvent, "id" | "at">> = [];
  return {
    signal: new AbortController().signal,
    ownerId: "owner",
    runId: "run-1",
    conversationId: "conv-1",
    store: createMemoryStore(),
    meter: {
      record: (event) => void recorded.push(event),
      totals: () => ({ todayUsd: 0, monthUsd: 0, byFeature: {} }),
      check: () => ({ allowed: true }),
      limits: () => ({})
    },
    log: () => {},
    recorded,
    ...overrides
  };
}
