# Configuration

Sibyl is configured with environment variables and an optional model allowlist file, `models.config.json`. This page lists every variable the code reads, with its default.

## Where settings are read from

Both the gateway and the web app load the first `.env` file they find, in this order:

1. the path in `OPEN_GPT_LIVE_ENV_FILE`, if set;
2. `.env` in the directory you ran `pnpm` from;
3. `.env` in the process's working directory;
4. `.env` two levels up (the repository root, when a process runs from `apps/*`).

Variables already set in the environment win over the file.

Start from the example:

```bash
cp .env.example .env
```

> **Keep secrets out of `NEXT_PUBLIC_*`.** Anything with that prefix is compiled into the browser bundle. API keys belong only in the gateway's environment.

## Minimal setup

```dotenv
OPENROUTER_API_KEY=sk-or-...
```

With an OpenRouter key and no `OPENAI_BASE_URL`, the gateway uses OpenRouter for chat, transcription and speech, the model scout picks models (`MODEL_SELECTION=auto`), live conversation is on, visual answers are on, built-in tools are on, and conversations are stored in SQLite under `apps/gateway/data` during development.

For anything other than your own machine, also set `SIBYL_OWNER_TOKEN` and `ALLOWED_ORIGINS`; see [deployment.md](deployment.md).

## Storage, sign-in, tools and budgets

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_DATA_DIR` | `./data` (relative to the gateway's working directory) | Folder for the SQLite database, `sibyl.db`. Conversations, approvals, usage records and tool switches live here. Must be writable. |
| `SIBYL_STORAGE` | SQLite | Set to `memory` to keep everything in memory only. Nothing survives a restart. Useful for tests and demos. |
| `SIBYL_OWNER_TOKEN` | unset | When set, the gateway refuses WebSocket connections that don't carry this token. The web app asks for it once and remembers it in the browser. Use a long random value. |
| `SIBYL_BUILTIN_TOOLS` | on | Set to `false` to turn off the built-in tools. |
| `SIBYL_WEB_SEARCH_MODEL` | `google/gemini-3.8-flash` | OpenRouter model used for web search. |
| `SIBYL_MCP_CONFIG` | `mcp.config.json` at the project root | Path to the MCP server list. See [tools.md](tools.md). |
| `SIBYL_MCP_CONNECT_TIMEOUT_MS` | `20000` | Connect timeout per MCP server. |
| `SIBYL_MCP_CALL_TIMEOUT_MS` | `120000` | Timeout for one MCP tool call. |
| `SIBYL_BUDGET_DAILY_USD` | unset | Stop model calls for the rest of the day once this much has been spent. |
| `SIBYL_BUDGET_MONTHLY_USD` | unset | Stop model calls for the rest of the month once this much has been spent. |
| `SIBYL_BUDGET_ROUTINE_RUN_USD` | unset | Cap for a single routine run (used by routines, which are on the roadmap). |
| `SIBYL_BUDGET_ROUTINE_DAILY_USD` | unset | Daily cap per routine (used by routines). |

Budgets are in US dollars; invalid or negative values are ignored with a warning in the log. See [models-and-costs.md](models-and-costs.md#budgets-and-the-usage-tab).

## Provider and models

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | none | Your OpenRouter key. Required when the provider is OpenRouter. |
| `LLM_PROVIDER` | auto | `openrouter` or `openai`. When unset, OpenRouter is used if `OPENROUTER_API_KEY` is set and `OPENAI_BASE_URL` is not. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base URL. |
| `OPENROUTER_SITE_URL` | project repository URL | Sent as the `HTTP-Referer` attribution header to OpenRouter. |
| `OPENROUTER_APP_NAME` | `Sibyl` | Sent as the `X-Title` attribution header to OpenRouter. |
| `MODELS_CONFIG_FILE` | see below | Path to the model allowlist. Relative paths resolve from where you ran `pnpm`, the working directory, or the repository root. The gateway stops with an error if the file you name does not exist. |
| `MODELS_DISCOVER_VOICES` | `true` with OpenRouter, else `false` | At startup, fill in voice lists for speech models that list none, from OpenRouter's catalog. |
| `MODEL_SELECTION` | `auto` with OpenRouter, else `manual` | `auto`: the model scout picks models from the live catalog. `manual`: use only `models.config.json`. |
| `MODEL_STRATEGY` | `balanced` | Default preset when the scout runs: `cheapest`, `balanced`, `fastest` or `best`. |
| `SCOUT_PROBE` | `true` | Measure live latency with a few small paid requests when the scout runs. `false` ranks on cost and quality only. |
| `SCOUT_CACHE_FILE` | `.model-scout.json` | Where the scout caches its results for 24 hours. Set to `off` to disable the cache. |

When `MODELS_CONFIG_FILE` is not set, the gateway looks for `models.config.json` and then `models.config.example.json`, each in the directory you ran `pnpm` from, the working directory and the repository root.

### Building the catalog from variables

Without any config file, these comma-separated lists build the model catalog. Each entry is either `id` or `id|Label`.

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_MODELS` | empty | Audio-native voice brain models. Live conversation needs at least one, here or in the config file. |
| `LLM_MODELS` | empty | Deep brain (chat) models. |
| `STT_MODELS` | empty | Transcription models. |
| `TTS_MODELS` | empty | Speech models. |

