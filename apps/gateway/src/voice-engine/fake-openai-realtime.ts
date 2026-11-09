/**
 * A local stand-in for OpenAI's Realtime WebSocket (GA event names and
 * shapes), for tests and offline runs. It is not used in production.
 *
 * It accepts one key, keeps the input buffer, commits (by the client, or by a
 * simple "semantic" detector: 300 ms of silence after speech), transcribes
 * with scripted text, and answers each response.create with the next scripted
 * reply: spoken audio (a tone) with its transcript, optionally a function call.
 * Function outputs are answered with a spoken summary of the output.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeReply {
  say: string;
  /** Call ask_sibyl with this task after speaking. */
  handoff?: string;
  /** Audio length (default: ~60 ms per word). */
  audioMs?: number;
  /** Delay between audio chunks (default 10 ms). */
  chunkDelayMs?: number;
}

export interface FakeRealtimeOptions {
  apiKey: string;
  /** What each committed user turn "said", in order (default "hello"). */
  transcripts?: string[];
  replies?: FakeReply[];
  /** Delay before the first audio of a response (simulated model latency). */
  firstAudioDelayMs?: number;
  /** Listen on this port (default: any free port). */
  port?: number;
}

export interface FakeRealtimeServer {
  url: string;
  httpBase: string;
  /** Every client event received (audio appends summarized as { type, bytes }). */
  events: Array<Record<string, unknown>>;
  sessions: number;
  lastSession(): Record<string, unknown> | undefined;
  appendedBytes(): number;
  close(): Promise<void>;
}

const RATE = 24_000;

