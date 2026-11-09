import assert from "node:assert/strict";
import { test } from "vitest";
import { OpenAIToolChatClient, type ToolChatEvent } from "./index.js";

function sse(chunks: unknown[], split = 7): Response {
  const text = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  // Deliver in small pieces so events straddle reads.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(iter: AsyncIterable<ToolChatEvent>): Promise<ToolChatEvent[]> {
  const out: ToolChatEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

test("streams text, accumulates tool_call deltas by index, and reports usage", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const client = new OpenAIToolChatClient({
    apiKey: "sk-test",
    baseUrl: "https://openrouter.ai/api/v1/",
    model: "default/model",
    extraHeaders: { "X-Title": "Sibyl" },
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>
      });
      return sse([
        { choices: [{ delta: { content: "Let me " } }] },
        { choices: [{ delta: { content: "check." } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "web_search", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"query\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"weather\"}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0012 } },
        "[DONE]"
      ]);
    }
  });

  const events = await collect(
    client.streamWithTools(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, toolCalls: [{ id: "old", name: "get_time", arguments: "{}" }] },
        { role: "tool", toolCallId: "old", content: "12:00" }
      ],
      {
        model: "brain/deep",
        extraBody: { reasoning: { effort: "low" } },
        tools: [{ type: "function", function: { name: "web_search", description: "d", parameters: { type: "object" } } }]
      }
    )
  );

  assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requests[0]?.headers.Authorization, "Bearer sk-test");
  assert.equal(requests[0]?.headers["X-Title"], "Sibyl");
  const body = requests[0]!.body;
  assert.equal(body.model, "brain/deep");
  assert.equal(body.stream, true);
  assert.deepEqual(body.usage, { include: true });
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.tool_choice, "auto");
  assert.equal((body.tools as unknown[]).length, 1);
  assert.deepEqual((body.messages as unknown[])[2], {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "old", type: "function", function: { name: "get_time", arguments: "{}" } }]
  });
  assert.deepEqual((body.messages as unknown[])[3], { role: "tool", tool_call_id: "old", content: "12:00" });

  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  assert.equal(text, "Let me check.");
  assert.deepEqual(events.find((e) => e.type === "usage"), {
    type: "usage",
    usage: { costUsd: 0.0012, promptTokens: 120, completionTokens: 30 }
  });
  assert.deepEqual(events.at(-1), {
    type: "tool_calls",
    calls: [
      { id: "call_a", name: "web_search", arguments: "{\"query\":\"weather\"}" },
      { id: "call_b", name: "get_time", arguments: "{}" }
    ]
  });
});

test("plain answers yield no tool_calls and omit tools from the request", async () => {
  let body: Record<string, unknown> = {};
  const client = new OpenAIToolChatClient({
    apiKey: "k",
    baseUrl: "http://local/v1",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse([{ choices: [{ delta: { content: "Hi" } }] }, "[DONE]"]);
    }
  });
  const events = await collect(client.streamWithTools([{ role: "user", content: "hi" }]));
  assert.deepEqual(events, [{ type: "text", delta: "Hi" }]);
  assert.equal("tools" in body, false);
});

test("HTTP errors and in-stream errors are thrown", async () => {
  const failing = new OpenAIToolChatClient({
    apiKey: "k",
    baseUrl: "http://local/v1",
    fetch: async () => new Response("nope", { status: 429 })
  });
  await assert.rejects(collect(failing.streamWithTools([{ role: "user", content: "x" }])), /429: nope/);

  const streamError = new OpenAIToolChatClient({
    apiKey: "k",
    baseUrl: "http://local/v1",
    fetch: async () => sse([{ error: { message: "upstream died" } }])
  });
  await assert.rejects(collect(streamError.streamWithTools([{ role: "user", content: "x" }])), /upstream died/);
});
