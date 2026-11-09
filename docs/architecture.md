# Architecture

Sibyl is an open-source, self-hosted voice and chat assistant that runs on a single OpenRouter key. Everything ships in this repository; nothing depends on a hosted vendor service.

It runs as two processes:

- **`apps/web`** — the Next.js web app: microphone capture, voice activity detection, gapless playback, the conversation view, visuals and approval cards.
- **`apps/gateway`** — a Node HTTP/WebSocket server: sessions, turn-taking, model calls, tools, storage, metering and model selection. It holds every credential.

They talk over one WebSocket; see [protocol.md](protocol.md).

## One of everything

Each capability exists exactly once. New features build on these rather than adding parallel versions.

| Capability | Lives in | Contract |
|---|---|---|
| Shared types: tools, approvals, storage, usage | `packages/core` | `ToolDefinition`, `ToolRegistry`, `Store`, `UsageMeter` |
| Browser ↔ gateway messages | `packages/protocol` | `WS_EVENTS`, `parseClientMessage`, `parseServerMessage` |
| Model calls (LLM, STT, TTS) | `packages/adapters` | `LLMProvider`, `STTProvider`, `TTSProvider` |
| Voice/visual split, prompts | `packages/genui` | `SpeechUiSplitter`, `VoiceReplyParser`, prompts |
| Persistence | `packages/store` (SQLite through Node's built-in `node:sqlite`) | implements `Store` |
| Brain: voice turn, deep work, tool loop, approvals | `apps/gateway/src/gateway.ts` and `apps/gateway/src/brain/*` | uses `ToolRegistry`, `Store`, `UsageMeter` |
| Tools: built-ins, MCP client | `apps/gateway/src/tools/*` | each tool is a `ToolDefinition` |
| Metering and budgets | `apps/gateway/src/metering/*` | implements `UsageMeter` |
| Model selection | `apps/gateway/src/scout.ts`, `models.ts` | presets, catalog |
| Session transport (WebSocket, LiveKit room, headless) | `apps/gateway/src/session-port.ts` | `SessionTransport`, `VoiceSessionPort` |
| Realtime layer (optional LiveKit: calls, phone, streams) | `apps/gateway/src/realtime/*` | see [realtime.md](realtime.md) |
| Web app | `apps/web` | |

The gateway wires the store, tool registry and meter together in one place, `apps/gateway/src/runtime.ts`.

## Rules

- **Tools** are `ToolDefinition`s registered in the one `ToolRegistry`. Read tools run automatically. Anything with `effect: "write"` (send, create, delete, spend) pauses for an approval card in the chat. See [tools.md](tools.md).
- **Every model call is metered** through the `UsageMeter` with the actual cost OpenRouter reports, and checked against budgets before it is made.
- **Credentials stay on the server.** The browser never sees API keys or per-model request parameters.
- **Protocol changes** go through `packages/protocol`, with validation for everything the browser sends.
- **Checks** before merging:

  ```bash
  npx vitest run
  corepack pnpm -r typecheck
  corepack pnpm --filter @open-gpt-live/gateway build
  cd apps/web && corepack pnpm build
  ```

## Further reading

- [voice.md](voice.md) — the live pipeline, turn-taking and latency.
- [generative-ui.md](generative-ui.md) — how visuals are written, split and rendered.
- [models-and-costs.md](models-and-costs.md) — the model scout, presets and budgets.
