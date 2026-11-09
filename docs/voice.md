# Voice

Sibyl's live conversation is built from swappable OpenRouter models, not a single vendor's realtime API. This page explains how a spoken turn flows, how Sibyl decides when you have finished, and what the measured latency looks like.

For people who want the most natural voice and are happy to pay more, OpenAI's GPT Realtime is available as a premium [voice engine](#voice-engines-sibyl-voice-and-gpt-realtime). Sibyl voice stays the default.

## WebSocket or LiveKit

By default the browser streams your voice to the gateway over its WebSocket, and Sibyl's voice comes back the same way. Nothing else is needed.

When the gateway has [LiveKit](realtime.md) configured (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), hands-free voice runs over WebRTC instead: the microphone and Sibyl's voice travel through a LiveKit room, and the gateway's room agent detects your turns with the same speech detector. The brain, the turn rules, barge-in, hedging and budgets below are the same in both. Transcripts, replies, visuals and approvals stay on the WebSocket. If the room can't be joined, voice falls back to the WebSocket. LiveKit also brings calls with several people and agents, phone calls and streams; see [realtime.md](realtime.md).

## Three ways to talk

Voice and typing share one conversation. Switch between them whenever you like; both brains see everything said, typed and shown so far.

| Mode | How | What happens |
|---|---|---|
| **Hands-free** | Tap the mic button | The mic stays on (echo-cancelled). The browser detects when you start and stop speaking and sends each turn as it ends. Tap again to end. |
| **Push-to-talk** | Hold the mic button | The clip is recorded while you hold and sent when you let go. With a voice brain active, the browser converts the clip to WAV so the voice brain hears your tone too. |
| **Typing** | The composer | A normal chat reply from the deep brain: text and visuals, with tools when needed. Nothing is spoken and there are no emotion cues. Messages sent while Sibyl is answering are queued. |

## The live pipeline

```text
mic (always on, echo-cancelled) ──► end of turn (0.4 s of silence) ──► raw audio
        │                                                                 │
        └─ instant on-device captions (display only)                      ▼
                                         VOICE BRAIN (audio-native model)
                                         hears tone, emotion and hesitation and replies
                                         like a person: "[sympathetically] Oh no, that's…"
                                                │                          │
                         speech + emotion cues ─┘                          └─ "@brain <task>"
                                │                                                  │
          expressive speech, segments synthesized in parallel        DEEP BRAIN (stronger model)
          and played gaplessly; talking over it stops it             reasons with the whole conversation,
                                                                     streams a visual, then a short
          background transcription ──► accurate transcript           spoken gist when you're free
```

### The voice brain

Your audio goes straight to an audio-native model, so it reacts to how you said something, not only the words. Its prompt asks it to:

- react first, then answer, usually in one or two sentences;
- mirror your mood: slow down and reassure when you sound stressed, share excitement when you're excited;
- use at most two emotion cues per reply, such as `[warmly]`, `[laughs]`, `[softly]`;
- ask you to repeat when the audio was unclear rather than guess.

If the audio has no speech meant for Sibyl — background noise, a cough, someone else talking, a TV — the voice brain answers `@silence` and the turn is dropped quietly (`llm.done` with reason `ignored`).

**Emotion cues** are performed by voices that support them (models marked `emotionTags: true`, such as ElevenLabs v3). For every other voice they are removed before speech, so you never hear "bracket laughs".

### The deep brain

When a request needs careful thinking, accuracy, several steps or something on screen, the voice says a short line like "let me pull that up" and ends its reply with:

```text
@brain <a precise, self-contained task with every relevant detail>
```

The gateway then starts the deep brain with the full conversation. The deep brain can call tools (web search, weather, your MCP servers and so on; see [tools.md](tools.md)) and pauses for your approval before anything that changes something.

- **It works from your real words.** The deep brain waits up to 3 seconds for the accurate transcript before starting.
- **Kept promises.** If the voice says it will look into something but forgets the `@brain` line, the gateway hands the request off anyway.
- **Early gist.** The deep brain writes its short spoken summary first. It is spoken as soon as it is written, while the visual keeps streaming in.
- **No stale interruptions.** If you have already moved on to something else, the old gist is not spoken. The visual stays on screen and in the conversation.
- **Shared context.** The deep brain's result is added to the history, so both brains can build on what was shown ("the last day sounds exhausting, I'm going with my grandma" works as a follow-up).

### Transcripts

While you speak, the browser shows an instant caption from its own speech recognition (where available). This is only a display hint: the voice brain hears the real audio. After the turn, a transcription model writes an accurate transcript in the background, and the gateway replaces the caption with it (`transcript.update`).

