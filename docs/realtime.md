# Realtime calls (LiveKit)

Sibyl can run its voice over [LiveKit](https://livekit.io), a self-hosted WebRTC server (Apache-2.0). It is optional. Without it, voice runs over the gateway's WebSocket as described in [voice.md](voice.md), and a single OpenRouter key still runs everything.

With LiveKit you get:

- **Steadier voice.** WebRTC handles echo cancellation, jitter, packet loss and mobile networks.
- **Meetings.** Several people and agents in one call, with video, live captions, AI notes and a page afterwards ([meetings.md](meetings.md)).
- **Agents with their own voices.** Each agent joins as its own participant, with its avatar.
- **Phone calls.** Sibyl answers a phone line and can call a number (always after your approval), with a LiveKit Cloud number or a SIP trunk such as Twilio. Business hours, messages after hours, a call log.
- **Streams.** Bring a live stream (RTMP, WHIP or a live HLS URL) into a room. An agent listens and writes notes into a chat.
- **Recordings** (Agent Serve). Record meetings (audio or video) and phone calls, keep them for 30 days or on legal hold, search, play and download them.

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

Point `LIVEKIT_URL` at your Cloud project (`wss://<project>.livekit.cloud`) with its key and secret. Self-hosted LiveKit stays the documented default. With Cloud, Settings → Voice → Speed also offers [LiveKit Inference](voice.md#livekit-inference-speech-livekit-cloud) for speech and transcription (opt-in, billed to the LiveKit project).

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

Give Sibyl a phone number. People can call her, and she can call people for you (always after your approval). Set it up in **Settings → Admin → Phone** (owners and admins).

### Two ways to get a number

| | A LiveKit phone number | Your SIP provider |
|---|---|---|
| What it is | A US number you rent straight from LiveKit Cloud | A SIP trunk at Twilio, Telnyx, Plivo, Vonage or any other provider |
| Needs | LiveKit Cloud (`LIVEKIT_URL` at `*.livekit.cloud`) | Any LiveKit: Cloud, or self-hosted with the `sip` service (`--profile phone`) |
| Incoming calls | Yes | Yes |
| Calling out | Not yet (LiveKit: inbound only) | Yes |
| Countries | US local and toll-free numbers | Whatever the provider sells |
| Price | Billed monthly by LiveKit; one local number is included with every Cloud plan | The provider's prices |

Self-hosted LiveKit always needs a SIP provider: LiveKit's own numbers live in LiveKit Cloud.

### A LiveKit phone number (LiveKit Cloud)

1. Point Sibyl at your Cloud project: `LIVEKIT_URL=wss://<project>.livekit.cloud` with its key and secret.
2. Open **Settings → Admin → Phone** and pick **A LiveKit phone number**.
3. Tick a number your project already has, or search by area code and **Rent** one (LiveKit bills it; there is a confirmation first).
4. **Set up the line.** Sibyl creates a dispatch rule in LiveKit and routes the numbers to it.

Behind the scenes this uses LiveKit's Phone Numbers API (`SearchPhoneNumbers`, `PurchasePhoneNumber`, `ListPhoneNumbers`, `UpdatePhoneNumber`; [reference](https://docs.livekit.io/reference/telephony/phone-numbers-api/)). You can also buy numbers with the `lk number` CLI or in the Cloud dashboard (Telephony → Phone numbers) and then pick them here.

### Twilio, step by step

1. In the Twilio console, open **Elastic SIP Trunking → Trunks → Create new SIP Trunk**. Name it "Sibyl".
2. **Termination** (calls from Sibyl to phones):
   - Set a **Termination SIP URI**, for example `acme-sibyl.pstn.twilio.com`. This is the **SIP address** in Sibyl.
   - Under **Authentication → Credential Lists**, create a list with a user name and a strong password. These are the **User name** and **Password** in Sibyl.
3. **Origination** (calls from phones to Sibyl): add an origination URI pointing at LiveKit's SIP service: `sip:<your LiveKit SIP host>:5060`.
   - LiveKit Cloud: your project's SIP URI (Project settings → SIP URI).
   - Self-hosted: the server's public address. Start the SIP service with `docker compose --profile realtime --profile phone up -d` and open UDP 5060 and the RTP ports (10000–10100 in `docker-compose.yml`).
4. **Numbers**: buy a number (or move one) and attach it to the trunk.
5. In Sibyl, **Settings → Admin → Phone → Your SIP provider**: provider Twilio, the SIP address, user name, password and the number (`+15551234567`). **Set up the line.**
6. Press **Test**. It checks LiveKit, LiveKit's SIP API, that the SIP address resolves, the trunks and the routing in LiveKit, and the business hours. It does not place a call: call the number from your phone to try it.

The password is sent to LiveKit (it needs it for the trunk) and kept in Sibyl's vault as `PHONE_SIP_PASSWORD`, usable only for the trunk's host, so Sibyl can rebuild the trunks when you change the numbers. It is never shown again; leave the field empty to keep it. Without a vault key (`SIBYL_SECRET_KEY`), it is only in LiveKit and you enter it again when the trunk changes.

### Other SIP providers

Same steps: create a SIP trunk with credentials (outbound, called termination by most) and point incoming calls at LiveKit's SIP URI.

| Provider | SIP address (example) | Where |
|---|---|---|
| Telnyx | `sip.telnyx.com` | Voice → SIP Trunking: an FQDN connection with credentials; outbound voice profile |
| Plivo | `<your id>.zt.plivo.com` | Zentrunk → Outbound trunk with a credentials list; inbound trunk to LiveKit's URI |
| Vonage | `sip.nexmo.com` | SIP trunking (Vonage API): a number linked to a SIP endpoint |
| Any other | the provider's SIP host | Their SIP trunking docs |

LiveKit's own guides per provider: [docs.livekit.io/telephony](https://docs.livekit.io/telephony/).

### Answering

- **Who answers**: Sibyl, or one of your agents, with the **greeting** you set.
- **Business hours** (optional): open days, opening and closing time, time zone. Closing before opening means overnight (22:00–06:00).
- **After hours**: Sibyl **takes a message**: she says the message greeting, then only listens. What the caller says is transcribed and lands in the **Inbox** ("Voicemail from +1…", with the words and a link to the call's chat). Or choose **Answer anyway**.
- Calls join a room named after the line (`sibyl.phone.<workspace>.<number>_<random>`; the caller's number is never in a room name). LiveKit tells the gateway through its signed webhook.

### Calling out

Ask Sibyl to call someone: "Call +1 555 123 4567 and confirm my appointment for Tuesday." The `place_phone_call` tool is **high risk**, so it always shows an approval card, whatever an agent's autonomy says. **Who may ask** is set on the Phone page: owners and admins (default), members too, or nobody. Once approved, Sibyl (or the agent you named) joins a new room and LiveKit dials the number from the line's first number. The call is saved as a new chat.

`LIVEKIT_SIP_OUTBOUND_TRUNK_ID` and `LIVEKIT_SIP_FROM_NUMBER` still work if you created a trunk yourself.

### Call log

Under the line's settings: every call, in and out, with the number, who answered, when, how long, what it cost (model and speech, from the usage meter), its transcript (the call's chat), its recording and a voicemail's words. Filter by direction. People with `chat.view_all` (owners and admins) see it. Each organization and workspace has its own.

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

- **Record audio** or **Record video** (Invite menu in a meeting) records the room: audio is one mixed Ogg/Opus file; video is an MP4 with the active speaker (or a shared screen) large and everyone's audio. You choose per recording.
- **Consent.** Everyone in the room sees **Recording** as soon as it starts (guests too). Phone callers hear "This call is being recorded". The phone line can record every call (Settings → Admin → Phone → Record every call).
- A meeting's recording is linked to it: its page plays the audio with a waveform, or the video, in step with the transcript.
- **Meetings → Recordings** lists recordings of meetings and calls: search, filter (meetings or calls, audio or video, legal hold), how many days are left, play, download, delete.
- Files go to the data volume (`recordings`, shared by the gateway and egress) or to S3-compatible storage (`SIBYL_RECORDINGS_S3_*`).
- They are deleted after 30 days (`SIBYL_RECORDINGS_RETENTION_DAYS`), unless they are on **legal hold**. A recording on hold can't be deleted until the hold is lifted.
- People with `calls.record` (admins and owners) record, list, play and download them.

| Request | What it does |
|---|---|
| `GET /api/recordings?q=&kind=call\|phone&type=audio\|video&status=&held=1` | Recordings of the workspace |
| `POST /api/recordings {room, video?}` | Start recording a room of the workspace |
| `POST /api/recordings/<id>/stop` | Stop |
| `PATCH /api/recordings/<id> {legalHold}` | Put on or lift legal hold |
| `GET /api/recordings/<id>/file[?inline=1]` | Download or play (a presigned link for S3) |
| `DELETE /api/recordings/<id>` | Delete |

The open-source edition has no recording: the tab is hidden and the meeting page says "Audio and video recordings come with Agent Serve".

## Permissions and API

| Entry point | Permission |
|---|---|
| WS `realtime.join`, `realtime.leave`, `realtime.floor` | `chat.use` (a call is joined by its host's session only) |
| `/api/meetings` | see [meetings.md](meetings.md#permissions) |
| WS `realtime.invite` | `chat.use` and `agents.use` |
| `GET /api/realtime`, `POST /api/realtime/token`, `GET /api/realtime/calls/<id>` | `chat.use` |
| `GET /api/realtime/streams` | `chat.use` |
| `POST`, `DELETE /api/realtime/streams` | `tools.write` |
| `GET`, `PUT`, `DELETE /api/realtime/phone`, `POST /api/realtime/phone/test`, `GET`, `POST /api/realtime/phone/numbers` | `org.settings` |
| `GET /api/realtime/calls?direction=&before=` (call log) | `chat.view_all` |
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

Re-measured on 2026-11-10 with streamed speech, preemptive generation and the speed-weighted Balanced preset: end of speech → Sibyl's voice heard in the room **3.0 s** median (4.2 s p90) over six turns, down from 5.0 s (6.6 s) with the same client before those changes. The room agent's turns report the same `turn.metrics` as the WebSocket path (`transport: "livekit"`; see [voice.md](voice.md#latency-metrics)).

### Verified (phone line and recordings)

Run on 2026-11-10 against LiveKit, Redis, egress and SIP in Docker (no real phone network: no PSTN number was available, and nothing was bought):

- Setting up a Twilio-style line created the outbound and inbound trunks and the dispatch rule in LiveKit; the password was never sent back and was kept in the vault; **Test** passed every step (LiveKit, SIP API, the SIP address resolving, trunks, routing, hours).
- A signed `participant_joined` webhook for a SIP caller (a forged one got 401) made Sibyl answer with the greeting and "This call is being recorded"; the caller (a scripted participant speaking a recorded question) heard the answer, and the call's audio recording was ready afterwards.
- After hours the same call got the message greeting; the caller's message was transcribed into the Inbox ("Voicemail from …") and the call log.
- Asking Sibyl in chat to call a number showed the high-risk approval card; after approval LiveKit dialled out through the (fake) trunk and the call log recorded it.

Not verified: a real phone call through Twilio or another provider, and LiveKit Cloud phone numbers (the Phone Numbers API is implemented from LiveKit's reference and unit-tested with a fake; this test stack is self-hosted, and renting a number costs money).

## Troubleshooting

- **No sound on macOS with Docker:** start LiveKit with `--node-ip 127.0.0.1` (compose: `LIVEKIT_NODE_IP`).
- **"secret is too short":** `LIVEKIT_API_SECRET` must be 32 characters or more.
- **Inbound calls don't get an answer:** the webhook in `livekit.yaml` must reach the gateway, and its `api_key` must equal `LIVEKIT_API_KEY`.
- **Recording doesn't start:** the `egress` service must be running and share the `recordings` volume with the gateway.
- **A video recording is empty or never finishes:** egress renders the room in headless Chrome and must reach LiveKit's media. With LiveKit in Docker on one machine, start LiveKit with `--node-ip` set to the machine's LAN address (not `127.0.0.1`), so both browsers and the egress container can reach it.
- **Test says "LiveKit's SIP API failed":** self-hosted LiveKit needs Redis and the `sip` service (`--profile phone`).
- **A LiveKit number can't be picked:** LiveKit numbers need LiveKit Cloud; with self-hosted LiveKit use a SIP provider.
