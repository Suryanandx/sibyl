import { describe, expect, it, vi } from "vitest";
import type { TTSStreamChunk } from "@open-gpt-live/adapters";
import { AdaptiveVadEngine, DEFAULT_VAD_CONFIG, type SpeechDetectorEvent } from "@open-gpt-live/core";
import { parseClientMessage, parseServerMessage } from "@open-gpt-live/protocol";
import { FIRST_SEGMENT_MAX_LENGTH, takeReadyTtsSegments } from "./segments.js";
import { Prefetched } from "./prefetch.js";
import { PreemptiveGeneration } from "./preemptive.js";
import { pcm16MonoToWav, speechPieces } from "./speech-stream.js";
import { turnMetrics } from "./turn-metrics.js";

const config = { ttsSegmentMinLength: 14, ttsSegmentMaxLength: 240 };

async function* chunks(parts: Buffer[], format = "pcm"): AsyncIterable<TTSStreamChunk> {
  for (const audio of parts) yield { audio, mimeType: format === "pcm" ? "audio/pcm" : `audio/${format}`, format };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

const dataBytes = (wav: Buffer) => wav.subarray(44).byteLength;

describe("speech segments", () => {
  it("starts speaking on the first clause, then takes whole clauses", () => {
    const first = takeReadyTtsSegments("Oh, that's a lovely idea, honestly. How about Bean There? It", config, true);
    expect(first.segments[0]).toBe("Oh, that's a lovely idea,");
    expect(first.segments.slice(1)).toEqual(["honestly. How about Bean There?"]);
    expect(first.remainder).toBe("It");
  });

  it("waits for whitespace after punctuation (numbers and abbreviations stay whole)", () => {
    expect(takeReadyTtsSegments("The rate is about 3.", config, true).segments).toEqual([]);
    expect(takeReadyTtsSegments("The rate is about 3.5 percent, roughly", config, true).segments).toEqual(["The rate is about 3.5 percent,"]);
  });

  it("cuts a long first clause without punctuation at a word boundary", () => {
    const text = "so here is a fairly long opening without any punctuation at all in it and more";
    const { segments, remainder } = takeReadyTtsSegments(text, config, true);
    expect(segments[0]!.length).toBeLessThanOrEqual(FIRST_SEGMENT_MAX_LENGTH);
    expect(`${segments[0]} ${remainder}`).toBe(text);
  });

  it("later segments are not cut mid-clause", () => {
    expect(takeReadyTtsSegments("so here is a fairly long opening without any punctuation at all in it and more", config).segments).toEqual([]);
  });
});

describe("streamed speech pieces", () => {
  it("cuts raw PCM into a short first piece, then 300 ms pieces, as valid WAV", async () => {
    const second = 24_000 * 2;
    const pieces = await collect(speechPieces(chunks([Buffer.alloc(second / 2), Buffer.alloc(second / 2 + 3)]), "pcm", { sampleRate: 24_000 }));
    expect(pieces.map((piece) => piece.mimeType)).toEqual(Array(pieces.length).fill("audio/wav"));
    expect(dataBytes(pieces[0]!.audio)).toBe(0.12 * second);
    expect(dataBytes(pieces[1]!.audio)).toBe(0.3 * second);
    const total = pieces.reduce((sum, piece) => sum + dataBytes(piece.audio), 0);
    expect(total).toBe(second + 2);
    expect(pieces[0]!.audio.toString("ascii", 0, 4)).toBe("RIFF");
    expect(pieces[0]!.audio.readUInt32LE(24)).toBe(24_000);
  });

  it("reads the sample rate from a streamed WAV header split across chunks", async () => {
    const wav = pcm16MonoToWav(Buffer.alloc(16_000 * 2), 16_000);
    const pieces = await collect(speechPieces(chunks([wav.subarray(0, 20), wav.subarray(20)], "wav"), "wav"));
    expect(pieces[0]!.audio.readUInt32LE(24)).toBe(16_000);
    expect(pieces.reduce((sum, piece) => sum + dataBytes(piece.audio), 0)).toBe(16_000 * 2);
  });

  it("passes undecodable MP3 and other formats on whole", async () => {
    const junk = await collect(speechPieces(chunks([Buffer.from([1, 2]), Buffer.from([3])], "mp3"), "mp3"));
    expect(junk).toHaveLength(1);
    expect([...junk[0]!.audio]).toEqual([1, 2, 3]);
    const opus = await collect(speechPieces(chunks([Buffer.from([9]), Buffer.from([8])], "opus"), "opus"));
    expect(opus).toHaveLength(1);
    expect(opus[0]!.mimeType).toBe("audio/opus");
  });

  it("reports the first audio byte once", async () => {
    const onFirstByte = vi.fn();
    await collect(speechPieces(chunks([Buffer.alloc(10), Buffer.alloc(10)]), "pcm", { onFirstByte }));
    expect(onFirstByte).toHaveBeenCalledTimes(1);
  });
});

describe("prefetched streams", () => {
  it("reads ahead and replays in order, errors included", async () => {
    async function* source() {
      yield 1;
      yield 2;
      throw new Error("boom");
    }
    const prefetched = new Prefetched(source());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prefetched.size).toBe(2);
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const value of prefetched.read()) seen.push(value);
      })()
    ).rejects.toThrow("boom");
    expect(seen).toEqual([1, 2]);
  });
});

