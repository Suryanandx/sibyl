import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { discoverOpenRouterVoices, loadModelCatalog } from "./models.js";
import { loadGatewayRuntimeConfig } from "./config.js";

const fallback = { llmModel: "a/default", sttModel: "s/default", ttsModel: "t/default", ttsVoice: "v1" };

test("env lists build a catalog with labels and keep the default", () => {
  const dir = mkdtempSync(join(tmpdir(), "models-"));
  const result = loadModelCatalog(
    { LLM_MODELS: "x/one|One, y/two-model-3", STT_MODELS: "s/default" },
    fallback,
    dir
  );
  assert.deepEqual(result.catalog.llm.map((m) => m.id), ["x/one", "y/two-model-3"]);
  assert.equal(result.catalog.llm[1]?.label, "Two Model 3");
  assert.equal(result.defaults.llmModel, "x/one");
  assert.deepEqual(result.catalog.tts[0], { id: "t/default", label: "Default", voices: ["v1"], defaultVoice: "v1" });
});

test("models.config.json wins and OPENAI_MODEL picks a listed default", () => {
  const dir = mkdtempSync(join(tmpdir(), "models-"));
  writeFileSync(
    join(dir, "models.config.json"),
    JSON.stringify({
      llm: { default: "b/two", models: [{ id: "a/one", label: "A" }, "b/two"] },
      tts: { models: [{ id: "k/k", label: "K", voices: ["x", "y"], defaultVoice: "y" }] },
      genUi: false
    })
  );
  const result = loadModelCatalog({ OPENAI_MODEL: "a/one" }, fallback, dir);
  assert.equal(result.defaults.llmModel, "a/one");
  assert.equal(result.defaults.ttsModel, "k/k");
  assert.equal(result.defaults.ttsVoice, "y");
  assert.equal(result.defaults.genUi, false);
});

test("voice discovery fills voices from the OpenRouter catalog", async () => {
  const catalog = { llm: [], stt: [], tts: [{ id: "k/k", label: "K" }] };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [{ id: "k/k", supported_voices: ["a", "b"] }] }))) as typeof fetch;
  const updated = await discoverOpenRouterVoices(catalog, "https://openrouter.ai/api/v1", fetchImpl);
  assert.equal(updated, 1);
  assert.deepEqual(catalog.tts[0], { id: "k/k", label: "K", voices: ["a", "b"], defaultVoice: "a" });
});

test("OPENROUTER_API_KEY selects the OpenRouter preset for LLM, STT, and TTS", () => {
  const config = loadGatewayRuntimeConfig({ OPENROUTER_API_KEY: "sk-or-test" });
  assert.equal(config.provider, "openrouter");
  assert.equal(config.llm.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.stt.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.tts.apiKey, "sk-or-test");
  assert.equal(config.llm.model, "google/gemini-3.8-flash");
  assert.equal(config.ttsEnabled, true);
  assert.equal(config.extraHeaders["X-Title"], "Sibyl");
});

test("LLM_PROVIDER=openrouter without a key fails fast", () => {
  assert.throws(() => loadGatewayRuntimeConfig({ LLM_PROVIDER: "openrouter" }), /OPENROUTER_API_KEY/);
});

test("per-model params stay server-side and merge with group params", () => {
  const dir = mkdtempSync(join(tmpdir(), "models-"));
  writeFileSync(
    join(dir, "models.config.json"),
    JSON.stringify({
      llm: {
        params: { provider: { sort: "latency" } },
        models: [{ id: "g/flash", label: "G", params: { reasoning: { effort: "low" } } }, "q/other"]
      }
    })
  );
  const result = loadModelCatalog({}, fallback, dir);
  assert.deepEqual(result.catalog.llm[0], { id: "g/flash", label: "G" });
  assert.deepEqual(result.llmParams["g/flash"], { provider: { sort: "latency" }, reasoning: { effort: "low" } });
  assert.deepEqual(result.llmParams["q/other"], { provider: { sort: "latency" } });
});
