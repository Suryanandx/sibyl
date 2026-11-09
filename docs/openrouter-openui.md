# OpenRouter + OpenUI (voice + generative UI)

This fork wires three things together:

- **OpenRouter** for every model call: chat (LLM), speech-to-text, and text-to-speech, all with one `OPENROUTER_API_KEY`.
- **[OpenUI](https://github.com/thesysdev/openui)** generative UI: answers can include charts, tables, cards, and forms rendered by `@openuidev/react-ui`'s `openuiChatLibrary`.
- **A configurable model catalog**: the browser picks chat, transcription, and voice models (plus the voice itself) from an allowlist that the Gateway enforces.

## Quickstart

```bash
pnpm install
cp .env.example .env                              # set OPENROUTER_API_KEY
cp models.config.example.json models.config.json  # optional: edit the model list
pnpm dev
```

Open http://localhost:3000. Click the model chip in the top bar to switch models, voices, spoken replies, and generative UI. The choices are saved in the browser and re-applied on reconnect.

Setting `OPENROUTER_API_KEY` without `OPENAI_BASE_URL` selects OpenRouter automatically. You can also set `LLM_PROVIDER=openrouter` explicitly.

## Live conversation (our own "GPT Live")

The default mode is a live, emotional conversation built from swappable OpenRouter models. It doesn't use a vendor realtime API:

```text
mic (always on, echo-cancelled) ──► VAD end-of-turn (550 ms) ──► raw audio
        │                                                          │
        └─ instant on-device captions (display only)               ▼
                                         VOICE BRAIN (audio-native LLM, e.g. Gemini 3.5 Flash Lite)
                                         hears tone / emotion / hesitation, replies like a person:
                                         "[sympathetically] Oh no, that's the worst feeling…"
                                                │                         │
                         speech + emotion cues ─┘                         └─ "@brain <task>"
                                │                                                 │
          expressive TTS, segments synthesized in parallel          DEEP BRAIN (e.g. Claude Sonnet 5.5)
          and played gaplessly (Web Audio); barge-in stops it       reasons with the full conversation,
                                                                    streams an OpenUI visual, then a
          background STT ──► accurate transcript + text history     short spoken gist when you're idle
```

- **It hears you.** Your audio goes straight to the voice brain, so it reacts to how you said something, not just the words. Noise or speech not meant for it comes back as `@silence` and the turn is dropped.
- **It talks like a person.** It reacts first, keeps it to one or two sentences, mirrors your emotion, and asks short follow-ups. Emotion cues like `[laughs]` are performed by voices that support them (`emotionTags: true`, e.g. ElevenLabs v3) and stripped for the others.
- **It thinks without stalling.** Harder requests get a natural "let me pull that up" while the deep brain works in the background. The visual appears when ready, and its gist is spoken only if you haven't moved on to something else.
- **It understands context.** Both brains see the whole conversation, including what the deep brain showed, so follow-ups like "the last day sounds exhausting, I'm going with my grandma" work.
- Typed messages and push-to-talk use the same brains.

How it stays live:

- **Turn merging.** People pause mid-thought. If you keep talking before the assistant starts speaking (within 3 s), the earlier fragment and its pending reply are dropped, and the whole thought is answered once (`turn.merged`). That's why end-of-turn detection can be quick (400 ms of silence).
- **Hedged requests.** Provider latency on shared routes varies a lot (the same model measured 1 s on one call and 14 s on another). If the voice brain hasn't produced a word after 1.2 s, the same turn also goes to the fastest voice model from another vendor; if a voice segment hasn't started after 1.5 s, a duplicate request goes out on the same voice. Whichever answers first wins, and the other is cancelled. Failures fail over the same way.
- **Learning from live turns.** In auto mode the gateway tracks each voice model's real first-word latency and uses whichever of the scout's top picks has been fastest recently. Picking a model yourself always wins.
- **Warm connections.** Each session warms up the voice brain, and provider connections stay open between turns instead of Node's default 4 s.
- **Kept promises.** If the voice says it will look into something but forgets the `@brain` marker, the gateway hands the request off anyway. The deep brain waits up to 3 s for the accurate transcript so it works from your real words.
- **Early gist.** The deep brain's spoken summary plays as soon as it's written, while its visual keeps streaming in.
- **Hold-to-talk hears your tone too.** With a voice brain active, the browser converts the clip to WAV and the voice brain hears it directly.

Measured end to end in the browser (injected mic audio, real OpenRouter, Balanced preset, 2026-11-09):

| Step | Typical |
|---|---|
| End of speech detected | 0.4 s of silence |
| → voice brain's first word | ~1.5–2.1 s for a 4 s question |
| → first audio | +0.6–1.0 s |
| **End of speech → voice** | **~2.5–3.3 s** |
| Barge-in (you talk over it) → silence | ~0.5 s |
| Deep brain's spoken gist | ~5–8 s after handoff; visual streams in alongside |

Native speech-to-speech models (like GPT Live) start in under a second because one model does everything. This pipeline is model-agnostic and cheaper. The **Fastest** preset trades some cost for the lowest measured latency.

## Model scout (auto-picked models)

With OpenRouter, models aren't hand-picked. At startup (then daily), the gateway scouts the live catalog:

1. **Candidates per role.** It reads `/models`, plus the speech and transcription listings:
   - voice brain: models that take audio input;
   - deep brain: needs Design Arena **UI** benchmarks (`uicomponent`, `dataviz`, `website`), with the bottom 40% dropped;
   - transcription: trusted vendors only;
   - voice: needs a voice list.

   Free, stale (>600 days), expiring, alias and batch models are skipped.
2. **Cost per turn.** Estimated from OpenRouter pricing with typical usage: a voice turn is about 1.8k prompt tokens plus 160 audio tokens; a deep-brain run about 16k prompt plus 1.3k output; transcription and voice are billed per second, per character or per token depending on the model.
3. **Quality.** Mean Design Arena Elo for the role's categories. Unbenchmarked models count as slightly below average.
4. **Latency, measured live.**
   - Voice brains get a real ~4 s spoken question with the real voice prompt. Reasoning is tried *off* first, then low, then default; models that need it are charged for it. The result is the mean of two runs.
   - Deep brains get the real deep-brain prompt.
   - Voices are judged on their *slowest* of three starts.
   - At most 5 probes run at once, so the numbers aren't skewed.
5. **Ranking.** Four strategies with different weights for quality, cost and latency (Cheapest, Balanced, Fastest, Best quality), each with **latency budgets**. A voice over budget is penalized ×10 whatever its price.

The result is cached in `.model-scout.json` for 24 h. Without a fresh cache the gateway starts immediately on `models.config.json` and swaps in the scout's picks when they're ready (~50 s), live for connected sessions; choices users made themselves are kept. Models listed in `models.config.json` stay available as "pinned". `MODEL_STRATEGY` sets the default; the settings panel shows all four presets with their estimated cost per 100 turns, and every model with price, measured speed and Elo.

Example output (2026-11-09):

| Preset | Voice brain | Deep brain | Voice | ≈ per 100 turns |
|---|---|---|---|---|
| Cheapest | Gemini 2.5 Flash Lite | GLM 5.3 Flash | Kokoro | $0.07 |
| Balanced | MiMo v2.6 Pro (1.4 s) | GLM 5.3 Flash (1.8 s) | Kokoro (1.1 s) | $0.13 |
| Fastest | Gemini 3.1 Flash Lite (1.2 s) | GLM 5.3 (1.1 s) | Kokoro (1.1 s) | $0.19 |
| Best quality | MiMo v2.6 Pro (Elo 1318) | GLM 5.3 Flash | Gemini 3.8 Flash TTS (Elo 1274) | $0.36 |

Picks change as prices, benchmarks and provider speed change; that's the point.

Set `LIVE_CONVERSATION=false`, or leave out the `voice` model group, to get the original single-model pipeline.

## How a turn works (single-model mode)

```text
mic / text ──► Gateway ──► STT (OpenRouter /audio/transcriptions, selected model)
                  │
                  ├──► LLM (OpenRouter /chat/completions, selected model + server-side params)
                  │        system prompt = voice contract + OpenUI component library
                  │
                  │    stream ──► SpeechUiSplitter
                  │                 ├─ spoken text ─► llm.delta (transcript) ─► TTS ─► tts.chunk (audio)
                  │                 └─ ```openui-lang``` block ─► ui.delta ─► <Renderer/> in the browser
                  ▼
             browser: voice orb + transcript + OpenUI card
```

- The model is asked for **1–3 spoken sentences first**, then optionally **one fenced `openui-lang` block**. See `packages/genui/src/index.ts`.
- The Gateway splits the stream as it arrives. Fenced code is **never sent to TTS**. Markdown symbols are also stripped before speech.
- Button clicks and form submissions in a card become a new user turn, prefixed `[UI action]` with the form values.
- With generative UI off (`genUi: false`), the original plain voice-assistant prompt is used.
- If the voice model fails, the turn continues as text + UI. The browser shows a non-fatal "Voice reply unavailable" notice. The `error` event carries `scope: "tts"`.

## Model catalog (`models.config.json`)

```jsonc
{
  "llm": {
    "default": "google/gemini-3.8-flash",
    "params": { },                                   // merged into every chat request (optional)
    "models": [
      { "id": "google/gemini-3.8-flash", "label": "Gemini 3.8 Flash",
        "params": { "reasoning": { "effort": "low" } } },   // server-side only
      { "id": "qwen/qwen3.8-flash", "label": "Qwen 3.8 Flash",
        "params": { "reasoning": { "effort": "none" } } },
      "anthropic/claude-sonnet-5.5"                  // plain ids get an auto label
    ]
  },
  "voice": {                                       // audio-native voice brains (live mode)
    "default": "google/gemini-3.5-flash-lite",
    "models": ["google/gemini-3.5-flash-lite", "qwen/qwen3.8-omni-flash"]
  },
  "stt": { "default": "openai/gpt-4o-mini-transcribe", "models": ["openai/whisper-large-v3-turbo"] },
  "tts": {
    "default": "hexgrad/kokoro-82m",
    "models": [
      { "id": "elevenlabs/eleven-flash-v2.5", "label": "ElevenLabs Flash", "defaultVoice": "sarah" },
      { "id": "elevenlabs/eleven-v3", "label": "ElevenLabs v3", "emotionTags": true },
      { "id": "hexgrad/kokoro-82m", "label": "Kokoro 82M", "defaultVoice": "af_heart" },
      { "id": "google/gemini-3.8-flash-tts", "label": "Gemini TTS",
        "format": "pcm", "sampleRate": 24000, "defaultVoice": "Kore" }
    ]
  },
  "genUi": true,   // default for new sessions
  "speak": true
}
```

- **Allowlist.** `session.update` messages are checked against this file. An unknown model id is rejected with an `error` event.
- **Voices.** When a TTS model lists no `voices`, the Gateway fetches `supported_voices` from OpenRouter's `/models?output_modalities=speech` at startup (`MODELS_DISCOVER_VOICES`, on by default for OpenRouter).
- **`params`** are merged into the OpenRouter chat request body. Use them for `reasoning`, `provider` routing (e.g. `{ "provider": { "sort": "latency" } }`), `temperature`, and so on. They are never sent to the browser.
- **`format: "pcm"`** is for TTS models that only return raw PCM, such as Gemini TTS. The Gateway wraps each segment as WAV so `<audio>` can play it.
- Without a config file, the catalog comes from env: `LLM_MODELS`, `STT_MODELS`, `TTS_MODELS` (comma-separated `id` or `id|Label`), with `OPENAI_MODEL` / `STT_MODEL` / `TTS_MODEL` / `TTS_VOICE` as defaults.

### Latency tips (measured 2026-11-09, voice + UI prompt)

| Model | Setting | First token |
| --- | --- | --- |
| `google/gemini-3.8-flash` | default reasoning | ~9.6 s |
| `google/gemini-3.8-flash` | `reasoning.effort: "low"` | ~2.1 s |
| `qwen/qwen3.8-flash` | `reasoning.effort: "none"` | ~1.0 s |
| `anthropic/claude-haiku-5.5` | default | ~3.2 s |

The OpenUI component prompt is large (about 13k tokens), so models with prompt caching and low or no reasoning feel best for voice. A full push-to-talk turn measured about 1.6 s to transcript and about 4.4 s to first spoken audio (Qwen 3.8 Flash + Kokoro).

## Protocol additions

| Event | Direction | Payload |
| --- | --- | --- |
| `session.config` | server → client | `catalog`, `settings`, `capabilities` (sent on connect and after each update) |
| `session.update` | client → server | partial `settings`: `llmModel`, `sttModel`, `ttsModel`, `ttsVoice`, `genUi`, `speak` |
| `ui.delta` | server → client | `requestId`, `delta` (OpenUI Lang source) |
| `vad.speech_end.caption` | client → server | optional instant caption (display hint) |
| `transcript.update` | server → client | accurate transcript for a turn that already started |
| `brain.start` / `brain.delta` / `brain.done` | server → client | deep-brain run: `parentRequestId`, `task`, `model`; text deltas; status |
| `llm.done.reason: "ignored"` | server → client | the turn had no speech for the assistant |
| `turn.merged` | server → client | `requestId` absorbed the earlier fragment `mergedRequestId` (one thought spoken with a pause) |
| `session.config.catalog.presets` | server → client | scout presets: `id`, `label`, `settings`, `costPer100Turns` |
| model `costPer100Turns` / `latencyMs` / `elo` | server → client | scout metrics shown next to every model |
| `error.scope` | server → client | optional `"tts" \| "stt" \| "llm"`; `tts` errors are non-fatal |

## Updating the OpenUI component library

The Gateway embeds the exact prompt the browser renders with. After upgrading `@openuidev/react-ui`, regenerate it:

```bash
pnpm --filter @open-gpt-live/genui generate
```

The generated prompt is written to `packages/genui/src/openui-library-prompt.generated.ts`.

## Notes

- Live (hands-free) mode works with OpenRouter through batch transcription: partial transcripts are re-transcribed periodically, and the final transcript is taken at end of speech. The OpenAI Realtime streaming STT (`STT_REALTIME_ENABLED`) talks to OpenAI directly and is not an OpenRouter feature.
- `@openuidev/react-headless` has an optional dynamic import of the Vercel AI SDK. `next.config.mjs` aliases `ai` to an empty module, because this app streams over its own WebSocket.
- The `@openuidev/lang-core` postinstall script only sends telemetry, so it is disabled in `pnpm-workspace.yaml` (`allowBuilds`).
