# Models and costs

Sibyl uses four kinds of model, all through OpenRouter:

| Role | What it does | Example |
|---|---|---|
| **Voice brain** | Hears your audio directly and talks back. Must accept audio input. | Gemini Flash Lite, MiMo, Qwen Omni |
| **Deep brain** | Careful reasoning and visual answers, handed work by the voice brain. Also the only model when live conversation is off. | GLM, Claude Sonnet, Gemini Flash |
| **Transcription** | Writes an accurate transcript of what you said, in the background. | GPT-4o mini Transcribe, Whisper, Deepgram Nova |
| **Voice** | Turns the reply text into speech. | Kokoro, ElevenLabs, Gemini TTS |

You can let the model scout choose all four, pin your favourites, or choose by hand.

## The model scout

With `MODEL_SELECTION=auto` (the default with OpenRouter), the gateway chooses models from the live OpenRouter catalog instead of a hand-maintained list. It runs at startup when there is no fresh cache, and again every 24 hours.

### 1. Find candidates for each role

The scout reads OpenRouter's model listing, including the speech and transcription models.

- **Voice brain:** text-output models that accept audio input, with at least 32k context.
- **Deep brain:** models with Design Arena scores in the UI categories (`uicomponent`, `dataviz`, `website`) and at least 64k context. When five or more are benchmarked, the bottom half by UI score is dropped, so a very cheap model with weak visuals can't win on price alone.
- **Transcription:** models from established speech vendors only (OpenAI, Deepgram, ElevenLabs, Mistral, AssemblyAI, Google, NVIDIA, Microsoft).
- **Voice:** speech models that publish a list of voices.

It skips free models, batch and alias routes, models that expire within 30 days, and models older than 600 days.

### 2. Estimate cost per turn

Each candidate's cost comes from OpenRouter's published pricing and a typical turn:

| Role | Typical usage per turn |
|---|---|
| Voice brain | ~1,800 prompt tokens, 160 audio tokens, 80 output tokens (plus reasoning tokens if the model can't turn reasoning off) |
| Deep brain | ~16,000 prompt tokens, 1,300 output tokens (plus some reasoning) |
| Transcription | priced per second of audio or per token, depending on the model |
| Voice | ~160 characters of speech, priced per character, second or token |

The deep brain's prompt is large because it includes the full OpenUI component library (about 13k tokens). Models with prompt caching are noticeably cheaper there.

### 3. Read quality

Quality is the mean Design Arena Elo for the role's benchmark categories: UI categories for the deep brain, speech categories for voices. Models without a benchmark count as slightly below average.

### 4. Measure latency

With `SCOUT_PROBE=true` (the default), the most promising candidates get small, real requests:

- **Voice brains** hear a real four-second spoken question with the real voice prompt. Reasoning is requested off; models that reject that are tried with low, then default reasoning, and are charged for it in the cost estimate. The result is the mean of two runs.
- **Deep brains** get the real deep-brain prompt.
- **Voices** start speaking three times; the slowest of the three counts.
- At most five probes run at once, so they don't slow each other down.

### 5. Rank

Four strategies weight quality, cost and latency differently. Each also has latency budgets: a candidate over its budget keeps only a tenth of its score, whatever its price, because no saving makes a slow voice feel right. Unmeasured candidates keep half.

| Preset | Emphasis | Voice brain budget | Voice budget | Deep brain budget |
|---|---|---|---|---|
| **Cheapest** | cost | 3.0 s | 3.5 s | 10 s |
| **Balanced** | an even mix | 2.0 s | 1.8 s | 5 s |
| **Fastest** | latency | 1.6 s | 1.2 s | 3 s |
| **Best quality** | benchmark quality | 2.5 s | 2.5 s | 8 s |

The scout keeps the top six models per role in the catalog, and builds one preset per strategy with its estimated cost per 100 turns. `MODEL_STRATEGY` chooses which preset new sessions start with.

### Example output

From a run on 2026-11-09:

| Preset | Voice brain | Deep brain | Voice | Approx. per 100 turns |
|---|---|---|---|---|
| Cheapest | Gemini 2.5 Flash Lite | GLM 5.3 Flash | Kokoro | $0.07 |
| Balanced | MiMo v2.6 Pro (1.4 s) | GLM 5.3 Flash (1.8 s) | Kokoro (1.1 s) | $0.13 |
| Fastest | Gemini 3.1 Flash Lite (1.2 s) | GLM 5.3 (1.1 s) | Kokoro (1.1 s) | $0.19 |
| Best quality | MiMo v2.6 Pro (Elo 1318) | GLM 5.3 Flash | Gemini 3.8 Flash TTS (Elo 1274) | $0.36 |

Picks change as prices, benchmarks and provider speed change. That is the point of scouting rather than hard-coding.

### Caching and live updates

- Results are cached in `SCOUT_CACHE_FILE` (default `.model-scout.json`) for 24 hours. With a fresh cache, the gateway applies it before accepting connections.
- Without one, the gateway starts at once on your config file and swaps in the scout's picks when they are ready (about 50 seconds), including for sessions already connected. Choices a user made themselves are kept.
- If the scout fails (network, no credit), the gateway logs `models.scout_failed` and keeps using the config file.

### What a scout run costs

A full run sends a few dozen small requests, each with a short prompt or a few seconds of audio, so the cost is small compared with normal use. Set `SCOUT_PROBE=false` to rank on price and benchmarks only, with no probes.

## Learning from your own turns

In auto mode the gateway also tracks each voice model's real time to first word during conversation, and uses whichever of the top three voice brains has been fastest recently. A voice model you pick yourself is always used as chosen.

## Choosing models yourself

In the browser:

- The **model menu** in the composer lists the presets and the top voice brains, and its search box also finds deep brain models.
- The **Models & voice** dialog shows each role with price, measured speed and benchmark score.

Choices are stored in the browser and re-sent when you reconnect. The gateway only accepts models from its catalog; anything else is rejected with an error.

## The model allowlist

`models.config.json` at the project root (or the file named by `MODELS_CONFIG_FILE`) defines which models people can pick. Start from the example:

```bash
cp models.config.example.json models.config.json
```

In auto mode, every model listed here stays available next to the scout's picks, labelled "pinned". In manual mode (`MODEL_SELECTION=manual`), this file is the whole catalog.

```jsonc
{
  "voice": {                                   // audio-native voice brains
    "default": "google/gemini-3.5-flash-lite",
    "models": [
      { "id": "google/gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash Lite" },
      { "id": "google/gemini-3.8-flash", "label": "Gemini 3.8 Flash",
        "params": { "reasoning": { "effort": "low" } } }
    ]
  },
  "llm": {                                     // deep brain
    "default": "anthropic/claude-sonnet-5.5",
    "params": { },                             // merged into every request in this group
    "models": [
      { "id": "qwen/qwen3.8-flash", "label": "Qwen 3.8 Flash",
        "description": "Lowest latency",
        "params": { "reasoning": { "effort": "none" } } },
      "anthropic/claude-sonnet-5.5"            // a plain id gets an automatic label
    ]
  },
  "stt": {
    "default": "openai/gpt-4o-mini-transcribe",
    "models": ["openai/gpt-4o-mini-transcribe", "openai/whisper-large-v3-turbo"]
  },
  "tts": {
    "default": "elevenlabs/eleven-flash-v2.5",
    "models": [
      { "id": "elevenlabs/eleven-flash-v2.5", "label": "ElevenLabs Flash", "defaultVoice": "sarah" },
      { "id": "elevenlabs/eleven-v3", "label": "ElevenLabs v3", "emotionTags": true },
      { "id": "hexgrad/kokoro-82m", "label": "Kokoro 82M", "defaultVoice": "af_heart" },
      { "id": "google/gemini-3.8-flash-tts", "label": "Gemini TTS",
        "format": "pcm", "sampleRate": 24000, "defaultVoice": "Kore" }
    ]
  },
  "genUi": true,                               // visual answers on for new sessions
  "speak": true                                // spoken replies on for new sessions
}
```

The real file is plain JSON; the comments above are for explanation only. Model ids are OpenRouter slugs from <https://openrouter.ai/models>.

| Field | Applies to | Meaning |
|---|---|---|
| `default` | every group | The model new sessions start with. Added to the list if missing. |
| `models` | every group | Model ids, or objects with `id`, `label` and `description`. |
| `params` | `voice`, `llm` (group or model) | Extra fields merged into the OpenRouter chat request: `reasoning`, `provider` routing (for example `{ "provider": { "sort": "latency" } }`), `temperature` and so on. Never sent to the browser. |
| `voices`, `defaultVoice` | `tts` | Voices to offer. When a model lists none, they are filled in from OpenRouter at startup (`MODELS_DISCOVER_VOICES`). |
| `format`, `sampleRate` | `tts` | For models that only return raw PCM (such as Gemini TTS): request `pcm` and the gateway wraps each segment as WAV. Default sample rate 24000. |
| `emotionTags` | `tts` | The voice performs cues like `[laughs]` or `[whispers]`. For other voices, cues are removed before speech. |
| `genUi`, `speak` | top level | Defaults for new sessions. |

In manual mode, leaving out the `voice` group (and `VOICE_MODELS`) turns live conversation off and uses the single-model pipeline. In auto mode the scout supplies voice brains itself; set `LIVE_CONVERSATION=false` instead.

### Latency tips

Measured on 2026-11-09 with the voice + visuals prompt, time to the first token:

| Model | Setting | First token |
|---|---|---|
| `google/gemini-3.8-flash` | default reasoning | ~9.6 s |
| `google/gemini-3.8-flash` | `reasoning.effort: "low"` | ~2.1 s |
| `qwen/qwen3.8-flash` | `reasoning.effort: "none"` | ~1.0 s |
| `anthropic/claude-haiku-5.5` | default | ~3.2 s |

Reasoning settings make the biggest difference. For voice, prefer models with prompt caching and low or no reasoning.

## GPT Realtime (premium voice)

Next to these four roles, live voice can run on OpenAI's GPT Realtime, a speech-to-speech model, for people who want the most natural voice and accept a higher price: about $0.05 a minute for `gpt-realtime-2.1` and $0.02 for `gpt-realtime-2.1-mini`, against roughly $0.005–0.01 for Sibyl voice on the Cheapest and Balanced presets. It needs an OpenAI key (OpenRouter doesn't offer the Realtime API). The deep brain still does the tools and visuals. See [voice.md](voice.md#voice-engines-sibyl-voice-and-gpt-realtime).

## Budgets and the Usage tab

Model calls — voice brain, deep brain, transcription and speech — are recorded with the cost OpenRouter reports for it (or an estimate when a provider reports none). Web searches, model-scout probes and voice warm-up requests are metered too. Budgets are checked *before* a call is made, so a cap stops spending rather than reporting it afterwards.

There are two kinds of budget, each daily and monthly:

| Budget | Where it is set | Who can set it | Effect when reached |
|---|---|---|---|
| Organization | **Admin → Organization → Organization budget** | Organization owners and admins (`org.settings`) | Model calls pause everywhere until midnight (daily) or the 1st (monthly). |
| Workspace | **Settings → Workspace → Workspace budget** | Workspace admins (`budgets.manage`) | Model calls pause in that workspace only. |

The server's environment variables stay in charge of the organization budget:

| Variable | Meaning |
|---|---|
| `SIBYL_BUDGET_DAILY_USD` | The organization's daily cap when nothing is set in the app, and the most the in-app daily budget can be. |
| `SIBYL_BUDGET_MONTHLY_USD` | The same for the monthly cap. |
| `SIBYL_BUDGET_ROUTINE_RUN_USD`, `SIBYL_BUDGET_ROUTINE_DAILY_USD` | Caps for one routine run and for one routine per day. |

So an admin can lower the organization budget in the app, but not raise it above what the server allows. Leave the in-app field empty to use the environment value.

Spend counts toward the workspace the person was in when it happened. Usage recorded without a workspace (older data) counts toward the default workspace.

When a budget is reached, Sibyl tells you in the chat which budget was hit and where to raise it. Close to a budget (85% of it), Sibyl switches to cheaper models and the Usage tab shows that it is in economy mode. The switch follows the tightest budget that applies: a workspace close to its own budget uses cheaper models even when the organization has plenty left. Economy mode swaps the voice and deep-brain models for the Cheapest preset's; the speaking voice stays the same so it does not change mid-conversation.

Agent Serve adds budgets per person and per role, request and model caps, and rate limits (see [enterprise.md](enterprise.md)). They are checked after these budgets.

**Settings → Usage** shows what you have spent today, this month and in this session, bars for the organization's budgets and for the current workspace's, and spend broken down by feature.

## Keeping costs predictable

- Pick **Cheapest** or **Balanced** and check the estimate per 100 turns in the Presets tab.
- Set `SIBYL_BUDGET_DAILY_USD` and `SIBYL_BUDGET_MONTHLY_USD` as the ceiling, then an organization budget in Admin → Organization and budgets for busy workspaces in Settings → Workspace.
- Turn **visual answers** off when you only want to talk; the deep brain prompt with the visual component library is the largest single cost.
- Set a credit limit on your OpenRouter key as a second safety net. OpenRouter's activity page shows actual spend per model.
