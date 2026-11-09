import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { rankCandidates, scoreAll, scoutModels, type OpenRouterModel } from "./scout.js";

const now = Date.parse("2026-11-09T00:00:00Z");
const created = Math.floor(now / 1000) - 30 * 86_400;
const ui = (elo: number) => ({ design_arena: [{ arena: "models", category: "uicomponent", elo }, { arena: "models", category: "dataviz", elo }] });
const chat = (id: string, prompt: number, completion: number, extra: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
  id, name: `Vendor: ${id.split("/")[1]}`, created, context_length: 200_000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: String(prompt), completion: String(completion) }, supported_parameters: ["max_tokens"], ...extra
});
const catalog: OpenRouterModel[] = [
  chat("cheap/listener", 1e-7, 4e-7, { architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] } }),
  chat("pricey/listener", 3e-6, 1.5e-5, { architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] }, supported_parameters: ["reasoning"] }),
  chat("smart/brain", 3e-6, 1.5e-5, { benchmarks: ui(1400) }),
  chat("value/brain", 3e-7, 1.2e-6, { benchmarks: ui(1250) }),
  chat("weak/brain", 2e-7, 8e-7, { benchmarks: ui(1000) }),
  chat("nobench/brain", 1e-8, 1e-8),
  chat("free/brain:free", 0, 0, { benchmarks: ui(1300) }),
  chat("old/brain", 1e-7, 1e-7, { benchmarks: ui(1500), created: created - 900 * 86_400 }),
  chat("~alias/brain", 1e-7, 1e-7, { benchmarks: ui(1500) }),
  { id: "openai/gpt-4o-mini-transcribe", name: "OpenAI: Mini", created, pricing: { prompt: "0.00000125", completion: "0.000005" }, architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } },
  { id: "openai/whisper-1", name: "OpenAI: Whisper", created, pricing: { prompt: "0.0001", completion: "0" }, architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } },
  { id: "randomco/stt", name: "x", created, pricing: { prompt: "0.000001", completion: "0" }, architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } },
  { id: "eleven/eleven-v3", name: "ElevenLabs: v3", created, description: "supports inline audio tags", pricing: { prompt: "0.00008", completion: "0" }, architecture: { output_modalities: ["speech"] }, supported_voices: ["george", "sarah"], benchmarks: { design_arena: [{ arena: "models", category: "text-to-speech", elo: 1450 }] } },
  { id: "tiny/tts", name: "Tiny: TTS", created, pricing: { prompt: "0.0000006", completion: "0" }, architecture: { output_modalities: ["speech"] }, supported_voices: ["af_heart"] },
  { id: "novoice/tts", name: "x", created, pricing: { prompt: "0.000001", completion: "0" }, architecture: { output_modalities: ["speech"] }, supported_voices: [] }
];

test("candidates are filtered per role with costs and quality", () => {
  const ranked = rankCandidates(catalog, { allowFree: false, now });
  const ids = (role: string) => ranked.filter((c) => c.role === role).map((c) => c.id).sort();
  assert.deepEqual(ids("voice"), ["cheap/listener", "pricey/listener"]);
  // Brains need UI benchmarks; free, stale and alias models are excluded.
  assert.deepEqual(ids("llm"), ["smart/brain", "value/brain", "weak/brain"]);
  assert.deepEqual(ids("stt"), ["openai/gpt-4o-mini-transcribe", "openai/whisper-1"]);
  assert.deepEqual(ids("tts"), ["eleven/eleven-v3", "tiny/tts"]);
  const v3 = ranked.find((c) => c.id === "eleven/eleven-v3")!;
  assert.equal(v3.emotionTags, true);
  assert.equal(v3.defaultVoice, "sarah");
  assert.equal(v3.label, "v3");
  // whisper: $0.0001/s × 6 s
  assert.equal(ranked.find((c) => c.id === "openai/whisper-1")!.costPerTurn.toFixed(6), "0.000600");
  // reasoning-capable voice models get low effort + latency routing
  // reasoning-capable voice models try reasoning off first, routed for latency
  assert.deepEqual(ranked.find((c) => c.id === "pricey/listener")!.params, { reasoning: { enabled: false }, provider: { sort: "latency" } });
});

test("strategies trade cost against benchmark quality", () => {
  const scored = scoreAll(rankCandidates(catalog, { allowFree: false, now }));
  const top = (strategy: "cheapest" | "balanced" | "fastest" | "best") =>
    scored.filter((c) => c.role === "llm").sort((a, b) => b.scores[strategy] - a.scores[strategy])[0]!.id;
  assert.equal(top("best"), "smart/brain");
  assert.equal(top("cheapest"), "weak/brain");
  assert.equal(top("balanced"), "value/brain");
});

test("scout builds presets, defaults and a cache without probing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-"));
  const cacheFile = join(dir, "scout.json");
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ data: catalog }));
  }) as typeof fetch;
  const options = { baseUrl: "https://x/api/v1", apiKey: "k", probe: false, cacheFile, fetchImpl, now: () => now };
  const result = await scoutModels({ ...options, strategy: "balanced" });
  assert.equal(result.defaults.llmModel, "value/brain");
  assert.equal(result.catalog.presets?.length, 4);
  const best = result.catalog.presets!.find((p) => p.id === "best")!;
  assert.equal(best.settings.llmModel, "smart/brain");
  assert.equal(best.settings.ttsModel, "eleven/eleven-v3");
  assert.ok(result.catalog.llm[0]!.description!.includes("/100 turns"));
  assert.equal(result.llmParams["pricey/listener"]?.provider !== undefined, true);
  assert.ok(existsSync(cacheFile));
  // Second run is served from the cache.
  const again = await scoutModels({ ...options, strategy: "cheapest" });
  assert.equal(fetches, 3); // text + speech + transcription listings, then cached
  assert.equal(again.defaults.llmModel, "weak/brain");
});