describe("preemptive generation", () => {
  const stream = (signal: AbortSignal) => ({
    stream: (async function* () {
      yield { delta: "Hi" };
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!signal.aborted) yield { delta: " there." };
    })(),
    winner: () => "voice/a"
  });

  it("hands over the reply for the same turn, history and model", async () => {
    const preemptive = new PreemptiveGeneration({ now: () => 100 });
    preemptive.start("t1", { historyLength: 2, model: "voice/a" }, stream);
    const reply = preemptive.take("t1", { historyLength: 2, model: "voice/a" });
    expect(reply?.startedAt).toBe(100);
    expect((await collect(reply!.stream)).map((c) => c.delta).join("")).toBe("Hi there.");
    expect(preemptive.take("t1", { historyLength: 2, model: "voice/a" })).toBeUndefined();
  });

  it("drops it when the context changed or the person carried on", () => {
    const preemptive = new PreemptiveGeneration({ now: () => 0 });
    let signal: AbortSignal | undefined;
    preemptive.start("t1", { historyLength: 2, model: "voice/a" }, (s) => ((signal = s), stream(s)));
    expect(preemptive.take("t1", { historyLength: 3, model: "voice/a" })).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    preemptive.start("t2", { historyLength: 2, model: "voice/a" }, (s) => ((signal = s), stream(s)));
    preemptive.cancel("t2", "speech resumed");
    expect(signal?.aborted).toBe(true);
    expect(preemptive.take("t2", { historyLength: 2, model: "voice/a" })).toBeUndefined();
  });

  it("allows at most three attempts per turn", () => {
    const preemptive = new PreemptiveGeneration({ now: () => 0 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(preemptive.canStart("t1")).toBe(true);
      preemptive.start("t1", { historyLength: 0, model: "m" }, stream);
      preemptive.cancel("t1", "resumed");
    }
    expect(preemptive.canStart("t1")).toBe(false);
  });
});

describe("turn metrics (LiveKit names)", () => {
  it("measures from the last voiced audio", () => {
    const metrics = turnMetrics(
      { speechEndedAt: 1_400, silenceMs: 400, finalTranscriptAt: 1_410, transcriptAt: 2_500, llmStartedAt: 1_210, firstLlmDeltaAt: 2_000, ttsStartedAt: 2_100, ttsFirstByteAt: 2_600, firstTtsChunkAt: 2_650, preemptive: true },
      { transport: "livekit", voiceModel: "v", ttsModel: "t" }
    );
    expect(metrics).toEqual({
      transport: "livekit",
      eouDelayMs: 410,
      transcriptionDelayMs: 1_500,
      llmTtftMs: 790,
      ttsTtfbMs: 500,
      e2eLatencyMs: 1_650,
      preemptive: true,
      voiceModel: "v",
      ttsModel: "t"
    });
  });
});

describe("speech detector pauses", () => {
  function run(levels: Array<[number, number]>): SpeechDetectorEvent[] {
    const vad = new AdaptiveVadEngine({ ...DEFAULT_VAD_CONFIG, adaptiveEnabled: false });
    const events: SpeechDetectorEvent[] = [];
    let now = 0;
    for (const [ms, rms] of levels) {
      for (let t = 0; t < ms; t += 20) {
        now += 20;
        const event = vad.processFrame({ rms, now, playbackActive: false, suppressStartsUntil: 0 }).event;
        if (event) events.push(event);
      }
    }
    return events;
  }

  it("reports a pause before the hangover ends the turn, and the silence it waited", () => {
    const events = run([[600, 0.1], [600, 0]]);
    expect(events.map((event) => event.type)).toEqual(["speech_start", "speech_pause", "speech_end"]);
    expect(events[1]).toMatchObject({ silenceMs: 200 });
    expect(events[2]).toMatchObject({ silenceMs: DEFAULT_VAD_CONFIG.hangoverMs });
  });

  it("reports a resume when speech comes back after a pause", () => {
    const events = run([[600, 0.1], [260, 0], [400, 0.1], [600, 0]]);
    expect(events.map((event) => event.type)).toEqual(["speech_start", "speech_pause", "speech_resume", "speech_pause", "speech_end"]);
  });
});

describe("protocol", () => {
  it("parses the voice latency messages", () => {
    expect(parseClientMessage({ type: "vad.speech_pause", requestId: "r", silenceMs: 200 }).success).toBe(true);
    expect(parseClientMessage({ type: "vad.speech_pause", requestId: "r", silenceMs: -1 }).success).toBe(false);
    expect(parseClientMessage({ type: "vad.speech_resume", requestId: "r" }).success).toBe(true);
    const end = parseClientMessage({ type: "vad.speech_end", requestId: "r", endedAt: 1, reason: "silence", silenceMs: 400 });
    expect(end.success && "silenceMs" in end.data ? end.data.silenceMs : undefined).toBe(400);
    expect(parseClientMessage({ type: "session.update", settings: { speechProvider: "elsewhere" } }).success).toBe(false);
    expect(parseClientMessage({ type: "session.update", settings: { preemptiveGeneration: false, speechProvider: "livekit" } }).success).toBe(true);
    const metrics = parseServerMessage({ type: "turn.metrics", requestId: "r", metrics: { transport: "websocket", e2eLatencyMs: 2_000, llmTtftMs: "x" } });
    expect(metrics.success && metrics.data).toEqual({ type: "turn.metrics", requestId: "r", metrics: { transport: "websocket", e2eLatencyMs: 2_000 } });
  });
});
