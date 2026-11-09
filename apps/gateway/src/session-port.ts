/**
 * The transport seam of a gateway session (one GatewayConnection).
 *
 * A session runs the whole voice and chat brain: turn-taking, the voice brain,
 * the deep brain, hedging, metering, budgets, approvals, memory and history.
 * It used to be tied to one browser WebSocket. Now it talks through:
 *
 * - `SessionTransport`: where its protocol messages go and come from. The
 *   browser's WebSocket satisfies it as is; `headlessTransport()` is a
 *   session with no browser (a phone call, a stream being listened to).
 * - `VoiceSessionPort`: how a media layer (the LiveKit room agent in
 *   ./realtime) drives the same session — it delivers the same client
 *   messages a browser would send (so the same permission checks apply),
 *   takes the spoken audio instead of `tts.chunk`, and watches what the
 *   session says.
 *
 * Nothing is copied: there is one pipeline, with two ways in and out.
 */
import { EventEmitter } from "node:events";
import type { ClientMessage, ServerMessage } from "@open-gpt-live/protocol";
import type { Principal } from "@open-gpt-live/core";

/** The part of a `ws` WebSocket a session uses (a WebSocket is one). */
export interface SessionTransport {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

/** WebSocket.OPEN */
export const TRANSPORT_OPEN = 1;
const TRANSPORT_CLOSED = 3;

/**
 * A session without a browser. Its messages go nowhere (watch them with
 * `VoiceSessionPort.observe`); `close()` ends the session.
 */
export function headlessTransport(): SessionTransport {
  const events = new EventEmitter();
  let state = TRANSPORT_OPEN;
  const end = () => {
    if (state === TRANSPORT_CLOSED) return;
    state = TRANSPORT_CLOSED;
    events.emit("close");
  };
  return {
    get readyState() {
      return state;
    },
    send() {},
    close: end,
    terminate: end,
    on(event: string, listener: (...args: any[]) => void) {
      events.on(event, listener);
      return this;
    },
    once(event: string, listener: () => void) {
      events.once(event, listener);
      return this;
    }
  } as SessionTransport;
}

/** One synthesized speech segment (what `tts.chunk` would carry). */
export interface SpeechSegment {
  requestId: string;
  /** Encoded audio: audio/mpeg, audio/wav, … as the voice model produced it. */
  audio: Uint8Array;
  mimeType: string;
  segmentIndex: number;
  isFinal: boolean;
}

/** Where a session's spoken replies go instead of `tts.chunk`. */
export interface VoiceMediaSink {
  speech(segment: SpeechSegment): void;
  /** The reply's speech ended ("stop") or was cut off. */
  speechEnd(requestId: string, reason: "stop" | "interrupted" | "error"): void;
}

export interface VoiceSessionPort {
  readonly sessionId: string;
  readonly principal: Principal;
  /** The workspace the session acts in. */
  readonly currentWorkspaceId: string;
  /** The live conversation (may not be stored until its first turn). */
  readonly conversationId: string;
  /** False once the session ended. */
  readonly open: boolean;
  /** Handle a client message as if the browser had sent it (same checks, same queue). */
  deliver(message: ClientMessage): void;
  /** Send spoken replies to this sink instead of `tts.chunk` (undefined: back to the socket). */
  attachMedia(sink: VoiceMediaSink | undefined): void;
  /** Every message the session sends (before it reaches the socket). Returns an unsubscribe. */
  observe(listener: (message: ServerMessage) => void): () => void;
  /** Send one extra message to the session's own socket (e.g. realtime.turn). */
  notify(message: ServerMessage): void;
  /** Transcribe 16-bit mono PCM with the session's speech-to-text model (metered). */
  transcribe(pcm: Buffer, sampleRate: number, requestId: string): Promise<string>;
  /** Something said that wasn't for Sibyl (group calls, streams): kept as context and in the history. */
  addNote(speaker: string, text: string): void;
  /** Speak a line now (or once the current reply finished), e.g. a phone greeting. */
  say(text: string): void;
  /** Called once when the session ends. Returns an unsubscribe. */
  onClose(listener: () => void): () => void;
  /** End a session this layer opened (headless sessions). */
  close(reason: string): void;
}