Entries from these lists are added to whatever the config file already lists.

## Conversation behaviour

| Variable | Default | Purpose |
|---|---|---|
| `LIVE_CONVERSATION` | `true` | Use the voice brain + deep brain pair. Only takes effect when at least one voice model is configured. `false` uses a single model per turn: transcribe, answer, speak. |
| `GENUI_ENABLED` | `true` | Allow visual answers (OpenUI). Users can still turn visuals off per browser. |
| `ASSISTANT_NAME` | `Sibyl` | The name the voice and deep brain prompts use. |
| `HEDGE_REQUESTS` | `true` | Send a backup request when the voice brain or speech is slow to start. See [voice.md](voice.md#hedged-requests). |
| `HEDGE_VOICE_AFTER_MS` | `1200` | Wait this long for the voice brain's first word before asking a backup voice model. 200–30000. |
| `HEDGE_TTS_AFTER_MS` | `1500` | Wait this long for a speech segment to start before sending a duplicate request. 200–30000. |

## Gateway server

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_HOST` | `0.0.0.0` | Interface the HTTP/WebSocket server listens on. |
| `GATEWAY_PORT` | `8787` | Port for WebSocket sessions and `/healthz`. |
| `ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins (`https://sibyl.example.com`) allowed to open a WebSocket. Empty allows every origin, which is only appropriate for local development. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `NODE_ENV` | unset | `production` turns on stricter credential checks at startup (see below). |

`ALLOWED_ORIGINS` checks the browser's `Origin` header. It is not authentication: clients that send no `Origin` header (scripts, native apps) are allowed through. Use `SIBYL_OWNER_TOKEN` to require a token. See [deployment.md](deployment.md#protecting-the-gateway).

## Using a different OpenAI-compatible provider

Sibyl's adapters speak the OpenAI HTTP API, so you can point them at another compatible service instead of OpenRouter. In this mode the model scout is off by default and the catalog comes from `models.config.json` or the `*_MODELS` lists, so list model ids your provider actually serves.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Chat credential. With OpenRouter, used as a fallback when `OPENROUTER_API_KEY` is empty. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Chat API base URL. Setting it makes the provider default to `openai`. |
| `OPENAI_MODEL` | `google/gemini-3.8-flash` with OpenRouter, `gpt-4o-mini` otherwise | Fallback chat model when the catalog lists none. If it names a model that is in the catalog, it becomes the default. `LLM_MODEL` is accepted as an alias. |
| `STT_API_KEY` | chat key | Transcription credential. |
| `STT_BASE_URL` | chat base URL | Transcription API base URL. |
| `STT_MODEL` | `openai/gpt-4o-mini-transcribe` with OpenRouter, `whisper-1` otherwise | Fallback transcription model. |
| `TTS_ENABLED` | `true` when a key exists | Turn spoken replies on or off for everyone. |
| `TTS_API_KEY` | chat key | Speech credential. |
| `TTS_BASE_URL` | chat base URL | Speech API base URL. |
| `TTS_MODEL` | `hexgrad/kokoro-82m` with OpenRouter, `tts-1` otherwise | Fallback speech model. |
| `TTS_VOICE` | `af_heart` with OpenRouter, `alloy` otherwise (only when `TTS_MODEL` is unset) | Fallback voice. |
| `TTS_FORMAT` | `mp3` | Audio format requested from the speech API. A model entry can override it (for example `pcm`). |

Keys are optional for self-hosted HTTP endpoints; the adapters then omit the `Authorization` header. With `NODE_ENV=production`, the gateway refuses to start if an endpoint on `api.openai.com` has no key.

Live conversation needs an audio-native voice model. If your provider has none, leave `voice` out of `models.config.json` (and `VOICE_MODELS` empty) and Sibyl uses the single-model pipeline.

### OpenAI Realtime transcription

An optional streaming transcription path for hands-free mode, which talks to OpenAI's Realtime WebSocket API directly (it is not an OpenRouter feature). It sends partial transcripts while you speak; if it fails, the gateway falls back to batch transcription.

| Variable | Default | Purpose |
|---|---|---|
| `STT_REALTIME_ENABLED` | `false` | Turn the Realtime transcription adapter on. Requires `STT_API_KEY` or `OPENAI_API_KEY`. |
| `STT_REALTIME_URL` | `wss://api.openai.com/v1/realtime` | Realtime WebSocket endpoint. |
| `STT_REALTIME_MODEL` | `gpt-realtime-whisper` | Streaming transcription model. |
| `STT_REALTIME_LANGUAGE` | empty | Optional language hint, such as `en`. |
| `STT_REALTIME_DELAY` | empty | `minimal`, `low`, `medium`, `high` or `xhigh`. |

## Web app (build time)

These are compiled into the browser bundle. Rebuild the web app (or the web Docker image) after changing them.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_GATEWAY_WS_URL` | `ws://localhost:8787` | Where the browser connects. Must be `wss://` when the page is served over HTTPS. |
| `NEXT_PUBLIC_LIVE_CAPTIONS` | on | Instant captions from the browser's speech recognition while you speak. Set `false` to turn them off. In Chrome, this recognition is processed by the browser vendor's service. |

### Voice activity detection

Hands-free mode detects speech in the browser with an adaptive volume (RMS) detector. It samples the room for a moment, then derives separate thresholds for starting and ending speech from a moving noise floor. The noise floor is frozen while you speak, so your voice can't teach it that speech is background noise.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_VAD_ADAPTIVE_ENABLED` | `true` | Use room calibration and the adaptive noise floor. `false` uses the fixed thresholds below. |
| `NEXT_PUBLIC_VAD_CALIBRATION_MS` | `1000` | Room sampling time when hands-free mode starts. |
| `NEXT_PUBLIC_VAD_NOISE_FLOOR_SMOOTHING` | `0.08` | How quickly the idle noise floor follows the room. Higher adapts faster. |
| `NEXT_PUBLIC_VAD_SPEECH_NOISE_MULTIPLIER` | `3` | Noise floor × this = threshold to start speech. |
| `NEXT_PUBLIC_VAD_SILENCE_NOISE_MULTIPLIER` | `1.8` | Noise floor × this = threshold for silence. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SPEECH_MIN` | `0.012` | Lowest allowed adaptive speech threshold. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SPEECH_MAX` | `0.12` | Highest allowed adaptive speech threshold. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SILENCE_MIN` | `0.006` | Lowest allowed adaptive silence threshold. |
| `NEXT_PUBLIC_VAD_DYNAMIC_SILENCE_MAX` | `0.08` | Highest allowed adaptive silence threshold (always kept below the speech threshold). |
| `NEXT_PUBLIC_VAD_SPEECH_THRESHOLD` | `0.02` | Fixed speech threshold when adaptive mode is off. |
| `NEXT_PUBLIC_VAD_SILENCE_THRESHOLD` | `0.012` | Fixed silence threshold when adaptive mode is off. |
| `NEXT_PUBLIC_VAD_START_DEBOUNCE_MS` | `160` | Sound must last this long before a turn starts. |
| `NEXT_PUBLIC_VAD_MIN_SPEECH_MS` | `200` | Turns with less voiced audio than this are discarded (coughs, taps). |
| `NEXT_PUBLIC_VAD_HANGOVER_MS` | `400` | Silence needed to end a turn. |
| `NEXT_PUBLIC_VAD_MAX_TURN_MS` | `30000` | Longest single turn. |
| `NEXT_PUBLIC_VAD_PRE_ROLL_MS` | `400` | Audio kept from just before speech was detected, so the first syllable isn't clipped. |
| `NEXT_PUBLIC_VAD_PLAYBACK_THRESHOLD_MULTIPLIER` | `2.5` | Raises the speech threshold while Sibyl is talking, to reduce echo triggering. |
| `NEXT_PUBLIC_VAD_PLAYBACK_SUPPRESS_AFTER_END_MS` | `300` | Ignore new speech for this long after playback ends. |

Invalid or out-of-range values fall back to these defaults.

## Local development helpers

| Variable | Default | Purpose |
|---|---|---|
| `OPEN_GPT_LIVE_ENV_FILE` | unset | Load this env file instead of searching for `.env`. Docker Compose also uses it to pick the file passed to the gateway container. |

## Startup validation

The gateway checks its configuration before accepting connections and exits with a clear message when something is wrong:

- `LLM_PROVIDER=openrouter` (or the automatic choice) without an OpenRouter key;
- with `NODE_ENV=production`, an `api.openai.com` endpoint without a key;
- `STT_REALTIME_ENABLED=true` without a transcription key;
- invalid ports, booleans (`true`, `false`, `1`, `0`), enums, hedge timings or origins;
- a `MODELS_CONFIG_FILE` that does not exist or is not valid JSON.

## Model allowlist

`models.config.json` controls which models people can choose in the browser and carries server-side request parameters for each model. Its format is documented in [models-and-costs.md](models-and-costs.md#the-model-allowlist).
