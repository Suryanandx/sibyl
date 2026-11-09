import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  OpenAILLMProvider,
  OpenAIWhisperProvider,
  parseProviderUsage,
  type ProviderUsage
} from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("OpenRouter streams ask for usage and surface the final usage chunk", async () => {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
      JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, cost: 0.000321 }
      }),
      "[DONE]"
    ]);
  });
  const llm = new OpenAILLMProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "m" });
  const usages: ProviderUsage[] = [];
  let text = "";
  for await (const chunk of llm.streamText([{ role: "user", content: "hi" }], {
    onUsage: (usage) => usages.push(usage),
    meta: { feature: "voice" }
  })) {
    text += chunk.delta;
  }
  assert.equal(text, "Hello");
  assert.deepEqual(requests[0]?.usage, { include: true });
  // Caller labels never reach the provider.
  assert.equal("meta" in (requests[0] ?? {}), false);
  assert.deepEqual(usages, [{ costUsd: 0.000321, promptTokens: 120, completionTokens: 8 }]);
});

test("non-OpenRouter streams keep the plain request body and still work without usage", async () => {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return sseResponse([JSON.stringify({ choices: [{ delta: { content: "ok" } }] }), "[DONE]"]);
  });
  const llm = new OpenAILLMProvider({ apiKey: "k", baseUrl: "http://ollama:11434/v1", model: "m" });
  const usages: ProviderUsage[] = [];
  for await (const _chunk of llm.streamText([{ role: "user", content: "hi" }], { onUsage: (u) => usages.push(u) })) {
    // drain
  }
  assert.equal("usage" in (requests[0] ?? {}), false);
  assert.deepEqual(usages, []);
});

test("transcription surfaces a usage object when the provider returns one", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ text: "hello", usage: { type: "duration", seconds: 3.2, cost: 0.0004 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  );
  const stt = new OpenAIWhisperProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1" });
  const usages: ProviderUsage[] = [];
  const result = await stt.transcribe(
    { data: new Uint8Array([1, 2]), mimeType: "audio/wav" },
    { onUsage: (u) => usages.push(u) }
  );
  assert.equal(result.text, "hello");
  assert.deepEqual(usages, [{ costUsd: 0.0004, seconds: 3.2 }]);
});

test("parseProviderUsage ignores junk", () => {
  assert.equal(parseProviderUsage(undefined), undefined);
  assert.equal(parseProviderUsage({ cost: "x", prompt_tokens: -1 }), undefined);
  assert.deepEqual(parseProviderUsage({ input_tokens: 5, output_tokens: 2 }), { promptTokens: 5, completionTokens: 2 });
});
