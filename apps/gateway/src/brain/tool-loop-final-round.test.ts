import { createMemoryStore, type ToolDefinition } from "@open-gpt-live/core";
import type { ToolChatEvent, ToolChatMessage, ToolChatOptions, ToolChatProvider } from "@open-gpt-live/adapters";
import { describe, expect, it } from "vitest";
import { createNoopMeter } from "../runtime.js";
import { FINAL_ROUND_NOTE, runToolLoop } from "./tool-loop.js";

const lookup: ToolDefinition<{ q: string }, string> = {
  name: "lookup",
  title: "Look up",
  description: "Look something up",
  effect: "read",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  async run() {
    return { content: "a fact" };
  }
} as unknown as ToolDefinition<{ q: string }, string>;

describe("the last tool round", () => {
  it("turns tools off and tells the model to answer now, without storing the note", async () => {
    const requests: Array<{ messages: ToolChatMessage[]; options: ToolChatOptions }> = [];
    const provider = {
      async *streamWithTools(messages: ToolChatMessage[], options: ToolChatOptions = {}): AsyncIterable<ToolChatEvent> {
        requests.push({ messages: structuredClone(messages), options });
        if (options.toolChoice === "none") {
          yield { type: "text", delta: "Here is the table." };
          return;
        }
        yield { type: "tool_calls", calls: [{ id: `c${requests.length}`, name: "lookup", arguments: JSON.stringify({ q: "x" }) }] };
      }
    } as unknown as ToolChatProvider;
    const messages: ToolChatMessage[] = [{ role: "user", content: "Make a table" }];
    let text = "";
    const result = await runToolLoop({
      provider,
      messages,
      model: "m",
      tools: [lookup],
      signal: new AbortController().signal,
      runId: "r",
      ownerId: "owner",
      store: createMemoryStore(),
      meter: createNoopMeter(),
      log: () => undefined,
      onText: (delta) => void (text += delta),
      onToolStarted: () => undefined,
      onToolFinished: () => undefined,
      approve: async () => ({ approved: true }) as never,
      maxRounds: 3
    });
    expect(result.rounds).toBe(3);
    expect(text).toContain("Here is the table.");
    const last = requests.at(-1)!;
    expect(last.options.toolChoice).toBe("none");
    expect(last.messages.at(-1)).toEqual({ role: "system", content: FINAL_ROUND_NOTE });
    // Earlier rounds don't carry it, and the caller's history never does.
    expect(requests.slice(0, -1).some((r) => r.messages.some((m) => m.content === FINAL_ROUND_NOTE))).toBe(false);
    expect(messages.some((m) => m.content === FINAL_ROUND_NOTE)).toBe(false);
  });
});
