# Realtime calls (LiveKit)

Sibyl can run its voice over [LiveKit](https://livekit.io), a self-hosted WebRTC server (Apache-2.0). It is optional. Without it, voice runs over the gateway's WebSocket as described in [voice.md](voice.md), and a single OpenRouter key still runs everything.

With LiveKit you get:

- **Steadier voice.** WebRTC handles echo cancellation, jitter, packet loss and mobile networks.
- **Meetings.** Several people and agents in one call, with video, live captions, AI notes and a page afterwards ([meetings.md](meetings.md)).
- **Agents with their own voices.** Each agent joins as its own participant, with its avatar.
- **Phone calls.** Sibyl can call a number (always after your approval) and answer a phone line, through a SIP trunk such as Twilio.
- **Streams.** Bring a live stream (RTMP, WHIP or a live HLS URL) into a room. An agent listens and writes notes into a chat.
- **Recordings** (Agent Serve). Record calls, keep them for 30 days, list and download them.

## Turn it on

### With Docker Compose

1. Add to `.env`:

   ```bash
   LIVEKIT_URL=ws://livekit:7880          # how the gateway reaches LiveKit
   LIVEKIT_PUBLIC_URL=ws://localhost:7880 # how browsers reach it
   LIVEKIT_API_KEY=sibyl
   LIVEKIT_API_SECRET=<32 or more random characters>
   ```

2. Start the stack with the `realtime` profile (LiveKit, Redis, egress and ingress):

   ```bash
   docker compose --profile realtime up -d
   ```

   Add `--profile phone` for the SIP bridge (phone calls).

3. Open Sibyl and tap the microphone. The status reads "Live mode listening…" and the voice now runs through LiveKit. A **Meet** button appears at the top of each chat, and **Meetings** can start calls ([meetings.md](meetings.md)).

The LiveKit settings are in [`deploy/livekit/livekit.yaml`](../deploy/livekit/livekit.yaml). The keys come from `.env`, never from that file. On a server, set `LIVEKIT_NODE_IP` to the server's public IP, put LiveKit behind TLS (`wss://`) and open TCP 7881 and UDP 7882 ([ports](https://docs.livekit.io/transport/self-hosting/ports-firewall.md)).

### For development (gateway on your machine)

```bash
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  livekit/livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret corepack pnpm dev
```

`--dev` uses the keys `devkey` / `secret`. It has no Redis, so egress, ingress, SIP and webhooks need the compose stack. When the gateway runs on your machine and LiveKit in Docker, point the webhook in `livekit.yaml` at `http://host.docker.internal:<gateway port>/api/realtime/webhook`. On macOS, `--node-ip 127.0.0.1` is needed for media to flow.

### LiveKit Cloud

Point `LIVEKIT_URL` at your Cloud project (`wss://<project>.livekit.cloud`) with its key and secret. Self-hosted LiveKit stays the documented default.

If LiveKit can't be reached, voice falls back to the WebSocket path on its own.

## How it works

```text
browser ── WebRTC (mic, Sibyl's voice) ──► LiveKit ◄── WebRTC ── gateway: room agent
   │                                                                │
   └──── WebSocket (transcripts, replies, visuals, approvals) ──────┤
                                                                    ▼
                                         the same gateway session as before:
                                         voice brain, deep brain, hedging, metering,
                                         budgets, approvals, memory, history
```

- The gateway is the only place that mints LiveKit tokens, after its own sign-in and permission checks.
- **The room agent** runs inside the gateway. It joins the room as `agent:sibyl`, hears each person's microphone, and detects turns with the same speech detector as the browser (`@open-gpt-live/core/vad`). It hands each turn to the gateway session as the same messages the browser would send (`vad.speech_start`, `audio.chunk`, `vad.speech_end`), so the same permission checks apply. The reply's speech goes into the agent's own audio track instead of `tts.chunk`. Talking over Sibyl stops her.
- There is one pipeline. The session's transport is a seam (`apps/gateway/src/session-port.ts`): a browser WebSocket, or a session with no browser (a phone call, a stream).
- Captions go to the room as LiveKit text streams (`lk.transcription`), so everyone in a call sees them.

### Why these SDKs

| SDK | Used for | Why |
|---|---|---|
| `livekit-server-sdk` | tokens, rooms, SIP, ingress, egress, webhooks | Pure JavaScript, bundled with the gateway |
| `@livekit/rtc-node` | the room agent's audio in and out | The smallest piece that joins a room from Node. Loaded only when LiveKit is configured |
| `livekit-client` | the web app | Loaded on demand, only in LiveKit mode |

We don't use `@livekit/agents`. It brings its own speech-to-text, language model and text-to-speech pipeline, a separate worker process, OpenTelemetry, ffmpeg and image libraries. Sibyl already has its voice pipeline (audio-native voice brain, hedging, metering, budgets, approvals). Running that pipeline inside the gateway, behind a transport seam, keeps one copy of it and needs no second process or internal API.

`@livekit/rtc-node` ships a native library for Linux (glibc), macOS and Windows. That's why the gateway image is based on Debian slim, not Alpine.

The LiveKit turn-detector model is not used: its weights are under the LiveKit Model License. Sibyl's own speech detector decides when you've finished.

## Voice in a chat

When the gateway has LiveKit, the microphone button joins the chat's private voice room (`sibyl.voice.<workspace>.<conversation>`). Only you can get a token for it. Switching chats leaves the room.

## Calls

Group calls are meetings: see [meetings.md](meetings.md) for the room, agent roles (participant or silent note-taker), guests, AI notes and the meeting page. **Meet** at the top of a chat starts one (`/call/<id>`). This section is how agents behave in any call.

- **People and agents** appear as tiles. Agents show their avatar.
- **Sibyl takes notes.** What people say is transcribed, shown as captions and kept in the host's chat as lines like `[Bob] …`.
- **Agents speak only when addressed.** Say their name ("Sibyl, …", "… what do you think, Nova?", "@Nova"). A follow-up from the same person within 8 seconds goes to the same agent.
- **The host can hand the floor** to an agent ("Give floor"). It then answers without being named, until the host takes the floor back or someone names another agent.
- **Invite an agent** (host): it joins with its own voice and avatar before anyone addresses it.
- A call with only one person behaves like voice in a chat: every turn is answered.
- Replies, visuals and approval cards appear in the host's chat. Approvals are decided there.
- In a meeting, silent note-takers never speak, and every turn is transcribed first (also with one person in the room), so the meeting keeps a full transcript.

## Phone calls

Phone calls use a SIP trunk from a provider. Twilio is documented first.

### Set up Twilio

1. In Twilio, create an **Elastic SIP Trunk**.
   - Termination: add a termination URI (for example `sibyl.pstn.twilio.com`) and a credential list (user name and password).
   - Origination: add `sip:<your LiveKit SIP host>:5060` (the `sip` service from `--profile phone`; it needs a public IP and UDP 5060 and 10000–10100 open).
2. Buy or move a number to the trunk.
3. Set up the line in Sibyl as an organization owner or admin:

   ```bash
   curl -X PUT http://localhost:8787/api/realtime/phone \
     -H "authorization: Bearer $SIBYL_OWNER_TOKEN" -H "content-type: application/json" \
     -d '{"provider":"twilio","address":"sibyl.pstn.twilio.com","number":"+15551234567",
          "username":"<termination user>","password":"<termination password>",
          "greeting":"Hello, this is Sibyl. How can I help?","agentId":"<optional agent>"}'
   ```

   This creates the outbound trunk, the inbound trunk and an inbound dispatch rule in LiveKit. The SIP password is passed to LiveKit and not stored by Sibyl. `GET` shows the line; `DELETE` removes it.

### Calling out

Ask Sibyl to call someone: "Call +1 555 123 4567 and confirm my appointment for Tuesday." The `place_phone_call` tool is **high risk**, so it always shows an approval card, whatever an agent's autonomy says. Once approved, Sibyl (or the agent you named) joins a new room and LiveKit dials the number. The call is saved as a new chat.

### Answering

Calls to the line join a room named after the line (`sibyl.phone.<workspace>.<number>_<random>`; the caller's number is never in a room name). LiveKit tells the gateway through its signed webhook, and Sibyl answers with the greeting.

### Who the caller is

Phone sessions never act with more than a **viewer**'s rights in the line's workspace, whoever placed or answers the call. The person on the phone can talk and use read-only tools, but nothing that writes. Calls Sibyl answers have no owner: owners and admins see them in the chat history.

US rules (TCPA) and many countries limit automated calls. Check them before you let Sibyl call people.

## Streams

Bring a live stream into a room. An agent listens, transcribes what's said and writes it as notes into a new chat. You can then ask Sibyl for a summary.

```bash
# RTMP (OBS, Zoom "custom live stream"): returns url + streamKey to paste into the encoder
curl -X POST http://localhost:8787/api/realtime/streams -H "authorization: Bearer $SIBYL_OWNER_TOKEN" \
  -H "content-type: application/json" -d '{"input":"rtmp","name":"All hands"}'
# A live HLS URL: starts at once
curl -X POST … -d '{"input":"url","name":"Webinar","url":"https://example.com/live/index.m3u8"}'
```

`input` can be `rtmp`, `whip` or `url`. `GET /api/realtime/streams` lists them, `DELETE /api/realtime/streams/<id>` stops one. In chat, the `listen_to_stream` tool does the same for a URL (it asks first).

The URL must be a live stream (HLS, RTMP, SRT). A YouTube page is not a media URL. In our tests, a finished file (an `.mp4` or `.m3u8` without new segments) ended at once without being played.

## Recordings (Enterprise)

Needs a licence with `recordings` and the `egress` service (in `--profile realtime`).

- **Record** in a call starts an audio recording of the room (one mixed Ogg/Opus file). Everyone in the call sees **Recording**.
- Files go to the data volume (`recordings`, shared by the gateway and egress) or to S3-compatible storage (`SIBYL_RECORDINGS_S3_*`).
- They are deleted after 30 days (`SIBYL_RECORDINGS_RETENTION_DAYS`).
- People with `calls.record` (admins and owners) can list and download them:

| Request | What it does |
|---|---|
| `GET /api/recordings` | Recordings of the workspace |
| `POST /api/recordings {room}` | Start recording a room of the workspace |
| `POST /api/recordings/<id>/stop` | Stop |
| `GET /api/recordings/<id>/file` | Download (a presigned link for S3) |
| `DELETE /api/recordings/<id>` | Delete |

The open-source edition has no recording.

## Permissions and API

| Entry point | Permission |
|---|---|
| WS `realtime.join`, `realtime.leave`, `realtime.floor` | `chat.use` (a call is joined by its host's session only) |
| `/api/meetings` | see [meetings.md](meetings.md#permissions) |
| WS `realtime.invite` | `chat.use` and `agents.use` |
| `GET /api/realtime`, `POST /api/realtime/token`, `GET /api/realtime/calls/<id>` | `chat.use` |
| `GET /api/realtime/streams` | `chat.use` |
| `POST`, `DELETE /api/realtime/streams` | `tools.write` |
| `GET`, `PUT`, `DELETE /api/realtime/phone` | `org.settings` |
| `POST /api/realtime/webhook` | LiveKit's signed token |
| `/api/recordings` | `calls.record` (Enterprise) |
| Tools `place_phone_call` (high risk), `listen_to_stream` | `tools.write` and an approval |

Tokens last 10 minutes. People may join, listen, speak with their microphone and send data; in calls they may also share their camera and screen. They may never administer or record a room. Room names always include the workspace, and a token is only issued for a room of the caller's workspace.

## Measured

Gateway on macOS, LiveKit in Docker, real OpenRouter models, 2026-11-09:

| Step | Measured |
|---|---|
| End of speech → turn detected (server) | 0.5 s (the silence it waits for) |
| End of speech → Sibyl's voice in the room | 2.8 s |
| Same over the WebSocket path ([voice.md](voice.md#measured-latency)) | 2.5–3.3 s |

The voice brain's first word still dominates. LiveKit's gains are steadier audio and networks, calls and phones, not a faster brain.

## Troubleshooting

- **No sound on macOS with Docker:** start LiveKit with `--node-ip 127.0.0.1` (compose: `LIVEKIT_NODE_IP`).
- **"secret is too short":** `LIVEKIT_API_SECRET` must be 32 characters or more.
- **Inbound calls don't get an answer:** the webhook in `livekit.yaml` must reach the gateway, and its `api_key` must equal `LIVEKIT_API_KEY`.
- **Recording doesn't start:** the `egress` service must be running and share the `recordings` volume with the gateway.
