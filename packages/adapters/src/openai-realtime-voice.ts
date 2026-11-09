/**
 * OpenAI Realtime (speech-to-speech) over a server-side WebSocket.
 *
 * One connection is one Realtime session (wss://api.openai.com/v1/realtime?model=…,
 * `Authorization: Bearer <key>`; the GA interface, no beta header). The client
 * sends 24 kHz 16-bit mono PCM, configures the session (instructions, voice,
 * tools, turn detection, input transcription) and gets typed events back:
 * audio and transcript deltas, function calls, input transcripts and the usage
 * of every response. It never logs or exposes the key.
 *
 * The socket is structural (StreamingSTTWebSocket): `ws` in Node.js, a fake in tests.
 */
import type { StreamingSTTWebSocket, StreamingSTTWebSocketFactory } from "./streaming-stt";

export const OPENAI_REALTIME_VOICE_URL = "wss://api.openai.com/v1/realtime";
/** The only input/output PCM rate GPT Realtime accepts. */
export const REALTIME_PCM_RATE = 24_000;
const MAX_APPEND_BYTES = 15 * 1024 * 1024;
/** Append in ~0.5 s pieces so a long turn never makes one huge message. */
const APPEND_PIECE_BYTES = REALTIME_PCM_RATE; // 0.5 s of 16-bit mono

export interface RealtimeFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type RealtimeTurnDetectionConfig = null | { type: "semantic_vad"; eagerness: "low" | "medium" | "high" | "auto" };

export interface RealtimeVoiceSessionConfig {
  instructions: string;
  voice: string;
  tools: RealtimeFunctionTool[];
  /** null: the client decides turns (input_audio_buffer.commit + response.create). */
  turnDetection: RealtimeTurnDetectionConfig;
  /** Input transcription model (user transcripts); absent: none. */
  transcriptionModel?: string;
  language?: string;
}

/** Token usage of one response (response.done). */
export interface RealtimeResponseUsage {
  inputTextTokens: number;
  inputAudioTokens: number;
  cachedTextTokens: number;
  cachedAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
}

/** What an input transcription cost (tokens, or seconds of audio). */
export type RealtimeTranscriptionUsage =
  | { type: "tokens"; inputTokens: number; outputTokens: number }
  | { type: "duration"; seconds: number };

export type RealtimeVoiceEvent =
  | { type: "response.created"; responseId: string }
  | { type: "audio"; responseId: string; itemId: string; audio: Buffer }
  | { type: "transcript.delta"; responseId: string; itemId: string; delta: string }
  | { type: "transcript.done"; responseId: string; itemId: string; transcript: string }
  | { type: "function_call"; responseId: string; callId: string; name: string; arguments: string }
  | { type: "response.done"; responseId: string; status: string; usage?: RealtimeResponseUsage; error?: string }
  | { type: "input.speech_started" }
  | { type: "input.speech_stopped" }
  | { type: "input.committed"; itemId: string }
  | { type: "input.transcript"; itemId: string; transcript: string; usage?: RealtimeTranscriptionUsage }
  | { type: "input.transcript_failed"; itemId: string; message: string }
  | { type: "error"; message: string; code?: string }
  | { type: "closed"; code: number; reason: string };

export interface RealtimeVoiceConnectOptions {
  apiKey: string;
  model: string;
  webSocketFactory: StreamingSTTWebSocketFactory;
  url?: string;
  signal?: AbortSignal;
  /** Give up connecting after this long (default 10 s). */
  timeoutMs?: number;
}

/** A message item added to the Realtime conversation (context from Sibyl's history). */
export type RealtimeContextItem =
  | { role: "user" | "system"; text: string }
  | { role: "assistant"; text: string };

export class OpenAIRealtimeVoiceClient {
  private readonly listeners = new Set<(event: RealtimeVoiceEvent) => void>();
  private closed = false;
  private hasAudio = false;

  private constructor(private readonly socket: StreamingSTTWebSocket) {}

