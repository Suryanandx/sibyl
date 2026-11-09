/**
 * Streaming speech: turn a speech model's byte stream into small WAV pieces
 * that can be played (browser) or published (LiveKit room) while the rest of
 * the sentence is still being synthesized.
 *
 * Raw PCM and WAV are cut as they arrive; MP3 is decoded progressively in
 * WebAssembly (mpg123-decoder) and resampled to 24 kHz. Other formats (Opus,
 * AAC, FLAC) can't be cut safely, so they are delivered whole, as before.
 * The first piece is small (120 ms of audio) so playback starts early; later
 * pieces are 300 ms to keep the message count low.
 */
import type { TTSStreamChunk } from "@open-gpt-live/adapters";
import type { MPEGDecoder } from "mpg123-decoder";
import { floatToInt16, resample } from "../realtime/audio.js";

export interface SpeechPiece {
  audio: Buffer;
  mimeType: string;
}

/** Sample rate decoded MP3 is resampled to (the browser and the room agent both play it). */
export const STREAM_SAMPLE_RATE = 24_000;
const FIRST_PIECE_MS = 120;
const PIECE_MS = 300;

export function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** True when a format can be cut into playable pieces while it streams. */
export function isStreamableFormat(format: string): boolean {
  return format === "pcm" || format === "wav" || format === "mp3";
}

/**
 * Pieces of one speech segment, in order. `format` is what was requested
 * from the speech model; `sampleRate` is the rate of raw PCM output.
 */
export async function* speechPieces(
  chunks: AsyncIterable<TTSStreamChunk>,
  format: string,
  options: { sampleRate?: number; onFirstByte?: () => void } = {}
): AsyncIterable<SpeechPiece> {
  let first = true;
  const firstByte = (): void => {
    if (!first) return;
    first = false;
    options.onFirstByte?.();
  };
  if (!isStreamableFormat(format)) {
    const parts: Buffer[] = [];
    let mimeType = "";
    for await (const chunk of chunks) {
      firstByte();
      mimeType = chunk.mimeType;
      parts.push(Buffer.from(chunk.audio));
    }
    if (parts.length) yield { audio: Buffer.concat(parts), mimeType };
    return;
  }

  const cutter = new PcmCutter(format === "pcm" ? options.sampleRate ?? STREAM_SAMPLE_RATE : STREAM_SAMPLE_RATE);
  const wav = format === "wav" ? new WavHeaderReader() : undefined;
  // The decoder loads while the speech model works on the first audio.
  const mp3Ready = format === "mp3" ? streamingMp3Decoder().catch(() => undefined) : undefined;
  let mp3: StreamingMp3 | undefined;
  // MP3 the decoder can't read is passed on whole, as the speech model sent it.
  const raw: Buffer[] = [];
  let rawMimeType = "audio/mpeg";
  let yielded = false;
  try {
    for await (const chunk of chunks) {
      if (!chunk.audio.byteLength) continue;
      firstByte();
      let pcm: Buffer | undefined = Buffer.from(chunk.audio);
      if (wav) {
        pcm = wav.push(pcm);
        if (wav.sampleRate) cutter.sampleRate = wav.sampleRate;
      } else if (format === "mp3") {
        raw.push(pcm);
        rawMimeType = chunk.mimeType;
        if (raw.length === 1) mp3 = await mp3Ready;
        try {
          pcm = mp3?.push(pcm);
        } catch {
          // Undecodable: stop decoding (the decoder is freed below) and pass the MP3 on whole.
          mp3 = undefined;
          pcm = undefined;
        }
      }
      for (const piece of pcm?.byteLength ? cutter.push(pcm) : []) {
        yielded = true;
        yield piece;
      }
    }
    for (const piece of cutter.flush()) {
      yielded = true;
      yield piece;
    }
    if (format === "mp3" && !yielded && raw.length) yield { audio: Buffer.concat(raw), mimeType: rawMimeType };
  } finally {
    void mp3Ready?.then((decoder) => decoder?.free());
  }
}

/** Cuts 16-bit mono PCM into WAV pieces of FIRST_PIECE_MS, then PIECE_MS. */
class PcmCutter {
  private buffered: Buffer[] = [];
  private bytes = 0;
  private pieces = 0;

  constructor(public sampleRate: number) {}

  *push(pcm: Buffer): Iterable<SpeechPiece> {
    this.buffered.push(pcm);
    this.bytes += pcm.byteLength;
    for (;;) {
      const target = Math.round((this.sampleRate * (this.pieces === 0 ? FIRST_PIECE_MS : PIECE_MS)) / 1000) * 2;
      if (this.bytes < target) return;
      const all = Buffer.concat(this.buffered);
      this.buffered = [all.subarray(target)];
      this.bytes = all.byteLength - target;
      this.pieces += 1;
      yield { audio: pcm16MonoToWav(all.subarray(0, target), this.sampleRate), mimeType: "audio/wav" };
    }
  }

  *flush(): Iterable<SpeechPiece> {
    const all = Buffer.concat(this.buffered);
    this.buffered = [];
    this.bytes = 0;
    const even = all.subarray(0, all.byteLength - (all.byteLength % 2));
    if (even.byteLength) yield { audio: pcm16MonoToWav(even, this.sampleRate), mimeType: "audio/wav" };
  }
}

/** Strips a streamed RIFF/WAVE header; returns the PCM after it. */
class WavHeaderReader {
  sampleRate: number | undefined;
  private header: Buffer | undefined = Buffer.alloc(0);

  push(bytes: Buffer): Buffer | undefined {
    if (!this.header) return bytes;
    this.header = Buffer.concat([this.header, bytes]);
    const head = this.header;
    if (head.byteLength < 12) return undefined;
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
      // Not a WAV header after all: treat everything as raw PCM.
      this.header = undefined;
      return head;
    }
    let offset = 12;
    while (offset + 8 <= head.byteLength) {
      const id = head.toString("ascii", offset, offset + 4);
      const size = head.readUInt32LE(offset + 4);
      if (id === "fmt " && offset + 16 <= head.byteLength) this.sampleRate = head.readUInt32LE(offset + 12);
      if (id === "data") {
        this.header = undefined;
        return head.subarray(offset + 8);
      }
      offset += 8 + size + (size % 2);
    }
    return undefined;
  }
}

interface StreamingMp3 {
  push(bytes: Buffer): Buffer;
  free(): void;
}

async function streamingMp3Decoder(): Promise<StreamingMp3> {
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder: MPEGDecoder = new MPEGDecoder();
  await decoder.ready;
  return {
    push(bytes) {
      const decoded = decoder.decode(bytes);
      if (!decoded.samplesDecoded) return Buffer.alloc(0);
      const mono = floatToInt16(decoded.channelData, decoded.samplesDecoded);
      const samples = resample({ samples: mono, sampleRate: decoded.sampleRate }, STREAM_SAMPLE_RATE);
      return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    },
    free() {
      decoder.free();
    }
  };
}
