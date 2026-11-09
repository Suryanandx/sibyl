/**
 * Gapless streaming playback for spoken replies.
 *
 * Each TTS segment arrives as a small encoded file (mp3/wav). Instead of
 * playing them one <audio> element at a time (audible gaps, slow start), every
 * segment is decoded and scheduled back-to-back on a single Web Audio timeline.
 * Barge-in stops all scheduled audio instantly.
 */

interface QueuedChunk {
  bytes: Uint8Array;
  mimeType: string;
}

interface PlaybackStream {
  requestId: string;
  chunks: Map<number, QueuedChunk>;
  nextSequence: number;
  ended: boolean;
  decoding: boolean;
  sources: Set<AudioBufferSourceNode>;
  scheduledUntil: number;
  started: boolean;
}

export interface StreamPlayerHooks {
  /** First audio of a request started playing. */
  onStart?: (requestId: string) => void;
  /** A chunk finished playing (used for playback acks). */
  onChunkPlayed?: (requestId: string, sequence: number) => void;
  /** All audio for an ended request has played. */
  onDone?: (requestId: string) => void;
  /** Browser blocked audio until a user gesture. */
  onBlocked?: (blocked: boolean) => void;
}

export class StreamPlayer {
  private context: AudioContext | null = null;
  private readonly streams = new Map<string, PlaybackStream>();
  private timelineEnd = 0;

  constructor(private readonly hooks: StreamPlayerHooks = {}) {}

  /** Create/resume the AudioContext. Call from a user gesture (click, tap). */
  async unlock(): Promise<void> {
    const context = this.ensureContext();
    if (context.state !== "running") {
      try {
        await context.resume();
      } catch {
        // Still blocked; the UI offers a tap-to-enable button.
      }
    }
    this.hooks.onBlocked?.(context.state !== "running");
    for (const stream of this.streams.values()) {
      void this.drain(stream);
    }
  }

  has(requestId: string): boolean {
    return this.streams.has(requestId);
  }

  start(requestId: string): void {
    if (this.streams.has(requestId)) return;
    this.streams.set(requestId, {
      requestId,
      chunks: new Map(),
      nextSequence: 0,
      ended: false,
      decoding: false,
      sources: new Set(),
      scheduledUntil: 0,
      started: false
    });
  }

  push(requestId: string, sequence: number, bytes: Uint8Array, mimeType: string): void {
    this.start(requestId);
    const stream = this.streams.get(requestId)!;
    stream.chunks.set(sequence, { bytes, mimeType });
    void this.drain(stream);
  }

  /** No more chunks will arrive for this request. */
  end(requestId: string): void {
    const stream = this.streams.get(requestId);
    if (!stream) return;
    stream.ended = true;
    this.maybeFinish(stream);
  }

  /** Stop and forget a request's audio (interrupt / cancel). */
  stop(requestId: string): void {
    const stream = this.streams.get(requestId);
    if (!stream) return;
    this.streams.delete(requestId);
    for (const source of stream.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    stream.sources.clear();
    this.recomputeTimeline();
  }

  stopAll(): void {
    for (const requestId of [...this.streams.keys()]) this.stop(requestId);
  }

  /** True while audio is playing, scheduled, or being decoded. */
  isActive(): boolean {
    for (const stream of this.streams.values()) {
      if (stream.sources.size > 0 || stream.decoding) return true;
    }
    return false;
  }

  activeRequestId(): string | null {
    for (const stream of this.streams.values()) {
      if (stream.sources.size > 0 || stream.decoding) return stream.requestId;
    }
    return null;
  }

  private ensureContext(): AudioContext {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.timelineEnd = 0;
    }
    return this.context;
  }

  private async drain(stream: PlaybackStream): Promise<void> {
    if (stream.decoding) return;
    const context = this.ensureContext();
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // ignore
      }
      if ((context.state as AudioContextState) !== "running") {
        this.hooks.onBlocked?.(true);
        return;
      }
    }

    stream.decoding = true;
    try {
      while (this.streams.get(stream.requestId) === stream) {
        const sequence = stream.nextSequence;
        const chunk = stream.chunks.get(sequence);
        if (!chunk) break;
        stream.chunks.delete(sequence);
        stream.nextSequence += 1;

        let buffer: AudioBuffer;
        try {
          const copy = chunk.bytes.slice().buffer;
          buffer = await context.decodeAudioData(copy);
        } catch {
          // Undecodable segment: skip it rather than stalling the reply.
          this.hooks.onChunkPlayed?.(stream.requestId, sequence);
          continue;
        }
        if (this.streams.get(stream.requestId) !== stream) return;

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const startAt = Math.max(context.currentTime + 0.03, this.timelineEnd);
        source.start(startAt);
        this.timelineEnd = startAt + buffer.duration;
        stream.scheduledUntil = this.timelineEnd;
        stream.sources.add(source);
        if (!stream.started) {
          stream.started = true;
          const delayMs = Math.max(0, (startAt - context.currentTime) * 1000);
          window.setTimeout(() => {
            if (this.streams.get(stream.requestId) === stream) {
              this.hooks.onStart?.(stream.requestId);
            }
          }, delayMs);
        }
        source.onended = () => {
          stream.sources.delete(source);
          this.hooks.onChunkPlayed?.(stream.requestId, sequence);
          this.maybeFinish(stream);
        };
      }
    } finally {
      stream.decoding = false;
    }
    this.maybeFinish(stream);
  }

  private maybeFinish(stream: PlaybackStream): void {
    if (
      this.streams.get(stream.requestId) === stream &&
      stream.ended &&
      !stream.decoding &&
      stream.chunks.size === 0 &&
      stream.sources.size === 0
    ) {
      this.streams.delete(stream.requestId);
      this.hooks.onDone?.(stream.requestId);
    }
  }

  private recomputeTimeline(): void {
    let end = 0;
    for (const stream of this.streams.values()) {
      if (stream.sources.size > 0) end = Math.max(end, stream.scheduledUntil);
    }
    this.timelineEnd = end;
  }
}
