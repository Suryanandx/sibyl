/**
 * Audio plumbing for the room agent: speech segments from the voice model
 * (MP3, WAV or raw PCM) → 16-bit mono PCM, and the level of a PCM frame for
 * the speech detector. MP3 is decoded in WebAssembly (mpg123-decoder), so no
 * ffmpeg is needed in the image.
 */
import type { MPEGDecoder } from "mpg123-decoder";

export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
}

/** Sample rate the room agent hears people at (the same as the browser's live mode). */
export const LISTEN_SAMPLE_RATE = 24_000;
export const LISTEN_MIME_TYPE = `audio/pcm;rate=${LISTEN_SAMPLE_RATE}`;

/** RMS of 16-bit PCM on a 0–1 scale (what the speech detector expects). */
export function rmsOf(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]! / 32_768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function pcmBytes(samples: Int16Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function floatToInt16(channels: Float32Array[], length: number): Int16Array {
  const out = new Int16Array(length);
  const count = channels.length || 1;
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / count));
    out[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

/** 16-bit PCM from a RIFF/WAVE file (mono or the first channels mixed down). */
export function decodeWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error("not a WAV file");
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = LISTEN_SAMPLE_RATE;
  let bits = 16;
  while (offset + 8 <= bytes.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      if (bits !== 16) throw new Error(`unsupported WAV sample size ${bits}`);
      // Streamed WAVs may carry a 0 or 0xFFFFFFFF data size: read to the end.
      const end = size === 0 || size === 0xffffffff ? bytes.byteLength : Math.min(bytes.byteLength, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const out = new Int16Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) sum += view.getInt16(body + (frame * channels + channel) * 2, true);
        out[frame] = Math.round(sum / channels);
      }
      return { samples: out, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data");
}

/**
 * Decodes a speech segment. One instance per voice keeps one WebAssembly MP3
 * decoder warm (reset between segments).
 */
export class SpeechDecoder {
  private mpeg: Promise<MPEGDecoder> | undefined;

  async decode(audio: Uint8Array, mimeType: string, pcmRate = LISTEN_SAMPLE_RATE): Promise<Pcm> {
    const type = mimeType.toLowerCase();
    if (type.includes("wav")) return decodeWav(audio);
    if (type.includes("pcm") || type.includes("l16")) {
      const copy = new Uint8Array(audio.byteLength - (audio.byteLength % 2));
      copy.set(audio.subarray(0, copy.byteLength));
      const rate = Number(/rate=(\d+)/.exec(type)?.[1]) || pcmRate;
      return { samples: new Int16Array(copy.buffer), sampleRate: rate };
    }
    if (type.includes("mpeg") || type.includes("mp3")) {
      const decoder = await this.mpegDecoder();
      await decoder.reset();
      const decoded = decoder.decode(audio);
      return { samples: floatToInt16(decoded.channelData, decoded.samplesDecoded), sampleRate: decoded.sampleRate };
    }
    throw new Error(`unsupported speech format ${mimeType}`);
  }

  free(): void {
    void this.mpeg?.then((decoder) => decoder.free()).catch(() => undefined);
    this.mpeg = undefined;
  }

  private mpegDecoder(): Promise<MPEGDecoder> {
    this.mpeg ??= import("mpg123-decoder").then(async ({ MPEGDecoder }) => {
      const decoder = new MPEGDecoder();
      await decoder.ready;
      return decoder;
    });
    return this.mpeg;
  }
}

/** Linear resampling (speech only; good enough between 16–48 kHz). */
export function resample(pcm: Pcm, targetRate: number): Int16Array {
  if (pcm.sampleRate === targetRate || pcm.samples.length === 0) return pcm.samples;
  const ratio = pcm.sampleRate / targetRate;
  const length = Math.floor(pcm.samples.length / ratio);
  const out = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, pcm.samples.length - 1);
    const weight = position - left;
    out[index] = Math.round(pcm.samples[left]! * (1 - weight) + pcm.samples[right]! * weight);
  }
  return out;
}