  /** Open a session; resolves once OpenAI sent `session.created`. */
  static connect(options: RealtimeVoiceConnectOptions): Promise<OpenAIRealtimeVoiceClient> {
    if (!options.apiKey) return Promise.reject(new Error("An OpenAI key is required for GPT Realtime"));
    const url = new URL(options.url ?? OPENAI_REALTIME_VOICE_URL);
    url.searchParams.set("model", options.model);
    const socket = options.webSocketFactory(url.toString(), { headers: { Authorization: `Bearer ${options.apiKey}` } });
    const client = new OpenAIRealtimeVoiceClient(socket);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) {
          client.close(1000, "connect failed");
          reject(error);
        } else resolve(client);
      };
      const onAbort = () => finish(new Error("GPT Realtime connection aborted"));
      const timer = setTimeout(() => finish(new Error("GPT Realtime didn't answer in time")), options.timeoutMs ?? 10_000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("message", (data) => {
        const event = parseServerEvent(data);
        if (!event) return;
        if (!settled) {
          if (event.type === "session.created") finish();
          else if (event.type === "error") finish(new Error(errorMessage(event)));
          return;
        }
        client.dispatch(event);
      });
      socket.on("error", (error) => {
        if (!settled) finish(new Error(`Couldn't reach GPT Realtime: ${error instanceof Error ? error.message : String(error)}`));
      });
      socket.on("close", (code, reason) => {
        if (!settled) finish(new Error(code === 1008 || code === 4001 ? "OpenAI didn't accept the key" : `GPT Realtime closed the connection (${code})`));
        client.handleClose(code, reason);
      });
    });
  }

  get open(): boolean {
    return !this.closed && this.socket.readyState === 1;
  }

  on(listener: (event: RealtimeVoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configure(config: RealtimeVoiceSessionConfig, options: { includeVoice?: boolean } = {}): void {
    const includeVoice = options.includeVoice ?? true;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: config.instructions,
        output_modalities: ["audio"],
        tools: config.tools.map((tool) => ({ type: "function", ...tool })),
        tool_choice: "auto",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: REALTIME_PCM_RATE },
            noise_reduction: { type: "near_field" },
            transcription: config.transcriptionModel
              ? { model: config.transcriptionModel, ...(config.language ? { language: config.language } : {}) }
              : null,
            // Responses are always started by the client, so every reply maps to a Sibyl request.
            turn_detection: config.turnDetection ? { ...config.turnDetection, create_response: false, interrupt_response: false } : null
          },
          output: {
            format: { type: "audio/pcm", rate: REALTIME_PCM_RATE },
            ...(includeVoice ? { voice: config.voice } : {})
          }
        }
      }
    });
  }

  /** 24 kHz 16-bit mono PCM. */
  appendAudio(pcm: Uint8Array): void {
    if (pcm.byteLength === 0) return;
    if (pcm.byteLength > MAX_APPEND_BYTES) throw new Error("Audio chunk is too large for GPT Realtime");
    const buffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let offset = 0; offset < buffer.byteLength; offset += APPEND_PIECE_BYTES) {
      this.send({ type: "input_audio_buffer.append", audio: buffer.subarray(offset, offset + APPEND_PIECE_BYTES).toString("base64") });
    }
    this.hasAudio = true;
  }

  /** Audio appended since the last commit/clear. */
  get pendingAudio(): boolean {
    return this.hasAudio;
  }

  commit(): void {
    if (!this.hasAudio) return;
    this.send({ type: "input_audio_buffer.commit" });
    this.hasAudio = false;
  }

  clearInput(): void {
    this.send({ type: "input_audio_buffer.clear" });
    this.hasAudio = false;
  }

  /** The server committed the buffer itself (semantic turn detection). */
  markCommitted(): void {
    this.hasAudio = false;
  }

  createResponse(): void {
    this.send({ type: "response.create" });
  }

  cancelResponse(responseId?: string): void {
    this.send({ type: "response.cancel", ...(responseId ? { response_id: responseId } : {}) });
  }

  /** Cut an assistant audio item at what the user actually heard. */
  truncate(itemId: string, audioEndMs: number): void {
    this.send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.floor(audioEndMs)) });
  }

  addContext(item: RealtimeContextItem): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: item.role,
        content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.text }]
      }
    });
  }

  functionOutput(callId: string, output: string): void {
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private send(event: Record<string, unknown>): void {
    if (!this.open) return;
    this.socket.send(JSON.stringify(event));
  }

  private handleClose(code: number, reason: unknown): void {
    const wasClosed = this.closed;
    this.closed = true;
    // Only an unexpected close is news to the listeners.
    if (!wasClosed) this.emit({ type: "closed", code, reason: reasonText(reason) });
  }

  private emit(event: RealtimeVoiceEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private dispatch(event: ServerEvent): void {
    const mapped = mapServerEvent(event);
    if (mapped) this.emit(mapped);
  }
}

type ServerEvent = Record<string, unknown> & { type: string };

function parseServerEvent(data: unknown): ServerEvent | undefined {
  try {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" ? (value as ServerEvent) : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function errorMessage(event: ServerEvent): string {
  const error = record(event.error);
  return str(error.message) || "GPT Realtime reported an error";
}

function reasonText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (Buffer.isBuffer(reason)) return reason.toString("utf8");
  return "";
}

/** response.done usage → token counts (cached tokens are part of the input counts). */
export function parseRealtimeUsage(value: unknown): RealtimeResponseUsage | undefined {
  const usage = record(value);
  if (!Object.keys(usage).length) return undefined;
  const input = record(usage.input_token_details);
  const cached = record(input.cached_tokens_details);
  const output = record(usage.output_token_details);
  return {
    inputTextTokens: num(input.text_tokens),
    inputAudioTokens: num(input.audio_tokens),
    cachedTextTokens: num(cached.text_tokens),
    cachedAudioTokens: num(cached.audio_tokens),
    outputTextTokens: num(output.text_tokens),
    outputAudioTokens: num(output.audio_tokens)
  };
}

function mapServerEvent(event: ServerEvent): RealtimeVoiceEvent | undefined {
  switch (event.type) {
    case "response.created":
      return { type: "response.created", responseId: str(record(event.response).id) };
    case "response.output_audio.delta":
      return { type: "audio", responseId: str(event.response_id), itemId: str(event.item_id), audio: Buffer.from(str(event.delta), "base64") };
    case "response.output_audio_transcript.delta":
      return { type: "transcript.delta", responseId: str(event.response_id), itemId: str(event.item_id), delta: str(event.delta) };
    case "response.output_audio_transcript.done":
      return { type: "transcript.done", responseId: str(event.response_id), itemId: str(event.item_id), transcript: str(event.transcript) };
    case "response.function_call_arguments.done":
      return { type: "function_call", responseId: str(event.response_id), callId: str(event.call_id), name: str(event.name), arguments: str(event.arguments) };
    case "response.done": {
      const response = record(event.response);
      const details = record(response.status_details);
      const error = record(details.error);
      const usage = parseRealtimeUsage(response.usage);
      return {
        type: "response.done",
        responseId: str(response.id),
        status: str(response.status) || "completed",
        ...(usage ? { usage } : {}),
        ...(str(error.message) ? { error: str(error.message) } : {})
      };
    }
    case "input_audio_buffer.speech_started":
      return { type: "input.speech_started" };
    case "input_audio_buffer.speech_stopped":
      return { type: "input.speech_stopped" };
    case "input_audio_buffer.committed":
      return { type: "input.committed", itemId: str(event.item_id) };
    case "conversation.item.input_audio_transcription.completed": {
      const usage = record(event.usage);
      return {
        type: "input.transcript",
        itemId: str(event.item_id),
        transcript: str(event.transcript),
        ...(usage.type === "duration"
          ? { usage: { type: "duration" as const, seconds: num(usage.seconds) } }
          : usage.type === "tokens"
            ? { usage: { type: "tokens" as const, inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) } }
            : {})
      };
    }
    case "conversation.item.input_audio_transcription.failed":
      return { type: "input.transcript_failed", itemId: str(event.item_id), message: str(record(event.error).message) };
    case "error": {
      const error = record(event.error);
      return { type: "error", message: errorMessage(event), ...(str(error.code) ? { code: str(error.code) } : {}) };
    }
    default:
      return undefined;
  }
}

/** Linear resampling of 16-bit mono PCM (e.g. 16 or 48 kHz → 24 kHz for GPT Realtime). */
export function resamplePcm16(pcm: Uint8Array, fromRate: number, toRate: number): Buffer {
  const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  if (fromRate === toRate || input.byteLength === 0) return Buffer.from(input);
  const inSamples = input.byteLength / 2;
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  const step = fromRate / toRate;
  for (let index = 0; index < outSamples; index += 1) {
    const position = index * step;
    const left = Math.min(inSamples - 1, Math.floor(position));
    const right = Math.min(inSamples - 1, left + 1);
    const fraction = position - left;
    const value = input.readInt16LE(left * 2) * (1 - fraction) + input.readInt16LE(right * 2) * fraction;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2);
  }
  return out;
}