export async function startFakeRealtime(options: FakeRealtimeOptions): Promise<FakeRealtimeServer> {
  const transcripts = [...(options.transcripts ?? [])];
  const replies = [...(options.replies ?? [])];
  const events: Array<Record<string, unknown>> = [];
  let sessions = 0;
  let appended = 0;
  let session: Record<string, unknown> | undefined;
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${++counter}`;

  const http: Server = createServer((request, response) => {
    // GET /v1/models/<id> and /v1/models: the key check.
    const ok = request.headers.authorization === `Bearer ${options.apiKey}`;
    response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(ok ? { id: "gpt-realtime-2.1", object: "model" } : { error: { message: "Incorrect API key" } }));
  });
  const wss = new WebSocketServer({
    server: http,
    verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => info.req.headers.authorization === `Bearer ${options.apiKey}`
  });

  wss.on("connection", (socket: WebSocket) => {
    sessions += 1;
    const send = (event: Record<string, unknown>) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ event_id: id("event"), ...event }));
    };
    let buffer: Buffer[] = [];
    let heardSpeech = false;
    let trailingSilenceBytes = 0;
    let active: { id: string; cancelled: boolean } | undefined;
    let pendingOutput: string | undefined;
    send({ type: "session.created", session: { id: id("sess"), type: "realtime", model: "gpt-realtime-2.1" } });

    const commit = () => {
      const bytes = buffer.reduce((sum, part) => sum + part.byteLength, 0);
      buffer = [];
      heardSpeech = false;
      trailingSilenceBytes = 0;
      if (!bytes) return send({ type: "error", error: { type: "invalid_request_error", code: "input_audio_buffer_commit_empty", message: "buffer empty" } });
      const itemId = id("item");
      send({ type: "input_audio_buffer.committed", item_id: itemId, previous_item_id: null });
      const transcript = transcripts.shift() ?? "hello";
      setTimeout(() => {
        send({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: itemId,
          content_index: 0,
          transcript,
          usage: { type: "tokens", input_tokens: Math.round((bytes / (RATE * 2)) * 10), output_tokens: transcript.split(" ").length, total_tokens: 0 }
        });
      }, 20);
    };

    const respond = async () => {
      const responseId = id("resp");
      const current = { id: responseId, cancelled: false };
      active = current;
      send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
      const reply: FakeReply = pendingOutput !== undefined ? { say: `Here is what I found: ${pendingOutput}` } : replies.shift() ?? { say: "Okay." };
      pendingOutput = undefined;
      const itemId = id("item");
      await new Promise((resolve) => setTimeout(resolve, options.firstAudioDelayMs ?? 5));
      const words = reply.say.split(" ");
      const audioMs = reply.audioMs ?? words.length * 60;
      const chunkMs = 50;
      const chunks = Math.max(1, Math.ceil(audioMs / chunkMs));
      let audioTokens = 0;
      for (let index = 0; index < chunks; index += 1) {
        if (current.cancelled) break;
        const pcm = Buffer.alloc((RATE / 1000) * chunkMs * 2);
        for (let sample = 0; sample < pcm.length / 2; sample += 1) pcm.writeInt16LE(Math.round(Math.sin((sample / RATE) * 2 * Math.PI * 440) * 3000), sample * 2);
        send({ type: "response.output_audio.delta", response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: pcm.toString("base64") });
        // OpenAI bills output audio at ~20 tokens per second.
        audioTokens += chunkMs / 50;
        if (index === 0) {
          words.forEach((word, position) =>
            send({ type: "response.output_audio_transcript.delta", response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: position === 0 ? word : ` ${word}` })
          );
        }
        await new Promise((resolve) => setTimeout(resolve, reply.chunkDelayMs ?? 10));
      }
      if (!current.cancelled) {
        send({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, transcript: reply.say });
        if (reply.handoff) {
          send({
            type: "response.function_call_arguments.done",
            response_id: responseId,
            item_id: id("item"),
            output_index: 1,
            call_id: id("call"),
            name: "ask_sibyl",
            arguments: JSON.stringify({ task: reply.handoff })
          });
        }
      }
      send({
        type: "response.done",
        response: {
          id: responseId,
          status: current.cancelled ? "cancelled" : "completed",
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            input_token_details: { text_tokens: 500, audio_tokens: 100, image_tokens: 0, cached_tokens: 300, cached_tokens_details: { text_tokens: 300, audio_tokens: 0, image_tokens: 0 } },
            output_token_details: { text_tokens: 20, audio_tokens: audioTokens }
          }
        }
      });
      if (active === current) active = undefined;
    };

    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown> & { type: string };
      if (event.type === "input_audio_buffer.append") {
        const audio = Buffer.from(String(event.audio), "base64");
        events.push({ type: event.type, bytes: audio.byteLength });
        appended += audio.byteLength;
        buffer.push(audio);
        // A toy "semantic" detector: 300 ms of silence after speech commits.
        const silent = audio.every((byte) => byte === 0);
        if (!silent) {
          heardSpeech = true;
          trailingSilenceBytes = 0;
        } else if (heardSpeech) {
          trailingSilenceBytes += audio.byteLength;
          const audioInput = ((session?.audio as Record<string, any> | undefined)?.input ?? {}) as Record<string, any>;
          if (audioInput.turn_detection?.type === "semantic_vad" && trailingSilenceBytes >= RATE * 2 * 0.3) commit();
        }
        return;
      }
      events.push(event);
      switch (event.type) {
        case "session.update":
          session = { ...(session ?? {}), ...(event.session as Record<string, unknown>) };
          send({ type: "session.updated", session });
          return;
        case "input_audio_buffer.commit":
          commit();
          return;
        case "input_audio_buffer.clear":
          buffer = [];
          send({ type: "input_audio_buffer.cleared" });
          return;
        case "conversation.item.create": {
          const item = event.item as Record<string, unknown>;
          if (item.type === "function_call_output") pendingOutput = String(item.output);
          send({ type: "conversation.item.added", item: { id: id("item"), ...item } });
          return;
        }
        case "response.create":
          void respond();
          return;
        case "response.cancel":
          if (active) active.cancelled = true;
          else send({ type: "error", error: { type: "invalid_request_error", code: "response_cancel_not_active", message: "no active response" } });
          return;
        default:
          return;
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/v1/realtime`,
    httpBase: `http://127.0.0.1:${port}/v1`,
    events,
    get sessions() {
      return sessions;
    },
    lastSession: () => session,
    appendedBytes: () => appended,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}
