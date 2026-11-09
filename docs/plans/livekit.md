# LiveKit integration plan (wave C)

Status: **built** (2026-11-09); the user-facing page is [docs/realtime.md](../realtime.md). One change from §3 below: there is no separate `sibyl-voice` worker or `/internal/voice` bridge. The room agent runs inside the gateway with `@livekit/rtc-node` and drives the existing session through a transport seam (`apps/gateway/src/session-port.ts`), so `@livekit/agents` is not used (see realtime.md, "Why these SDKs"). Expands [v0.4 §7d](v0.4-architecture.md#7d-realtime-layer-livekit-wave-c). Versions checked today: server v1.13.11, `@livekit/agents` 1.9.5 (Node), egress v1.15.0, ingress v1.6.0, sip v1.23.0, `livekit-client` 2.23.0.

## 1. Components and licences

| Component | What it does | Licence |
|---|---|---|
| [livekit server](https://github.com/livekit/livekit) | Go WebRTC SFU: rooms, tokens, webhooks, TURN, agent dispatch | Apache-2.0 |
| [agents-js](https://github.com/livekit/agents-js) (`@livekit/agents`, plugins) | Node agent worker: `AgentSession`, VAD, turns, interruptions, tools, handoffs | Apache-2.0 |
| [sip](https://github.com/livekit/sip) | SIP/RTP bridge; phone callers join rooms as participants | Apache-2.0 |
| [egress](https://github.com/livekit/egress) | Recording/streaming out (GStreamer + headless Chrome) | Apache-2.0 |
| [ingress](https://github.com/livekit/ingress) | RTMP, WHIP, SRT and URL (HLS/MP4/MP3…) into a room | Apache-2.0 |
| `livekit-client`, `@livekit/components-react`, `livekit-server-sdk`, `@livekit/rtc-node` | Web client, React UI, token/API SDK, Node media | Apache-2.0 |

**Not Apache-2.0 — flag:**

- **Turn-detector weights** (`v1-mini` local, deprecated text model): [LiveKit Model License](https://huggingface.co/livekit/turn-detector). The full `v1` audio model runs only on LiveKit Inference ([turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector.md)).
- **Adaptive interruption** (backchannel filtering): Cloud Inference only; self-hosted agents get 40,000 free requests/month, then fall back to VAD ([docs](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling.md)).
- **Krisp / ai-coustics noise cancellation**: Cloud transport only; `@livekit/noise-cancellation-node` is under LiveKit's Terms of Service, not OSS ([docs](https://docs.livekit.io/transport/media/noise-cancellation.md)).
- **Cloud-only products**: agent hosting, LiveKit Inference, observability/session insights, LiveKit Phone Numbers (inbound only today), Twilio/WhatsApp connectors ([pricing](https://livekit.com/pricing), [phone numbers](https://docs.livekit.io/telephony/start/phone-numbers.md)).
- Egress bundles Chrome and GStreamer (LGPL plugins). This is fine for a container image; record it in `NOTICE`.

## 2. Self-hosted vs Cloud

**Fully self-hosted:** rooms, TURN, webhooks, agents (any STT/LLM/TTS), Silero VAD, `v1-mini` turn detector (model licence), SIP with your own trunk (Twilio, Telnyx…), all egress types, all ingress types, and WebRTC's own echo cancellation and noise suppression in the browser.

**Needs Cloud:** Krisp/ai-coustics, the `v1` turn detector and adaptive interruption beyond the free development allowance (7,500 and 40,000 requests/month; [quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits.md)), phone-number rental, managed agent hosting and Inference.

Sibyl stays fully self-hosted by default. `LIVEKIT_URL` can point at Cloud as an opt-in.

## 3. Recommended architecture

### Processes and ports (compose profile `realtime`)

| Service | Ports | Notes |
|---|---|---|
| `livekit` | 7880 (WS/API, behind TLS proxy), 7881/tcp, **7882/udp mux**, TURN 3478/udp + 5349/tls (or 443) | Use host networking on Linux. The UDP mux avoids exposing 50000–60000 through Docker ([ports](https://docs.livekit.io/transport/self-hosting/ports-firewall.md)) |
| `redis` | 6379, internal only | Required by egress, ingress and sip, and for multi-node ([distributed](https://docs.livekit.io/transport/self-hosting/distributed.md)) |
| `sibyl-voice` (new) | none inbound | Agent worker; dials out to livekit and the gateway |
| `egress` | internal | 4 CPU / 4 GB recommended ([egress](https://docs.livekit.io/transport/self-hosting/egress.md)) |
| `ingress` | 1935 RTMP, 8080 WHIP, 7885/udp | Separate profile `streams` ([ingress](https://docs.livekit.io/transport/self-hosting/ingress.md)) |
| `sip` | 5060 udp/tcp, 5061 tls, 10000–20000/udp RTP | Separate profile `phone` ([sip](https://docs.livekit.io/transport/self-hosting/sip-server.md)) |

### Tokens with Sibyl auth/RBAC

The gateway is the only token mint (`livekit-server-sdk` `AccessToken`). It exposes `POST /api/realtime/session`:

1. It authenticates the cookie and checks `authorize(principal, "calls.join", { workspaceId })`, plus the agent's own `agents.use`.
2. It mints a token valid for 10 minutes:
   - identity `user:<id>`;
   - room `w<ws>.c<conversation>` or `w<ws>.call<id>`;
   - `roomJoin` and `canSubscribe`;
   - `canPublishSources: [microphone]`, plus `screen_share` when allowed;
   - `canPublishData`;
   - never `roomAdmin` or `roomRecord` ([grants](https://docs.livekit.io/frontends/reference/tokens-grants.md)).
3. It dispatches agents explicitly (`AgentDispatchClient`, worker `agentName: "sibyl"`; [dispatch](https://docs.livekit.io/agents/server/agent-dispatch.md)) with metadata `{ ticket }`. The ticket is a gateway-signed, short-lived JWT carrying user, workspace, agent and conversation.

The gateway also receives LiveKit webhooks at `/api/realtime/webhook` (`WebhookReceiver` verifies the signed JWT and body hash; [webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events.md)): room finished, egress ended, participant joined (for audit). The API secret stays in the gateway and the worker.

New permissions: `calls.join`, `calls.record`, `phone.use`, `phone.manage`, `streams.ingest`.

### Brain: bridge, don't re-implement

`GatewayConnection` (`apps/gateway/src/gateway.ts`) owns the voice brain, `@brain` handoff, hedging (`hedge.ts`), metering, budgets, approvals, memory and the SQLite store (single writer). Re-implementing it inside LiveKit's pipeline would fork all of that.

**Recommendation:** extract the transport-free core of the voice turn into `apps/gateway/src/voice/session.ts`, behind a `VoiceIO` interface. The current WebSocket becomes one implementation, and an internal **bridge** (`/internal/voice`, authenticated by the ticket) becomes the second. The `sibyl-voice` worker is a thin `@livekit/agents` Node process:

- `AgentSession` provides Silero VAD, endpointing, interruptions, playout, `lk.agent.state`, and text/data streams.
- `sttNode` override: tees the user's PCM frames into a turn buffer and yields interim transcripts.
- `llmNode` override: sends the turn's audio (WAV) to the gateway bridge, which runs the existing voice brain (audio-native, hedged, metered) and streams text back ([nodes](https://docs.livekit.io/agents/logic/nodes.md)).
- `ttsNode` override: requests speech segments from the gateway (`pcm16` 24 kHz to skip MP3 decoding) and yields `AudioFrame`s. Emotion cues are handled there as today.
- Deep-brain results and approvals stay in the gateway. The web app keeps its WebSocket for visuals, approval cards and history; only media moves to WebRTC. Gists are spoken with `session.say()` when the floor is free.

### OpenRouter

There is no Node `withOpenRouter()` (it exists in Python only). `openai.LLM({ baseURL: "https://openrouter.ai/api/v1" })` works for text LLMs ([OpenAI-compatible](https://docs.livekit.io/agents/models/llm/openai-compatible-llms.md), [OpenRouter](https://docs.livekit.io/agents/models/llm/openrouter.md)). But LiveKit's LLM node takes a text `ChatContext`, so our **audio-in voice brain doesn't fit a stock plugin**. That is another reason to route through our own adapters (`packages/adapters`) via the bridge. Realtime speech-to-speech plugins (OpenAI `gpt-realtime`, GPT-Live, Gemini) need direct vendor keys. They are an optional "fastest" preset only, breaking single-key setup.

### Agents with their own voices

Each Sibyl agent is a separate dispatch of the same worker:

- participant identity `agent:<agentId>`;
- name and avatar seed in participant attributes;
- TTS voice from the agent's settings.

The web app animates the generated "dot" from `lk.agent.state` (listening, thinking, speaking: the same moods as the emblem; [agent state](https://docs.livekit.io/frontends/build/agent-state.md)). No avatar video is published.

### Multi-party etiquette

`AgentSession` listens to one *linked participant* by default ([RoomIO](https://docs.livekit.io/agents/logic/sessions.md#roomio)), so we add `floor.ts` in the worker:

- **1:1 calls:** behave as today.
- **Group calls:** an agent answers only when it is **addressed**:
  - by name or `@mention` in chat;
  - by "Sibyl, …";
  - or by a follow-up within 8 s of its own reply to that person.
  - It switches the linked participant to the speaker. The voice brain's `@silence` already discards speech not meant for it.
- **Speaking:**
  - one agent speaks at a time, using a room-level floor lock in room metadata;
  - agents never start while a human is speaking, and wait for ≥700 ms of room-wide silence;
  - any human speech interrupts an agent.
- **Modes per call:** *participant* (default), *note-taker* (listen-only, no audio track, summary afterwards) and *hand-raise* (posts "I have something" in chat and waits to be called on).

### Phone calls (SIP)

- **Provider:** bring your own SIP trunk ([Twilio](https://docs.livekit.io/telephony/start/providers/twilio.md), Telnyx…).
- **Inbound:**
  - one inbound trunk;
  - one long-lived **individual** dispatch rule with `room_config` dispatching `sibyl` ([dispatch rules](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule.md));
  - a Sibyl `phone_lines` table maps each dialled number to workspace, agent and caller policy.
  - Use a predetermined room ID, not the caller's number, in room names (the docs warn that room names log PII).
- **Outbound:** `createSipParticipant` ([outbound](https://docs.livekit.io/telephony/making-calls/outbound-calls.md)) is a **write action**, so it goes through the approval card unless the agent's autonomy allows it.
- **Callers:**
  - unknown callers get a restricted access profile, never "everything I can use";
  - phone audio is narrowband (G.711; [HD voice](https://docs.livekit.io/telephony/features/hd-voice.md) when the trunk supports G.722).

### Egress: calls and agent browsers

- **Calls:** audio-only `TemplateSource` (one mixed file), or `MediaSource` with per-participant channels for transcripts ([egress](https://docs.livekit.io/transport/media/ingress-egress/egress.md)). Started by the gateway when policy says so (`calls.record`), with an announced, visible recording indicator.
- **Agent browsers:** Web egress records *a URL in its own Chromium* ([web egress](https://docs.livekit.io/transport/media/ingress-egress/egress/composite-recording.md#web-egress)), so it **cannot attach to the sandbox's Playwright browser**. Instead:
  - the sandbox publishes a CDP screencast as a video track via `@livekit/rtc-node` (participant `browser:<agentId>`, `kind=agent`);
  - people watch it live, and Track egress records it (cheap, no transcoding).
  - Without LiveKit, Playwright's `recordVideo` is the fallback.
- **Storage:** egress writes to the local filesystem when no provider is set ([README](https://github.com/livekit/egress#can-i-store-the-files-locally-instead-of-uploading-to-cloud-storage)), so the default is the `sibyl-data/recordings` volume. S3/MinIO is optional. Rows go in `recordings` (workspace, kind, path, duration, retention). Retention and legal hold live in `ee/`.

### Ingress: listening to streams

`CreateIngress`:

- **URL input** (HLS/MP4/MP3) starts immediately;
- **RTMP/WHIP** returns a URL and key to paste into OBS or Zoom's "custom live stream" ([ingress](https://docs.livekit.io/transport/media/ingress-egress/ingress.md)).

An agent is dispatched in **note-taker** mode: it transcribes in rolling windows through our STT, and posts notes to the inbox or a knowledge base under its budget. A YouTube *page* URL is not a media URL, so a direct HLS link is needed.

### Zero-setup default

With no `LIVEKIT_URL`, nothing changes: the WebSocket path, browser VAD and Web Audio playback stay. When set, `session.config` advertises `realtime: { url }` and the web app uses `livekit-client`. If the connection fails, it falls back to the WebSocket.

## 4. Expected gains and costs

| | Today (WS) | LiveKit (estimate, to measure) |
|---|---|---|
| End of speech → voice | 2.5–3.3 s | **~2.0–2.8 s** |
| Barge-in → silence | ~0.5 s | ~0.2–0.3 s |

- **Where the time is saved:**
  - continuous Opus streaming: no whole-turn upload, no MP3 segment decode;
  - optional preemptive generation ([docs](https://docs.livekit.io/agents/multimodality/audio.md#preemptive-speech-generation));
  - server-side playout cut-off on barge-in.
- **What doesn't change:** the voice brain's first word (1.5–2.1 s) dominates, so sub-second needs a realtime model.
- **Quality gains:** jitter buffer, packet-loss concealment and FEC, TCP/TURN fallback on mobile and corporate networks, multi-party, phone.
- **Media costs:** no per-minute fees self-hosted. Opus voice is ~32 kbps per stream, about 14 MB/hour each way per participant. A 1:1 call with the worker on the same host costs only the user's leg.
- **TURN:** relayed clients cost the server their bandwidth twice.
- **CPU:**
  - one 16-core node handled 3,000 audio subscribers in LiveKit's benchmark ([benchmark](https://docs.livekit.io/transport/self-hosting/benchmark.md));
  - Chrome-based egress needs ~2–4 cores per recording;
  - audio and track egress are cheap.
- **Cloud reference:** $0.0005/participant-min, $0.005/min audio egress, $0.01/min hosted agent ([pricing](https://livekit.com/pricing)).

## 5. Risks, unknowns, decisions

**Risks and unknowns:**

- **Node parity gaps** (Python only today): pre-connect audio, automatic gain control, backchannel cooldown, OpenRouter helper.
- Whether OpenRouter's TTS can return raw PCM; otherwise MP3 has to be decoded in the worker.
- Interim captions without the browser's speech recognition.
- **Self-hosted quality without Krisp** on phone and noisy rooms.
- **Ops burden:** UDP, TLS certificates and a TURN domain; Docker Desktop on macOS handles UDP ranges badly.
- **Law:** call-recording consent, and US TCPA rules on AI-voice outbound calls.
- The hop between worker and gateway adds a few ms; measure it.

**Owner decisions:**

1. **Core vs `ee/`:** propose rooms, voices, multi-party, SIP, ingress and recording in MIT core; recording policy, retention, legal hold and audit playback in `ee/`.
2. Allow `LIVEKIT_URL` to point at **LiveKit Cloud** (Krisp, `v1` turn detector, numbers) as an opt-in?
3. Ship the **`v1-mini` turn detector** (LiveKit Model License) opt-in, or keep only our own turn logic?
4. Telephony provider to document first, and whether outbound calls are allowed at all (default: approval each time).
5. Recording storage default (local volume vs MinIO) and default retention.
6. Default group-call mode (participant vs note-taker).

## 6. Phased plan (wave C)

| Phase | Deliverable | Modules |
|---|---|---|
| C0 spike (1 wk) | Compose profile, token endpoint, echo worker; latency measured against the table above | `docker-compose.yml` profiles, `deploy/livekit/*.yaml` |
| C1 1:1 WebRTC voice | Bridge plus worker; web client with WebSocket fallback; diagnostics parity | `apps/gateway/src/voice/{session,io-ws,io-bridge}.ts` (split out of `gateway.ts`), `apps/gateway/src/realtime/{config,token,dispatch,webhook}.ts`, new `apps/voice-agent/src/{main,sibyl-agent,bridge-client,audio}.ts`, `packages/protocol` (`realtime` in session config, ticket schema), `packages/core` permissions, `apps/web/src/realtime/*` |
| C2 agent voices + multi-party | Per-agent identity and voice, floor manager, call screen | `apps/voice-agent/src/floor.ts`, `apps/web` call view (`/c/:id/call`) |
| C3 Phone | SIP profile, phone lines, inbound/outbound with approvals | `apps/gateway/src/realtime/sip.ts`, `packages/store` `phone_lines`, settings section "Phone" |
| C4 Recording | Call egress, agent-browser screencast publisher, `recordings` store, player | `apps/gateway/src/realtime/recordings.ts`, the agent-computer module's `screencast.ts`, `ee/gateway/recordings-policy.ts` |
| C5 Streams | Ingress create/list, note-taker mode | `apps/gateway/src/realtime/ingress.ts`, `apps/voice-agent/src/modes/note-taker.ts` |

Rule throughout: the open-source core never imports `ee/`. Every model call stays metered in the gateway, and the worker holds no OpenRouter key.

## Decisions (agreed 2026-11-09)

1. **Editions:** realtime voice (WebRTC), group calls and phone calls (SIP) are in the free, open-source edition. Recording of calls and of agent browser sessions, plus recording-retention policies, are Sibyl Enterprise (`ee/`).
2. **LiveKit Cloud:** supported as an opt-in alternative (`LIVEKIT_URL` pointing at Cloud). Self-hosted LiveKit stays the documented default.
3. **LiveKit turn-detector model:** off by default; opt-in only after its licence (LiveKit Model License) has been reviewed. Sibyl's own VAD and turn logic stay the default.
4. **Phone:** Twilio documented first (SIP trunk). Outbound calls always need approval (high-risk action).
5. **Recordings:** stored in the data volume, or S3-compatible storage when configured, kept 30 days by default (configurable; Enterprise policies can change it).
6. **Group calls:** agents join as note-takers and speak only when addressed by name, or when the host hands them the floor.