## Turn-taking

### Ending a turn

The browser's voice activity detector ends a turn after 0.4 seconds of silence (`NEXT_PUBLIC_VAD_HANGOVER_MS`). That is quick on purpose, because turn merging handles people who pause mid-thought. Other safeguards:

- a turn starts only after 160 ms of sound, and turns with less than 200 ms of voiced audio are discarded;
- 400 ms of audio from just before speech was detected is kept, so the first syllable isn't lost;
- the detector calibrates to the room for one second and follows slow changes in background noise;
- while Sibyl is speaking, the speech threshold is raised 2.5× and new speech is ignored for 300 ms after playback ends, to avoid reacting to its own voice.

All of these are adjustable; see [configuration.md](configuration.md#voice-activity-detection).

### Turn merging

If you start speaking again within 3 seconds and before Sibyl has started answering out loud, the earlier fragment and its pending reply are dropped, and your whole thought is answered once. The browser is told with `turn.merged`.

### Barge-in

Talk over Sibyl and it stops: the browser stops playback at once, and the gateway cancels the reply and any speech still being generated. A deep-brain gist that hasn't been spoken yet is dropped once your new turn starts. Measured time from you starting to talk to silence is about half a second.

## Staying fast

### Hedged requests

Latency on shared provider routes varies a lot; the same model has been measured at 1 second on one call and 14 on the next. With `HEDGE_REQUESTS=true` (the default):

- if the voice brain hasn't produced a word after 1.2 s (`HEDGE_VOICE_AFTER_MS`), the same turn also goes to the fastest voice brain from a different vendor;
- if a speech segment hasn't started after 1.5 s (`HEDGE_TTS_AFTER_MS`), a duplicate request goes out on the same voice.

Whichever answers first wins and the other is cancelled. A request that fails before producing anything fails over the same way.

### Other latency work

- **Learning from live turns.** In auto mode the gateway tracks each voice brain's real time to first word and uses whichever of the scout's top three has been fastest recently. A model you choose yourself always wins.
- **Warm connections.** Each session sends a small warm-up request to the voice brain, and provider connections are kept open for up to a minute between turns instead of Node's default four seconds.
- **Small first segments.** The reply is split into speech segments starting from about 14 characters, so the first audio starts sooner. Segments are synthesized in parallel.
- **Gapless playback.** Each segment is decoded and scheduled back to back on one Web Audio timeline, so there are no pauses between sentences.

## Measured latency

Measured end to end in the browser (injected microphone audio, real OpenRouter, Balanced preset, 2026-11-09):

| Step | Typical |
|---|---|
| End of speech detected | 0.4 s of silence |
| → voice brain's first word | ~1.5–2.1 s for a 4 s question |
| → first audio | +0.6–1.0 s |
| **End of speech → Sibyl's voice** | **~2.5–3.3 s** |
| Barge-in (you talk over it) → silence | ~0.5 s |
| Deep brain's spoken gist | ~5–8 s after handoff, with the visual streaming in alongside |

Native speech-to-speech models can start in under a second because one model does everything. Sibyl's pipeline is model-agnostic and cheaper. The **Fastest** preset trades some cost for the lowest measured latency.

The **Diagnostics** tab in Models & voice shows the latest turn's timings in your own browser:

| Metric | Measured from → to |
|---|---|
| STT first partial | start of speech → first partial transcript |
| Final transcript | end of speech → final transcript |
| LLM first token | final transcript (or sending a typed message) → first reply text |
| TTS first audio | first reply text → audio actually playing |
| Speech end → audio | end of speech → audio actually playing |

It also shows the voice activity detector's state, input level, noise floor and thresholds.

## Single-model mode

With `LIVE_CONVERSATION=false`, or when no voice brain is configured, each turn uses one model:

```text
audio ──► transcription ──► chat model (voice reply + optional visual) ──► speech
```

The model writes one to three spoken sentences first, then optionally one visual. The spoken part is streamed to speech as it arrives; the visual is rendered and never spoken. In hands-free mode without a voice brain, partial transcripts are produced while you speak, either by re-transcribing the audio every few seconds or, with `STT_REALTIME_ENABLED=true`, through OpenAI's Realtime transcription.

## Voice engines: Sibyl voice and GPT Realtime

Live voice runs on one of two engines. Everything else is the same on both: the conversation and its history, the deep brain with its tools, approvals and visuals, agents, budgets, the WebSocket or LiveKit transport, captions and barge-in.

| Engine | What talks | Price (estimate) | Choose it for |
|---|---|---|---|
| **Sibyl voice** (default) | The voice brain, the deep brain and a speech model, chosen by the [model scout](models-and-costs.md) | About $0.005–0.01 a minute on the Cheapest and Balanced presets | Low cost, any provider, emotion cues |
| **GPT Realtime** (premium) | OpenAI's speech-to-speech model: it hears you and answers in its own voice | About $0.05 a minute (`gpt-realtime-2.1`) or $0.02 (`gpt-realtime-2.1-mini`) | The most natural voice and turn-taking |

A "minute" here is about 25 seconds of you talking and 25 of the reply, over four turns. GPT Realtime's real cost grows with long conversations, because each reply re-reads the conversation so far (mostly at the cheaper cached rate).

### Turning it on

1. **An OpenAI key.** An organization owner or admin adds it in **Settings → Voice → OpenAI key**. Sibyl checks it with OpenAI first, keeps it encrypted in the organization's [vault](secrets.md) (`MODEL_OPENAI`, usable only for `api.openai.com`), and never shows or logs it again. **Test key** checks it again. A self-hosted server can set `OPENAI_API_KEY` instead; hosted organizations always use their own key. Without a key, the option reads "Add an OpenAI key to use GPT Realtime".
2. **Pick the engine** in **Settings → Voice** or the model menu in the composer, which shows each engine's price per minute. Choosing an engine needs `models.choose` (members and up), like choosing models.
3. **Options:** the model (GPT Realtime or GPT Realtime mini), the voice (`marin` and `cedar` sound the most natural) and turn detection:

| Turn detection | How it works |
|---|---|
| **Quick** (default) | Sibyl's own speech detector ends your turn after about 0.4 s of silence. The lowest latency. |
| **Balanced** | OpenAI's semantic turn detection listens to *how* you speak and waits when you sound unfinished. If you pause and carry on, both parts become one turn (`turn.merged`). |
| **Patient** | The same, but it lets you take your time. |

**Agents** can have their own engine and GPT Realtime voice (agent editor → Voice). Without a voice of its own, an agent gets the GPT Realtime voice closest to its Sibyl voice and personality. Its instructions, personality, tools and budget apply on both engines.

**Workspace admins** can turn the premium engine off for their workspace (**Allow GPT Realtime in this workspace**, `workspace.settings`). Sessions then use Sibyl voice and say why once.

### How a GPT Realtime turn works

```text
mic ─► vad.speech_start / audio.chunk / vad.speech_end (unchanged; browser or LiveKit room agent)
        │
        ▼  gateway (key stays here)
  OpenAI Realtime WebSocket ── 24 kHz PCM in ──► speech-to-speech model
        │                                          │            │
        │   tts.chunk (WAV) / LiveKit track ◄── audio      ask_sibyl(task)
        │   llm.delta ◄── its transcript                       │
        │   transcript.update ◄── your transcript              ▼
        │                                  the deep brain (tools, approvals, visual in chat)
        │                                          │
        └──────── function output ◄── short result ┘ ──► GPT Realtime says it in its voice
```

- The gateway opens one Realtime session per conversation when you first speak, and closes it after five idle minutes (`SIBYL_REALTIME_IDLE_SECONDS`). A new session gets the recent conversation as text, so typed messages and earlier deep-brain results carry over.
- Your audio is resampled to 24 kHz if needed and appended as you speak. With **Quick**, the gateway commits it when your turn ends and asks for a reply. With **Balanced** or **Patient**, it feeds silence after your turn until OpenAI decides you finished (at most 4.5 or 8.5 seconds).
- The reply's audio is sent in small WAV pieces (the first after about 120 ms of audio) through the same gapless player, or into the LiveKit room. Its transcript streams as `llm.delta`; your words come back from OpenAI's transcription and replace the caption.
- **Barge-in:** talking over the reply stops playback at once, cancels the response, and cuts the audio OpenAI keeps (`conversation.item.truncate`) at what you actually heard.
- **Tools and visuals stay Sibyl's.** GPT Realtime has one function, `ask_sibyl`. It says a short line ("Let me pull that up"), then hands a self-contained task to the deep brain: the same tool loop, approvals, permissions, budgets and visuals as the `@brain` handoff. The deep brain's short result goes back as the function's output and GPT Realtime tells you the key takeaway. If you have moved on by then, the result is not spoken; it stays on screen and in the conversation.
- If OpenAI can't be reached, the turn is answered by Sibyl voice and the app says so. Sibyl voice keeps answering for a minute before GPT Realtime is tried again.

### Costs and budgets

- Every response is metered from OpenAI's usage (`response.done`: text and audio tokens in and out, cached tokens) at the price table, and your transcript from the transcription model's usage. Both count as **Voice conversation** in the Usage tab, toward the organization, workspace, user and agent budgets.
- The budget is checked before each turn. When a cap is reached, no new GPT Realtime turn starts (`budget.blocked`) and the session closes after the reply in progress.
- Calls on the organization's own OpenAI key are never charged as AI credits on hosted Sibyl; OpenAI bills the key directly.
- Prices default to OpenAI's published rates and can be changed with `SIBYL_REALTIME_PRICES` ([configuration.md](configuration.md#voice-engines-gpt-realtime)).

### The OpenAI Realtime API (research notes, 2026-11-10)

From OpenAI's documentation ([realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [turn detection](https://developers.openai.com/api/docs/guides/realtime-vad), [client](https://developers.openai.com/api/reference/resources/realtime/client-events) and [server events](https://developers.openai.com/api/reference/resources/realtime/server-events), [pricing](https://developers.openai.com/api/docs/pricing)):

- **Models:** `gpt-realtime-2.1` (current flagship, 128k context) and `gpt-realtime-2.1-mini`; older `gpt-realtime-2`, `gpt-realtime` and `gpt-realtime-mini` still work. `gpt-live-1` (a full-duplex model, $0.05 a minute plus a separate backend model) uses a different endpoint (`/v1/live/sessions`) and is not supported here.
- **Transport:** WebRTC (browsers, with ephemeral keys) or WebSocket (`wss://api.openai.com/v1/realtime?model=…`, `Authorization: Bearer`; servers). Sibyl uses the WebSocket from the gateway, so the key never reaches a browser and the same session works for the browser, LiveKit rooms and phone calls. A session lasts at most 60 minutes.
- **Session config** (`session.update`, `type: "realtime"`): instructions, `output_modalities` (`audio`), function `tools`, `audio.input` (format `audio/pcm` at 24 kHz, `noise_reduction`, `transcription.model`, `turn_detection`) and `audio.output` (format, `voice`, `speed`). The voice can't change after the session has spoken.
- **Turn detection:** `server_vad` (threshold, padding, silence duration) or `semantic_vad` (`eagerness` low / medium / high / auto), each with `create_response` and `interrupt_response`; or `null`, where the client commits the input buffer and asks for each response.
- **Interruptions:** over WebSocket the client stops playback, cancels (`response.cancel`) and truncates the assistant's audio item to what was heard (`conversation.item.truncate`).
- **Function calling:** `response.function_call_arguments.done`, answered with a `function_call_output` item and a new `response.create`.
- **Audio:** PCM16 24 kHz mono (or G.711 µ-law / A-law) in and out, base64 in JSON events.
- **Transcripts:** the model's own (`response.output_audio_transcript.*`) and, when input transcription is on, yours (`conversation.item.input_audio_transcription.completed`, with its own usage).
- **Usage:** `response.done` reports input text, audio and cached tokens and output text and audio tokens. Audio is about 10 tokens a second in and 20 out.
- **Prices** (USD per 1M tokens): `gpt-realtime-2.1` audio in $32 (cached $0.40), audio out $64, text in $4 (cached $0.40), text out $24; `gpt-realtime-2.1-mini` audio in $10 (cached $0.30), audio out $20, text in $0.60 (cached $0.06), text out $2.40.
- **OpenRouter** offers `openai/gpt-audio` and `openai/gpt-audio-mini` (audio in and out over chat completions) but not the Realtime API, so GPT Realtime needs an OpenAI key of its own.

### Measured

Gateway on macOS, 2026-11-10, a scripted client sending macOS `say` speech as 24 kHz PCM over the WebSocket. **No OpenAI key was available**, so GPT Realtime ran against a local stand-in that speaks OpenAI's Realtime protocol (`apps/gateway/src/voice-engine/fake-openai-realtime.ts`, 300 ms simulated model delay). The deep brain was real (OpenRouter).

| What | Result |
|---|---|
| Sibyl voice (real OpenRouter, same audio): end of speech → first audio | 4.8–5.4 s, about $0.001–0.004 per turn |
| GPT Realtime path: end of speech → first audio (stand-in model) | 0.33 s, of which 0.30 s was the stand-in's delay: the gateway adds about 30 ms |
| Barge-in | Playback stopped, response cancelled and truncated |
| Handoff | `ask_sibyl` → deep brain (real) → a table in chat → the result spoken by the realtime voice |

What OpenAI's model itself adds (time to first audio, real cost per minute) has not been measured here; the per-minute prices above are estimates from the published rates.

## When speech fails

If the speech model fails, the reply continues as text and visuals. The browser shows a non-fatal "Voice reply unavailable" notice (an `error` event with `scope: "tts"`).
