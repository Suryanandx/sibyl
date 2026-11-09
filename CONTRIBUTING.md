# Contributing to Sibyl

Thanks for helping make Sibyl better. Bug fixes, latency measurements, new tools, tests and clear documentation are all welcome.

## Before you start

- Search existing issues and pull requests first.
- For a large change — the protocol, the architecture, a new provider or a new kind of tool — open an issue first so we can agree on the approach and how to test it.
- Keep pull requests focused. Unrelated clean-up makes voice regressions harder to review.
- Report security problems privately; see [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22.13 or newer. pnpm comes through corepack.

```bash
corepack enable
corepack pnpm install
cp .env.example .env        # set OPENROUTER_API_KEY to try it for real
corepack pnpm dev
```

The web app runs at <http://localhost:3000> and the gateway health check at <http://localhost:8787/healthz>. The automated tests use fakes and need no API key.

## Checks

Run these before opening a pull request:

```bash
npx vitest run
corepack pnpm -r typecheck
corepack pnpm --filter @open-gpt-live/gateway build
cd apps/web && corepack pnpm build
```

`corepack pnpm check` runs typecheck, tests and both builds in one go.

## Where things live

| Path | What it does |
|---|---|
| `apps/web` | The web app: audio capture, voice activity detection, playback, conversation view, visuals, approval cards |
| `apps/gateway` | Sessions, turn-taking, the voice and deep brains, tool loop, model scout, storage and metering wiring |
| `packages/protocol` | Browser ↔ gateway message types and runtime validation |
| `packages/core` | Shared contracts: tools, approvals, storage, usage |
| `packages/adapters` | LLM, transcription and speech provider interfaces |
| `packages/genui` | Prompts and the speech/visual splitter |
| `packages/store` | SQLite storage |
| `docs` | User and contributor documentation |

The design rule is *one of everything*: each capability exists once, and new features build on it. Read [docs/architecture.md](docs/architecture.md) before adding something that looks like it needs a parallel version.

Package names keep the `@open-gpt-live/*` scope for now; use them as they are in filters and imports.

## Making a change

1. Branch from `main`.
2. Add or update tests with the change.
3. Update the docs when behaviour or configuration changes. Every environment variable belongs in [docs/configuration.md](docs/configuration.md) with its real default.
4. Run the checks above, and note any manual testing (browser, device, voice) in the pull request.
5. Explain the problem, the approach and any trade-offs in the pull request.

### What reviewers look for

| Area | Evidence |
|---|---|
| Protocol | Types and validation in `packages/protocol`, a gateway test, and an update to [docs/protocol.md](docs/protocol.md) |
| Gateway | Cancellation and cleanup on interrupt and disconnect, handling of late events, integration tests |
| Voice and latency | Before and after measurements, reproducible conditions, safe defaults |
| Tools | A `ToolDefinition` with the right `effect` (`read` or `write`), tests without network access, and an entry in [docs/tools.md](docs/tools.md) |
| Provider adapters | Honour `AbortSignal`, normalise errors, never log secrets, tests with a fake transport |
| Web app | Works on a phone-sized screen and in light and dark themes; a screenshot helps |

Don't weaken validation or change the meaning of an existing event. Prefer a small, explicit protocol addition.

## Adding a tool

Built-in tools live in `apps/gateway/src/tools/builtin`. A tool:

- is a single `ToolDefinition` registered in the one tool registry;
- declares `effect: "write"` if it sends, creates, deletes or spends anything, so it goes through an approval card;
- validates its input and keeps its output short;
- fetches model-chosen URLs only through the SSRF guard;
- has tests that don't touch the network.

## Pull request checklist

- Focused change, no unrelated generated files.
- New behaviour is tested, or the pull request says why it can't be.
- All checks pass.
- Docs match the code.
- No API keys, tokens, recordings or personal data in code, logs or fixtures.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
