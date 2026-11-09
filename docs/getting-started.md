# Getting started

This guide takes you from a fresh clone to a spoken conversation with Sibyl on your own machine.

## What you need

- **Node.js 22.13 or newer.** Check with `node --version`.
- **pnpm**, through corepack. Corepack ships with Node and installs the exact pnpm version the repository pins (`packageManager` in `package.json`). You do not need a global pnpm.
- **An OpenRouter API key.** Create one at <https://openrouter.ai/keys> and add a little credit. One key covers chat, transcription and speech.
- **A browser with a microphone.** Chrome or Edge is recommended; see [browser-support.md](browser-support.md).

## 1. Install

```bash
git clone https://github.com/Suryanandx/sibyl.git
cd sibyl
corepack enable
corepack pnpm install
```

If `corepack enable` needs permissions you don't have, skip it and prefix every pnpm command with `corepack`, as in the rest of these docs.

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set your key:

```dotenv
OPENROUTER_API_KEY=sk-or-...
```

That is all you need. The rest of `.env.example` already holds sensible defaults. Every variable is documented in [configuration.md](configuration.md).

Optionally, copy the model allowlist so you can edit it:

```bash
cp models.config.example.json models.config.json
```

Without a `models.config.json`, the gateway falls back to `models.config.example.json`. Models listed in either file stay available next to the scout's picks, marked "pinned". See [models-and-costs.md](models-and-costs.md).

## 3. Run

```bash
corepack pnpm dev
```

This starts both processes:

| Process | URL |
|---|---|
| Web app | <http://localhost:3000> |
| Gateway WebSocket | `ws://localhost:8787` |
| Gateway health check | <http://localhost:8787/healthz> |

On the first start the model scout reads the OpenRouter catalog and measures latency in the background. This takes about a minute and sends a few dozen small paid requests. Sibyl works immediately on the models from your config file and switches to the scout's picks when they are ready; connected sessions update live. The result is cached for 24 hours in `.model-scout.json`, relative to the gateway's working directory (`apps/gateway` during development), so later starts are instant.

## 4. Talk or type

Open <http://localhost:3000>. If you set `SIBYL_OWNER_TOKEN`, enter it once; the browser remembers it.

- **Typing:** use the composer. You get a normal chat reply with text and visuals, and nothing is read aloud. Messages you send while Sibyl is still answering join a queue; you can reorder, edit or remove them before they go.
- **Hands-free voice:** tap the mic button and allow microphone access. Wait a moment while Sibyl calibrates to the room noise, then speak normally. Sibyl replies out loud when you pause. Talk over it to interrupt. Tap again to end voice mode.
- **Push-to-talk:** press and hold the mic button, speak, release.

Typing and talking share one conversation, so you can switch at any time.

Try something that benefits from a visual, such as "compare three weekend trips from Berlin under 300 euros", or something that needs fresh information, such as "what's the weather in Lisbon this weekend?". The deep brain uses its tools, then answers with a table or plan. In voice mode, the voice acknowledges you first and a short spoken summary follows the visual.

Conversations are saved on the gateway. Open one from the history in the sidebar to carry on where you left off, with its full context.

## 5. Choose models

The pill in the composer opens the **model menu**: pick a preset or search for a specific model. The **Models & voice** dialog (rail button) has five tabs:

- **Presets** — Cheapest, Balanced, Fastest and Best quality, each with its models and estimated cost per 100 turns.
- **Models** — the voice brain, the deep work model and the transcription model, with price, measured speed and benchmark score.
- **Voice** — speak replies aloud, the voice model and voice, and visual answers on or off.
- **Usage** — what you have spent today, this month and in this session, and your budgets.
- **Diagnostics** — per-turn latency and the voice activity detector's live state.

Your choices are saved in the browser and re-applied when you reconnect. A model you pick yourself always wins over the scout's choice.

## Next steps

- Understand the live conversation and its timings: [voice.md](voice.md).
- Connect your own tools and data with MCP: [tools.md](tools.md).
- Tune the scout or pin models: [models-and-costs.md](models-and-costs.md).
- Deploy with Docker behind HTTPS: [deployment.md](deployment.md).
- Something not working: [troubleshooting.md](troubleshooting.md).
