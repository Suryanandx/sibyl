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
| `SIBYL_BUDGET_DAILY_USD` | unset | Stop model calls for the rest of the day once this much has been spent. Also the most the in-app organization budget (Admin → Organization) can be. |
| `SIBYL_BUDGET_MONTHLY_USD` | unset | Stop model calls for the rest of the month once this much has been spent. Also the most the in-app organization budget can be. |
| `SIBYL_BUDGET_ROUTINE_RUN_USD` | unset | Cap for a single routine run (used by routines, which are on the roadmap). |
| `SIBYL_BUDGET_ROUTINE_DAILY_USD` | unset | Daily cap per routine (used by routines). |

Budgets are in US dollars; invalid or negative values are ignored with a warning in the log. See [models-and-costs.md](models-and-costs.md#budgets-and-the-usage-tab).

## Sibyl Slides

Settings for the gateway and web app. The engine's own settings (`SIBYL_SLIDES_MODEL`, `SIBYL_SLIDES_IMAGE_PROVIDER`, ports, data folder) are in [slides.md](slides.md#configuration).

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_SLIDES_URL` | `http://localhost:8000` (`http://slides:8000` in compose) | Where the gateway reaches the deck engine. When unset, the slides tools are registered only if the engine answers at the default address when the gateway starts. |
| `SIBYL_SLIDES` | on | Set to `false` to turn Slides off: no slides tools in chat, and the library says Slides is not running. |
| `SIBYL_SLIDES_MODEL` | `deepseek/deepseek-v4.1-flash` | Set it on the engine. The gateway asks the engine which model and price it uses, so it only reads this value when the engine cannot tell it. |
| `SIBYL_SLIDES_USD_PER_SLIDE` | `0.004` | Pre-build estimate per slide when neither the engine's price nor an actual build cost is known. Recorded costs are the engine's actual ones. |
| `SIBYL_SLIDES_TIMEOUT_MS` | `600000` | How long the gateway waits for one deck build or export. |
| `SIBYL_SLIDES_EDITOR_BASE` | `/slides` | Path the web app serves the editor under (editor links in cards). |
| `SIBYL_SLIDES_WEB_URL` | `http://localhost:3100` | Web app only (read by `next.config.mjs` at build and start): where `/slides/*` is proxied to. `http://slides:3100` in compose. |

`SIBYL_OWNER_TOKEN` is shared: when set, the gateway sends it to the engine, and the engine refuses calls without it.

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

## Agents in Slack and Teams

See [slack-and-teams.md](slack-and-teams.md).

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_PUBLIC_GATEWAY_URL` | unset | Public HTTPS base address of the gateway. Slack's redirect and Events URLs and Teams subscriptions use it; Teams subscriptions are not created without it. |
| `SIBYL_SLACK_CLIENT_ID`, `SIBYL_SLACK_CLIENT_SECRET` | unset | Slack app credentials from the environment (the vault, set in Integrations, takes precedence). |
| `SIBYL_SLACK_SIGNING_SECRET` | unset | Slack signing secret from the environment (same precedence). Slack events are refused (503) until one is set. |
| `SIBYL_PRESENCE` | on | `false` turns off agents in Slack and Teams and the Slack/Teams notification channels. |
| `SIBYL_PRESENCE_MODEL` | default chat model | Model for agents answering in channels, when the agent has no model preset. |

## Files and knowledge OCR

Which files are accepted, and how each is read, is in [knowledge.md](knowledge.md#supported-files).

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_UPLOAD_MAX_MB` | `20` | Largest file accepted, for chat attachments, knowledge and every file inside a ZIP. |
| `SIBYL_KNOWLEDGE_OCR` | on | Set to `false` to stop knowledge from reading images and scanned PDFs with a model. |
| `SIBYL_OCR_MODEL` | unset | Vision model that reads images and scans for knowledge. Unset: `SIBYL_VISION_MODEL`, else the cheapest image-reading model in the model catalog. |
| `SIBYL_OCR_PDF_ENGINE` | `mistral-ocr` | OpenRouter `file-parser` engine for scanned PDFs (`mistral-ocr`, `cloudflare-ai`, or `native` to let the model read the PDF itself). |
| `SIBYL_OCR_USD_PER_PAGE` | `0.002` | Price per scanned page used for the budget check before the call (the recorded cost is the provider's). |
| `SIBYL_OCR_BASE_URL` | the LLM base URL | OpenAI-compatible endpoint for OCR calls (same key as the LLM). |

## Enterprise governance (roles, policies, audit log)

Custom roles, policies and the audit log need no settings of their own: they
turn on with a licence key that includes `custom_roles`, `policies` or
`audit_log` (`SIBYL_LICENSE_KEY`), and are configured in Admin. Audit log
streaming keeps its signing secret in the secrets vault, so it needs the
vault's key (`SIBYL_SECRET_KEY` or `data/secret.key`). Data retention runs on
the routine scheduler. See [enterprise.md](enterprise.md).

## Single sign-on, SCIM and session policies (Agent Serve)

Providers, domains, SCIM tokens and session policies are set in the app (Admin); see [enterprise.md](enterprise.md). The gateway reads:

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_PUBLIC_GATEWAY_URL` | the request's own address | Public address of the gateway. SSO builds the OpenID Connect redirect URI, the SAML entity ID / ACS URL and the SCIM base URL from it. Set it behind a reverse proxy. |
| `SIBYL_APP_URL` | first of `ALLOWED_ORIGINS` | Where the browser goes after an SSO sign-in (the web app). |
| `SIBYL_SSO_ALLOW_PRIVATE_NETWORK` | `false` | Allow an identity provider on a private or local address (on-premises, or a test IdP), and plain `http` for it. Otherwise OpenID Connect requests go only to public `https` addresses. |
| `SIBYL_SECRET_KEY` | `data/secret.key` | Also encrypts two-step verification secrets and OpenID Connect client secrets (see [secrets.md](secrets.md)). |

## Notifications

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_NOTIFICATION_RETENTION_DAYS` | `90` | Inbox notices older than this are deleted. The check runs every 6 hours on the routine scheduler. `0` keeps them forever. |

A notice for one person is read once. A notice for the whole workspace is read per person, so reading it doesn't clear it for anyone else. Deciding an approval clears its notice for everyone.

## Enterprise: advanced usage controls

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_USAGE_WEBHOOK_PRIVATE` | `false` | Allow the usage-alert webhook to reach a private or local address, for example a receiver on your own network. Leave it off unless you need it. See [enterprise.md](enterprise.md#advanced-usage-controls). |

## Agent computers

Agents can have their own sandboxed browser ([agent-computers.md](agent-computers.md)). It needs Docker on the gateway's machine and the sandbox image (`docker build -f Dockerfile.computer -t sibyl-computer:1.64.1 .`). Without Docker the feature shows as unavailable; a browser never runs on the host.

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_COMPUTERS` | on | `off` removes the feature: no computer tools, no sandboxes. |
| `SIBYL_COMPUTER_IMAGE` | `sibyl-computer:1.64.1` | Sandbox image. Its Playwright version must match the gateway's `playwright-core`. |
| `DOCKER_HOST` | the local socket | Docker Engine socket (`unix://…` only). Otherwise `/var/run/docker.sock` or `~/.docker/run/docker.sock`. |
| `SIBYL_COMPUTER_NETWORK` | unset | Docker network for sandboxes. Unset: the default bridge, with the browser port published on `127.0.0.1` only. Set it when the gateway itself runs in a container on that network. |
| `SIBYL_COMPUTER_PROXY_HOST` | `host.docker.internal` | How sandboxes reach the gateway's egress proxy (the gateway's container name when it runs in Compose). |
| `SIBYL_COMPUTER_PROXY_BIND` | `127.0.0.1` (`0.0.0.0` on Linux) | Where the egress proxy listens. It only serves sandboxes that hold its per-sandbox credentials. |
| `SIBYL_COMPUTER_PROXY_PORT` | any free port | Fixed port for the egress proxy. |
| `SIBYL_COMPUTER_IDLE_MINUTES` | `5` | Stop a sandbox after this many idle minutes (agents can set their own). |
| `SIBYL_COMPUTER_DAILY_MINUTES` | `60` | Computer time per agent per day (UTC) before it pauses (agents can set their own). |
| `SIBYL_COMPUTER_MAX_SESSION_MINUTES` | `60` | Longest life of one sandbox; it starts fresh on the next action. |
| `SIBYL_COMPUTER_MAX_PER_WORKSPACE` | `3` | Sandboxes running at once in one workspace. |
| `SIBYL_COMPUTER_CPUS` | `1` | CPU limit per sandbox. |
| `SIBYL_COMPUTER_MEMORY_MB` | `1024` | Memory limit per sandbox (no swap). |
| `SIBYL_COMPUTER_PIDS` | `256` | Process limit per sandbox. |
| `SIBYL_COMPUTER_FILES_MB` | `200` | Size of each agent's file area. |
| `SIBYL_COMPUTER_USD_PER_HOUR` | `0` | Price of computer time. Above 0 it is metered as usage and counts toward the agent's and the owner's budgets. |

## Realtime layer (LiveKit)

Optional. Leave these unset and voice stays on the WebSocket path. See [realtime.md](realtime.md).

| Variable | Default | Purpose |
|---|---|---|
| `LIVEKIT_URL` | unset | Where the gateway reaches LiveKit (`ws://livekit:7880` in compose, `wss://…` for LiveKit Cloud). Realtime is on only when this and the two keys below are set. |
| `LIVEKIT_API_KEY` | unset | LiveKit API key. Compose's LiveKit uses it too (default name `sibyl`; keep `webhook.api_key` in `deploy/livekit/livekit.yaml` the same). |
| `LIVEKIT_API_SECRET` | unset | LiveKit API secret, 32 characters or more. Stays on the server. |
| `LIVEKIT_PUBLIC_URL` | `LIVEKIT_URL` | The address browsers use (for example `ws://localhost:7880`, or `wss://livekit.example.com` behind TLS). |
| `LIVEKIT_NODE_IP` | `127.0.0.1` | Compose only: the IP LiveKit announces for media. Use the server's public IP in production. |
| `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` | unset | Use an outbound SIP trunk you created yourself instead of the one Settings sets up. |
| `LIVEKIT_SIP_FROM_NUMBER` | the line's number | Caller ID for outgoing calls (E.164). |
| `INGRESS_WHIP_PORT` | `8080` | Compose only: host port for WHIP streams. |

### Call recordings (Agent Serve, feature `recordings`)

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_RECORDINGS_DIR` | `$SIBYL_DATA_DIR/recordings` | Where the gateway finds recordings. |
| `SIBYL_RECORDINGS_EGRESS_DIR` | `/recordings` | The same folder as the egress container sees it (compose mounts one volume in both). |
| `SIBYL_RECORDINGS_RETENTION_DAYS` | `30` | Recordings older than this are deleted (checked every hour). |
| `SIBYL_RECORDINGS_S3_BUCKET` | unset | Keep recordings in S3-compatible storage instead. Egress uploads; downloads are 5-minute presigned links. |
| `SIBYL_RECORDINGS_S3_REGION` | `us-east-1` | Bucket region. |
| `SIBYL_RECORDINGS_S3_ENDPOINT` | AWS | Custom endpoint (MinIO, R2, …). |
| `SIBYL_RECORDINGS_S3_ACCESS_KEY`, `SIBYL_RECORDINGS_S3_SECRET_KEY` | unset | Credentials (required with a bucket). |
| `SIBYL_RECORDINGS_S3_FORCE_PATH_STYLE` | `true` with an endpoint | Bucket in the path instead of the host name. |

## Meetings

See [meetings.md](meetings.md). The room needs the realtime layer (`LIVEKIT_*`, [realtime.md](realtime.md)).

| Variable | Default | What it does |
|---|---|---|
| `SIBYL_MEETING_MODEL` | the cheapest preset (else the voice model) | Model that writes meeting notes |
| `SIBYL_MEETING_NOTES_INTERVAL_SECONDS` | `180` | How often notes refresh while a meeting runs (minimum 10) |

## Hosted Sibyl

One deployment for many organizations. Leave `SIBYL_MODE` unset for a normal self-hosted install. See [hosting.md](hosting.md).

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_MODE` | `self-hosted` | `hosted`: many organizations, each with its own runtime, created at sign-up. No first-run setup, owner token or Enterprise modules. |
| `SIBYL_TENANT_IDLE_MINUTES` | `15` | Hosted: an organization's runtime is unloaded after this long without requests, open connections or running jobs. |
| `SIBYL_PLATFORM_TOKEN` | unset | Hosted: Bearer token for the operator API (`/api/platform/*`: grant credits, sign-up tickets). Unset: no operator API. |
| `OPENROUTER_API_KEY` | unset | Hosted: the platform key. Organizations without their own key run on it and pay with AI credits. |
| `SIBYL_CREDITS_MARGIN` | `0` | Hosted: added to OpenRouter's reported cost when credits are charged, as a fraction (`0.2` = 20%). |
| `SIBYL_CREDITS_WELCOME_USD` | `0` | Hosted: credits every new organization gets (at most 1000). |
| `SIBYL_PAYMENTS` | unset | How organizations buy credits in the app. Only `test` exists (purchases complete at once, nobody is charged; never in production). Unset: buying is off; operators grant credits. |

## Sign-up and sign-in methods

Emailed links and codes, and Continue with Google / Microsoft. Hosted Sibyl uses them for sign-up; self-hosted Sibyl for invited people to sign in. See [hosting.md](hosting.md#sign-up).

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_SMTP_URL` | unset | Needed for sign-in links and sign-up codes (the gateway's one mailer). Unset: those options are hidden. |
| `SIBYL_SIGNIN_GOOGLE_CLIENT_ID`, `SIBYL_SIGNIN_GOOGLE_CLIENT_SECRET` | unset | The platform's Google sign-in app. Both set: "Continue with Google" appears. Not the Google connector (`SIBYL_GOOGLE_*`). |
| `SIBYL_SIGNIN_MICROSOFT_CLIENT_ID`, `SIBYL_SIGNIN_MICROSOFT_CLIENT_SECRET` | unset | The platform's Microsoft sign-in app. Both set: "Continue with Microsoft" appears. Not the Microsoft connector (`SIBYL_MICROSOFT_*`). |
| `SIBYL_SIGNIN_MICROSOFT_TENANT` | `common` | Which Microsoft accounts may sign in: `common` (work and personal), `organizations`, `consumers`, or one tenant id. |
| `SIBYL_SIGNIN_GOOGLE_ISSUER`, `SIBYL_SIGNIN_MICROSOFT_ISSUER` | Google's / Microsoft's | Another OpenID Connect issuer (a local mock provider for testing). |
| `SIBYL_SIGNIN_ALLOW_PRIVATE_NETWORK` | `false` | Allow an issuer on a private network or plain http (local testing only). |
| `SIBYL_APP_URL` | the request's origin | The web app's address, used in emailed links and after Google / Microsoft. |
| `SIBYL_PUBLIC_GATEWAY_URL` | the request's origin | The gateway's public address, for the Google / Microsoft redirect URI. |

## Media (images, video, audio)

Made with the media models on OpenRouter, in chat (Create mode or the `create_image` / `create_video` / `create_audio` tools); kept in Spaces → Media. See [media.md](media.md).

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_MEDIA` | on | `off` turns media generation off (tools, `/api/media`, the composer modes). Needs `OPENROUTER_API_KEY`. |
| `SIBYL_MEDIA_APPROVE_ABOVE_USD` | `0.25` | Media tool calls from chat and agents wait for an approval when their estimate is above this. Create-mode messages never ask (the price is on the pill). |
| `SIBYL_MEDIA_IMAGE_MODEL` | `google/gemini-2.5-flash-image` | Default image model (an OpenRouter id). |
| `SIBYL_MEDIA_VIDEO_MODEL` | `bytedance/seedance-2.0-fast` | Default video model. |
| `SIBYL_MEDIA_SPEECH_MODEL` | `hexgrad/kokoro-82m` | Default voice-over model. |
| `SIBYL_MEDIA_MUSIC_MODEL` | `google/lyria-3-clip-preview` | Default music model. |
| `SIBYL_MEDIA_BASE_URL` | `https://openrouter.ai/api/v1` | Another OpenRouter-compatible address for media calls. |
| `SIBYL_PUBLIC_GATEWAY_URL` | unset | Also used by media: reference videos and audio are fetched by the provider from a signed link on this address (OpenRouter takes them only over HTTPS). |

## Phone line

The phone line has no settings of its own in `.env`: owners and admins set it up in Settings → Admin → Phone ([realtime.md](realtime.md#phone-calls)). It needs the realtime layer (`LIVEKIT_*`). LiveKit phone numbers need `LIVEKIT_URL` at LiveKit Cloud (`*.livekit.cloud`). The SIP trunk password is kept in the vault, so `SIBYL_SECRET_KEY` should be set. `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` and `LIVEKIT_SIP_FROM_NUMBER` (above) still override the line for outbound calls.
