/**
 * The realtime seam end to end, without a LiveKit server: a fake
 * @livekit/rtc-node stands in for the room. The room agent hears a person's
 * track, detects the turn with the shared speech detector, drives the SAME
 * gateway session the browser is connected to, and plays the reply into its
 * own audio track; the browser only gets transcripts, replies and
 * realtime.turn. Group calls keep unaddressed speech as notes.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { TokenVerifier } from "livekit-server-sdk";
import type { LLMProvider, STTProvider, TTSProvider } from "@open-gpt-live/adapters";
import { REALTIME_EVENTS, WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { createGatewayServer, type GatewayServerHandle } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import { RealtimeService } from "./service.js";
import type { RealtimeConfig } from "./config.js";

const catalog: ModelCatalog = {
  voice: [{ id: "voice/fast", label: "Fast voice" }],
  llm: [{ id: "brain/deep", label: "Deep" }],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [{ id: "tts/pcm", label: "PCM voice", voices: ["a"], format: "pcm", sampleRate: 24_000 }]
};

const config: RealtimeConfig = {
  url: "ws://livekit:7880",
  publicUrl: "ws://localhost:7880",
  apiUrl: "http://livekit:7880",
  apiKey: "devkey",
  apiSecret: "secret-secret-secret-secret-secret",
  tokenTtlSeconds: 600
};

/* ── a fake @livekit/rtc-node (only what the room agent uses) ── */

let clock = 0;
const rooms: FakeRoom[] = [];

class FakeTrack {
  kind = 1;
  readonly frames: Int16Array[] = [];
  waiting: (() => void) | undefined;
  push(frames: Int16Array[]) {
    this.frames.push(...frames);
    this.waiting?.();
  }
}

class FakeRoom extends EventEmitter {
  remoteParticipants = new Map<string, unknown>();
  token = "";
  sent: Array<{ text: string; attributes: Record<string, string> }> = [];
  published = 0;
  localParticipant = {
    publishTrack: async () => {
      this.published += 1;
      return {};
    },
    sendText: async (text: string, options: { attributes: Record<string, string> }) => {
      this.sent.push({ text, attributes: options.attributes });
      return {};
    }
  };
  constructor() {
    super();
    rooms.push(this);
  }
  async connect(_url: string, token: string) {
    this.token = token;
  }
  async disconnect() {}
  join(identity: string, name: string): FakeTrack {
    const track = new FakeTrack();
    const participant = { identity, name, kind: 0, trackPublications: new Map() };
    this.remoteParticipants.set(identity, participant);
    this.emit("participantConnected", participant);
    this.emit("trackSubscribed", track, {}, participant);
    return track;
  }
}

const captured: Int16Array[] = [];
class FakeAudioSource {
  constructor(readonly sampleRate: number) {}
  async captureFrame(frame: { data: Int16Array }) {
    captured.push(frame.data);
  }
  clearQueue() {}
  async waitForPlayout() {}
  async close() {}
}

class FakeAudioStream {
  constructor(private readonly track: FakeTrack) {}
  getReader() {
    const track = this.track;
    let cancelled = false;
    return {
      read: async (): Promise<{ value?: { data: Int16Array }; done: boolean }> => {
        while (!cancelled && track.frames.length === 0) await new Promise<void>((resolve) => (track.waiting = resolve));
        if (cancelled) return { done: true };
        clock += 20;
        // Real time passes for the session too (merging, timers), but slowly enough to keep the test short.
        await new Promise((resolve) => setImmediate(resolve));
        return { value: { data: track.frames.shift()! }, done: false };
      },
      cancel: async () => {
        cancelled = true;
        track.waiting?.();
      }
    };
  }
}

