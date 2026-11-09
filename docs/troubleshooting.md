# Troubleshooting

Start with two things: the gateway's log (the terminal running `pnpm dev`, or `docker compose logs gateway`) and the **Diagnostics** tab in Models & voice.

## Setup

**`corepack pnpm install` fails, or `pnpm` is the wrong version.**
Use Node.js 22.13 or newer and run pnpm through corepack (`corepack pnpm …`), which uses the version pinned in `package.json`. A globally installed pnpm may be a different version.

**The gateway exits at startup with `LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY`.**
`.env` wasn't found or the key is empty. The file must be at the project root (or named by `OPEN_GPT_LIVE_ENV_FILE`). See [configuration.md](configuration.md#where-settings-are-read-from).

**The gateway exits with `... must be true, false, 1, or 0` or `... must be one of ...`.**
A variable has a value it doesn't accept. The message names the variable.

**`MODELS_CONFIG_FILE not found` or `... is not valid JSON`.**
Check the path, and remember the file is plain JSON: no comments or trailing commas.

## Connecting

**The page says it is reconnecting.**
- Is the gateway running? `curl http://localhost:8787/healthz`.
- Does `NEXT_PUBLIC_GATEWAY_WS_URL` match where the gateway really is? It is compiled into the web app, so rebuild after changing it.
- On an HTTPS page the gateway URL must be `wss://`.

**The connection is refused with 403 "Origin is not allowed".**
Add the page's exact origin (scheme, host and port, no path) to `ALLOWED_ORIGINS`.

**Sibyl keeps asking for the owner token.**
The token in the browser doesn't match `SIBYL_OWNER_TOKEN` on the gateway. Check for extra spaces or quotes in `.env`, and restart the gateway after changing it.

## Models

**The model list is short, or shows only "pinned" models.**
The scout hasn't finished or failed. Look for `models.scouted` or `models.scout_failed` in the log. Common causes: no credit on the OpenRouter key, or no network access from the gateway. Sibyl keeps working on the models in your config file meanwhile.

**The scout runs on every start.**
It can't write its cache. Point `SCOUT_CACHE_FILE` at a writable path (in Docker, `/app/data/model-scout.json`).

**"Voice model is not allowed" (or similar) after an update.**
The browser saved a model that is no longer in the catalog. Pick another one in the model menu.

**Replies take a long time to start.**
Open Diagnostics and look at *LLM first token*. A slow model with reasoning on is the usual cause; try the **Fastest** preset or set `reasoning.effort` to `low` or `none` for that model in `models.config.json`. See [models-and-costs.md](models-and-costs.md#latency-tips).

## Voice

**The mic button does nothing, or there is no permission prompt.**
Microphone access needs HTTPS or `localhost`. Check the browser's site permissions and that no other app is holding the microphone.

**Sibyl doesn't notice when I stop talking, or cuts me off.**
Stay quiet during the one-second calibration after you tap the mic. In a noisy room, raise `NEXT_PUBLIC_VAD_SPEECH_NOISE_MULTIPLIER`. If it ends your turns too early, raise `NEXT_PUBLIC_VAD_HANGOVER_MS` (default 400 ms); short pauses are already merged into one turn, so try that first. The Voice activity panel in Diagnostics shows the live level, noise floor and thresholds. See [configuration.md](configuration.md#voice-activity-detection).

**Sibyl interrupts itself.**
It is hearing its own voice through the speakers. Use headphones, lower the volume, or raise `NEXT_PUBLIC_VAD_PLAYBACK_THRESHOLD_MULTIPLIER`.

**Sibyl ignores what I said.**
The voice brain decided the audio had no speech meant for it (`llm.done` with reason `ignored`). Speak a little closer to the mic, or try a different voice brain.

**There is text but no sound.**
- Is **Speak replies aloud** on in the Voice tab? Typed messages are never spoken; only voice turns are.
- A "Voice reply unavailable" notice means the speech model failed; pick another voice model.
- The browser may be blocking autoplay until you interact with the page.
- `TTS_ENABLED=false` on the gateway turns speech off for everyone.

**Emotion cues are read out, or brackets appear in speech.**
They shouldn't be: cues are removed for voices without `emotionTags: true`. If a voice that supports cues reads them aloud, remove `emotionTags` from its entry in `models.config.json`.

## Visuals

**"This visual could not be rendered."**
The model wrote an invalid program. Ask again, or choose a deep brain with a higher UI benchmark (the **Best quality** preset).

**No visuals at all.**
Check **Visual answers** in the Voice tab and `GENUI_ENABLED` on the gateway.

## Tools

**Web search isn't available.**
It needs an OpenRouter key; the log shows `tools.web_search_unavailable` otherwise.

**An MCP server's tools don't appear.**
Look for `tools.mcp_config_failed` or `mcp.*` lines in the log. Check the server name (letters, digits, `_`, `-`), that the command exists on the gateway host (or inside the container), and that any `${VAR}` it uses is set. Restart the gateway after editing `mcp.config.json`. See [tools.md](tools.md).

**An approval card never appeared and the reply stopped.**
Approvals expire after 10 minutes and are cancelled when you stop the reply or reconnect. Ask again.

## Costs

**Sibyl says a budget is used up.**
The message names the variable to raise (`SIBYL_BUDGET_DAILY_USD` or `SIBYL_BUDGET_MONTHLY_USD`). The Usage tab shows what was spent and on what.

**Spending is higher than expected.**
The deep brain with visuals is the largest cost per turn. Use the Cheapest or Balanced preset, set budgets, and compare with your OpenRouter activity page.

## Still stuck

Open an issue at <https://github.com/Suryanandx/sibyl/issues> with your browser, how you run Sibyl (dev, Docker, behind a proxy), the relevant gateway log lines, and the Diagnostics numbers. Remove API keys, tokens and personal content first.
