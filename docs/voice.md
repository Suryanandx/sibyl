# Voice

Sibyl's live conversation is built from swappable OpenRouter models, not a single vendor's realtime API. This page explains how a spoken turn flows, how Sibyl decides when you have finished, and what the measured latency looks like.

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

## When speech fails

If the speech model fails, the reply continues as text and visuals. The browser shows a non-fatal "Voice reply unavailable" notice (an `error` event with `scope: "tts"`).
