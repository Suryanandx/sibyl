# Changelog

Notable changes to Sibyl are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Sibyl uses semantic versioning while it is pre-1.0.

## 0.3.0 — Unreleased

The first release of Sibyl.

### Conversation

- Live voice conversation: an audio-native voice brain hears your tone and replies out loud, and hands careful work to a deep brain with `@brain`.
- Typed messages get a normal chat reply with text and visuals and are never spoken. Typing and talking share one conversation.
- Emotion cues performed by voices that support them, and removed for the rest.
- Turn merging, barge-in, hedged requests against slow providers, gapless playback and instant on-device captions.
- Hands-free mode, push-to-talk, and a composer that queues messages while Sibyl is answering.

### Visuals

- Generative UI with OpenUI: charts, tables, plans, option cards and forms next to the reply, guided by visual design rules. Buttons and forms continue the conversation.

### Tools

- Tool-calling deep brain with approval cards for any action that changes something.
- Built-in tools: web search, read webpage, weather, currency conversion, world time, calculator and Wikipedia.
- MCP client: connect stdio and Streamable HTTP servers through `mcp.config.json`.

### Models and costs

- Everything runs on one OpenRouter key: chat, transcription and speech.
- Model scout that picks models from the live OpenRouter catalog by cost, Design Arena benchmarks and measured latency, with Cheapest, Balanced, Fastest and Best quality presets.
- `models.config.json` to pin models or choose them by hand (`MODEL_SELECTION=manual`).
- Cost metering with the cost OpenRouter reports, daily and monthly budgets (`SIBYL_BUDGET_*`), and a Usage tab.

### Storage and access

- Conversations stored on the server in SQLite (`SIBYL_DATA_DIR`) and continued in place with full context.
- Single-owner sign-in with `SIBYL_OWNER_TOKEN`.

### Web app

- A redesigned interface: rail, searchable conversation history, model menu, Models & voice dialog with presets, usage and diagnostics, light and dark themes, and a responsive layout.

### Deployment

- Docker images for the web app and gateway, and a Compose file.
