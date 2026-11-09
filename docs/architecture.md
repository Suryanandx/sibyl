# Sibyl architecture (v0.3)

Sibyl is an open-source, self-hostable voice + chat assistant that runs with a
single OpenRouter key. Everything ships in this repository; nothing depends on
a hosted vendor service.

## One of everything

Each capability exists exactly once. New features build on these instead of
adding parallel versions:

| Capability | Lives in | Contract |
|---|---|---|
| Shared types: tools, approvals, storage, usage | `packages/core` | `ToolDefinition`, `ToolRegistry`, `Store`, `UsageMeter` |
| Browser ↔ gateway messages | `packages/protocol` | `WS_EVENTS`, `parseClientMessage`, `parseServerMessage` |
| Model calls (LLM, STT, TTS) | `packages/adapters` | `LLMProvider`, `STTProvider`, `TTSProvider` |
| Voice/UI split, prompts | `packages/genui` | `SpeechUiSplitter`, `VoiceReplyParser`, prompts |
| Persistence | `packages/store` (SQLite, Node's built-in `node:sqlite`) | implements `Store` |
| Brain: voice turn, deep work, tool loop, approvals | `apps/gateway/src/gateway.ts` + `apps/gateway/src/brain/*` | uses `ToolRegistry`, `Store`, `UsageMeter` |
| Tools: built-ins, MCP client | `apps/gateway/src/tools/*` | each tool is a `ToolDefinition` |
| Metering & budgets | `apps/gateway/src/metering/*` | implements `UsageMeter` |
| Model selection | `apps/gateway/src/scout.ts`, `models.ts` | presets, catalog |
| Web app | `apps/web` | |

## Rules

- **Tools** are `ToolDefinition`s registered in the one `ToolRegistry`. Reads run
  automatically; anything with `effect: "write"` (send, create, delete, spend)
  pauses for an approval card in chat, or the approval inbox for background
  work.
- **Every model call is metered** through the `UsageMeter` with the actual cost
  OpenRouter reports, and checked against budgets before it is made.
- **Credentials stay on the server.** The browser never sees API keys.
- **Protocol changes** go through `packages/protocol` with validation for
  anything the browser sends.
- **Tests**: `npx vitest run`, `corepack pnpm -r typecheck`,
  `corepack pnpm --filter @open-gpt-live/gateway build`,
  `cd apps/web && corepack pnpm build`.
