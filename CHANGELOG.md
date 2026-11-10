# Changelog

Notable changes to Sibyl are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Sibyl uses semantic versioning while it is pre-1.0.

## 0.4.0 — Unreleased

Teams, agents and the enterprise edition.

### Teams and identity

- Accounts with an owner set-up screen, invitations by link or e-mail, workspaces, and built-in roles (owner, admin, member, viewer) checked on every request, message and tool call.
- Two-step sign-in with an authenticator app and recovery codes.
- Admin: Organization (name, defaults, organization budget) and Users (roles, turn off/on, remove, invites).
- Organization and workspace budgets set in the app, alongside the server caps.

### Agents

- Agents you build: generated avatars, their own voice and instructions, access ("everything I can use" or controlled), autonomy (ask first, act then tell me, fully autonomous) and per-agent budgets.
- Learning: agents propose skills from experience; you approve them, or let them learn automatically, and can roll back.
- Agent computers: a sandboxed browser per agent in Docker, watchable live, with approvals for logins, form submits and purchases and private networks blocked.
- Agents in Slack and Microsoft Teams channels; Slack and Teams notifications.
- Routines and monitors run as agents. Monitors watch mail, calendars, files, CRM records, web pages and feeds.

### Knowledge, skills and plugins

- Knowledge bases from almost any file: PDF (scanned too), Word, Excel, PowerPoint, OpenDocument, HTML, e-mail, EPUB, code, images, ZIP archives and folders, plus web pages and notes. Images and scans are read by a vision model, metered like every call.
- Save a chat attachment to knowledge in one click.
- Skills (instruction packs loaded when relevant) and plugins (skills, tools and settings in one install).

### Integrations and secrets

- Native connectors: Google Workspace, Microsoft 365 and Slack; HubSpot and Salesforce with an enterprise licence; MCP as an advanced option.
- Secrets vault: keys are encrypted, sent only to the hosts you allow, and the AI asks for them in a secure box.

### Slides

- Sibyl Slides, built on Presenton and rebranded: decks from a prompt, your files or connected data, edited by hand, exported as PPTX or PDF, with a "Deck ready" notice.

### Meetings

- A Meet-style room for people and agents: camera, screen share, captions, raise hand and a guest lobby.
- Agents join as participants, who speak when named, or as silent note-takers. The host can switch roles live.
- A live AI panel with summary, transcript and action items, plus Ask AI. "Create task" turns an action item into a task, with approval.
- A meeting page with the summary, transcript, actions, a timeline coloured by speaker, comments with reactions and replies, export, and save to knowledge.
- Measured cost for a note-taker: about $0.02–0.12 per meeting-hour, mostly transcription.

### Sign-up and onboarding

- Hosted sign-up with Google, Microsoft, an emailed link, or email and password with a 6-digit code. Tickets are single-use, accounts are linked, and people in several organizations choose one when they sign in.
- A short, skippable first run, the same for hosted and self-hosted:
  1. welcome
  2. model access (key checked live)
  3. style with prices
  4. tools
  5. first agent from a template
  6. knowledge
  7. team
  8. first conversation
- A Getting started checklist that ticks itself from real progress, and empty states that teach the next step.

### Hosted mode

- `SIBYL_MODE=hosted` runs many organizations on one deployment, each with its own runtime and its own secrets key. Isolation tests cover every collection and API.
- Bring your own key: an organization's OpenRouter key is checked live and used for every model call. Self-hosted installs can also set the key in the app.
- AI credits for organizations without a key: a prepaid, append-only ledger charged at the reported cost, with a test payment provider for now.

### Realtime (optional)

- LiveKit layer: WebRTC voice, group calls with people and agents, phone calls over SIP (outbound calls ask first), and live streams an agent can listen to.

### Costs

- Model prices are taken from what a typical provider charges, so preset estimates match the bill. Presets show the price per 100 typed messages and per 100 voice turns.
- Settings → Usage shows the average reply cost.

### Website and design

- [opensibyl.world](https://opensibyl.world): the landing page, a page per product and the docs, served from AWS (private S3 behind CloudFront, HTTPS) and published by GitHub Actions over OIDC. The infrastructure is in Terraform (`deploy/terraform`); a stack for the hosted app is prepared but not applied.
- Every product page has a short demo recorded live from the app, and the matching docs pages show it as a GIF. The landing page opens with a one-minute film, with captions.
- One design language across the website and the app: boxed corners (`--radius-tag`, `--radius-ctl`, `--radius-box`, `--radius-panel`), shared motion tokens, and a quick press on every button, off when reduced motion is on.

### Email

- One mailer and one layout for every email Sibyl sends: sign-in and invitations, notifications and budget alerts. HTML and plain text, light and dark, a line saying why the reader got it, and no tracking pixels. Set `SIBYL_SMTP_URL` and `SIBYL_SMTP_FROM`; Amazon SES set-up is in [configuration](docs/configuration.md#email).

### App

- Every place is a screen with its own address. Back and Forward work, and dialogs are only used for short tasks.
- One Inbox for notifications and approvals, with read state kept per person.
- A Sibyl visual inspector replaces the third-party overlay.

### Enterprise (`ee/`, licensed through Agent Serve by valnoraelric.com)

- Custom roles, per-connection grants and policies:
  - blocked tools;
  - a model allowlist;
  - a second approver;
  - data retention.
- An audit log with a hash chain, CSV/JSONL export and a signed webhook.
- Single sign-on (OpenID Connect, SAML), SCIM provisioning and session policies.
- Advanced usage controls:
  - budgets per person and per role;
  - request caps and rate limits;
  - alerts and chargeback reports.
- Call recordings.

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