const fakeRtc = {
  Room: FakeRoom,
  AudioSource: FakeAudioSource,
  AudioStream: FakeAudioStream,
  AudioFrame: class {
    constructor(readonly data: Int16Array) {}
  },
  LocalAudioTrack: { createAudioTrack: () => ({}) },
  TrackPublishOptions: class {
    constructor(readonly options: unknown) {}
  },
  TrackSource: { SOURCE_MICROPHONE: 2 },
  TrackKind: { KIND_AUDIO: 1 },
  ParticipantKind: { EGRESS: 2 },
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    Disconnected: "disconnected"
  }
};

/* ── audio: room noise, then a voice, then silence (20 ms frames at 24 kHz) ── */

function frames(seconds: number, amplitude: number): Int16Array[] {
  return Array.from({ length: Math.round(seconds * 50) }, () =>
    new Int16Array(480).map((_, index) => Math.round(Math.sin(index / 3) * amplitude + (Math.random() - 0.5) * 40))
  );
}
const utterance = () => [...frames(0.6, 0), ...frames(1, 9_000), ...frames(1, 0)];

/* ── gateway with fake model providers ── */

let gateway: GatewayServerHandle | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  rooms.length = 0;
  captured.length = 0;
});

async function start(transcripts: string[]) {
  clock = 0;
  const runtime = createTestRuntime();
  const realtime = new RealtimeService({
    config,
    store: runtime.store,
    ownerId: runtime.ownerId,
    log: () => undefined,
    loadRtc: async () => fakeRtc as never,
    now: () => clock
  });
  runtime.realtime = realtime;
  const llm: LLMProvider = {
    async *streamText() {
      yield { delta: "[warmly] Two plus two is four." };
    }
  };
  const stt: STTProvider = { transcribe: async () => ({ text: transcripts.shift() ?? "" }) };
  const tts: TTSProvider = {
    async *synthesize() {
      yield { audio: new Uint8Array(new Int16Array(4_800).fill(3_000).buffer), mimeType: "audio/pcm", format: "pcm" };
    }
  };
  gateway = await createGatewayServer({
    providers: { llm, stt, tts },
    host: "127.0.0.1",
    modelCatalog: catalog,
    live: { voicePrompt: "VOICE", brainPrompt: () => "BRAIN" },
    ttsSegmentMinLength: 1,
    runtime
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise((resolve) => socket.once("open", resolve));
  const waitFor = async <T extends ServerMessage>(match: (message: ServerMessage) => boolean, ms = 4_000): Promise<T> => {
    const until = Date.now() + ms;
    for (;;) {
      const found = messages.find(match);
      if (found) return found as T;
      if (Date.now() > until) throw new Error(`timeout; got ${messages.map((m) => m.type).join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { socket, messages, waitFor, realtime, runtime, send: (message: unknown) => socket.send(JSON.stringify(message)) };
}

describe("realtime layer over the gateway session", () => {
  test("advertised in session.config; join returns a scoped token; a spoken turn is answered in the room", async () => {
    const client = await start(["What is two plus two?"]);
    const configMessage = await client.waitFor<Extract<ServerMessage, { type: "session.config" }>>((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    expect(configMessage.capabilities.realtime).toEqual({ url: "ws://localhost:7880", phone: false });

    client.send({ type: REALTIME_EVENTS.JOIN });
    const joined = await client.waitFor<Extract<ServerMessage, { type: "realtime.joined" }>>((m) => m.type === REALTIME_EVENTS.JOINED);
    expect(joined).toMatchObject({ url: "ws://localhost:7880", identity: "user:owner", kind: "voice" });
    expect(joined.room).toMatch(/^sibyl\.voice\.default\./);
    const grant = await new TokenVerifier(config.apiKey, config.apiSecret).verify(joined.token);
    expect(grant.video?.room).toBe(joined.room);

    // Sibyl joined as agent:sibyl and published her voice.
    const room = rooms[0]!;
    expect((await new TokenVerifier(config.apiKey, config.apiSecret).verify(room.token)).sub).toBe("agent:sibyl");
    expect(room.published).toBe(1);

    room.join("user:owner", "Owner").push(utterance());
    const started = await client.waitFor<Extract<ServerMessage, { type: "realtime.turn" }>>((m) => m.type === REALTIME_EVENTS.TURN && m.phase === "start");
    expect(started.speaker).toBe("user:owner");
    await client.waitFor((m) => m.type === REALTIME_EVENTS.TURN && m.phase === "end");
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END);
    // The voice went into the room, not over the socket.
    expect(client.messages.some((m) => m.type === WS_EVENTS.TTS_START)).toBe(true);
    expect(client.messages.some((m) => m.type === WS_EVENTS.TTS_CHUNK)).toBe(false);
    for (let i = 0; i < 50 && captured.length < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captured.length).toBe(10);
    expect(captured[0]![0]).toBe(3_000);
    // Captions: the person's words and Sibyl's spoken reply (cue removed).
    await client.waitFor((m) => m.type === WS_EVENTS.TRANSCRIPT_UPDATE);
    for (let i = 0; i < 50 && room.sent.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(room.sent.map((caption) => [caption.attributes["sibyl.speaker"], caption.text])).toEqual(
      expect.arrayContaining([
        ["user:owner", "What is two plus two?"],
        ["agent:sibyl", "Two plus two is four."]
      ])
    );
    client.socket.close();
  });

  test("group call: unaddressed speech becomes a note; addressing Sibyl by name gets an answer", async () => {
    const client = await start(["Let's look at the quarter.", "Sibyl, what were the sales?"]);
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    client.send({ type: REALTIME_EVENTS.JOIN, callId: "call-123456" });
    const joined = await client.waitFor<Extract<ServerMessage, { type: "realtime.joined" }>>((m) => m.type === REALTIME_EVENTS.JOINED);
    expect(joined).toMatchObject({ kind: "call", callId: "call-123456", room: "sibyl.call.default.call-123456" });
    const room = rooms[0]!;
    const host = room.join("user:owner", "Owner");
    room.join("user:bob", "Bob").push(utterance());
    // Not addressed: kept as a note, nobody answers.
    for (let i = 0; i < 200; i += 1) {
      const stored = await client.runtime.store.conversations.list(client.runtime.ownerId);
      if (stored.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [conversation] = await client.runtime.store.conversations.list(client.runtime.ownerId);
    const record = await client.runtime.store.conversations.get(client.runtime.ownerId, conversation!.id);
    expect(record?.messages.map((message) => message.content)).toEqual(["[Bob] Let's look at the quarter."]);
    expect(client.messages.some((m) => m.type === REALTIME_EVENTS.TURN)).toBe(false);

    host.push(utterance());
    const started = await client.waitFor<Extract<ServerMessage, { type: "realtime.turn" }>>((m) => m.type === REALTIME_EVENTS.TURN && m.phase === "start");
    expect(started.speaker).toBe("user:owner");
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END);

    // Only the host's session brings Sibyl into this call.
    expect((await client.realtime.call("call-123456"))?.host).toBe("local:owner");
    client.socket.close();
  });

  test("without LiveKit configured nothing is advertised and realtime.join is refused", async () => {
    gateway = await createGatewayServer({
      providers: { llm: { async *streamText() {} }, stt: { transcribe: async () => ({ text: "" }) } },
      host: "127.0.0.1",
      modelCatalog: catalog
    });
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: REALTIME_EVENTS.JOIN }));
    for (let i = 0; i < 100 && !messages.some((m) => m.type === "error"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const sessionConfig = messages.find((m) => m.type === WS_EVENTS.SESSION_CONFIG) as Extract<ServerMessage, { type: "session.config" }>;
    expect(sessionConfig.capabilities.realtime).toBeUndefined();
    expect(messages.find((m) => m.type === "error")).toMatchObject({ message: "realtime.join is not available on this gateway yet" });
    socket.close();
  });
});
