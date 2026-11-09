# Browser support

Typing works in any current browser. Voice depends on browser audio APIs, so support varies.

| Browser | Status |
|---|---|
| **Chrome** (desktop and Android) | Recommended. Used for development and the latency measurements. |
| **Edge** | Expected to behave like Chrome (same engine). |
| **Safari** (macOS and iOS) | Should work; check microphone permission, autoplay and push-to-talk recording on your devices before relying on it. |
| **Firefox** | Typing and playback work. Voice should work but is less tested; Firefox has no built-in speech recognition, so there are no instant captions while you speak. |

## What voice uses

| Capability | Browser API | If it's missing |
|---|---|---|
| Microphone | `navigator.mediaDevices.getUserMedia` | Voice controls are unavailable; typing still works. |
| Hands-free capture | `AudioWorklet` (24 kHz mono PCM) | Falls back to `ScriptProcessorNode`. |
| Push-to-talk recording | `MediaRecorder` (WebM/Opus preferred) | Uses whatever format the browser offers. |
| Playback | Web Audio (`AudioContext`) | Required for spoken replies. |
| Instant captions | `SpeechRecognition` / `webkitSpeechRecognition` | No captions while you speak; the accurate transcript still appears after each turn. |

## Things to expect

- **Secure pages only.** Browsers allow the microphone only on HTTPS pages or `localhost`.
- **Autoplay.** Browsers may block audio until you interact with the page. Tapping the mic button or sending a message counts.
- **Echo.** The mic is opened with echo cancellation, and the detector raises its threshold while Sibyl is speaking. With loud speakers, Sibyl can still occasionally hear itself and stop. Headphones avoid this completely.
- **Noisy rooms.** The voice activity detector is a volume-based detector that calibrates to the room for one second when you start. Stay quiet during that moment. A steady fan is fine; sudden loud noise can start a turn, and the voice brain then usually ignores it (`@silence`).
- **Captions in Chrome** are produced by the browser vendor's speech service, not on your device. Turn them off with `NEXT_PUBLIC_LIVE_CAPTIONS=false` if that matters to you.
- **Storage.** Model choices, the theme and the owner token are kept in the browser's local storage. In private windows they last only for the session.
