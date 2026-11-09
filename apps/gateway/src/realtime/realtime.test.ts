import { describe, expect, test } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";
import { PERMISSIONS } from "@open-gpt-live/core";
import { REALTIME_EVENTS, parseClientMessage, parseServerMessage } from "@open-gpt-live/protocol";
import { protectedRoutePermission } from "../identity/http.js";
import { decodeWav, resample, rmsOf, SpeechDecoder } from "./audio.js";
import { realtimeConfigFromEnv, type RealtimeConfig } from "./config.js";
import { addressedCandidate, decide, FOLLOW_UP_WINDOW_MS } from "./floor.js";
import { spokenText } from "./room-agent.js";
import { isAgentIdentity, parseRoomName, roomName, roomPrefix, userIdentity } from "./rooms.js";
import { issueToken } from "./token.js";

const config: RealtimeConfig = {
  url: "ws://livekit:7880",
  publicUrl: "ws://localhost:7880",
  apiUrl: "http://livekit:7880",
  apiKey: "devkey",
  apiSecret: "secret-secret-secret-secret-secret",
  tokenTtlSeconds: 600
};

function wav(samples: Int16Array, rate = 24_000): Uint8Array {
  const buffer = Buffer.alloc(44 + samples.byteLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.byteLength, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.byteLength, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buffer, 44);
  return new Uint8Array(buffer);
}

describe("config", () => {
  test("off unless all three LIVEKIT_* are set", () => {
    expect(realtimeConfigFromEnv({})).toEqual({});
    expect(realtimeConfigFromEnv({ LIVEKIT_URL: "ws://x:7880" }).problem).toMatch(/must all be set/);
    expect(realtimeConfigFromEnv({ LIVEKIT_URL: "http://x", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }).problem).toMatch(/ws:\/\//);
    const { config: on } = realtimeConfigFromEnv({
      LIVEKIT_URL: "wss://lk.example.com",
      LIVEKIT_API_KEY: "k",
      LIVEKIT_API_SECRET: "s",
      LIVEKIT_SIP_OUTBOUND_TRUNK_ID: "ST_1"
    });
    expect(on).toMatchObject({ url: "wss://lk.example.com", publicUrl: "wss://lk.example.com", apiUrl: "https://lk.example.com", sipOutboundTrunkId: "ST_1" });
  });
});

describe("rooms", () => {
  test("names are scoped to a workspace and round-trip", () => {
    const name = roomName("voice", "default", "conv-1");
    expect(name).toBe("sibyl.voice.default.conv-1");
    expect(parseRoomName(name)).toEqual({ kind: "voice", workspaceId: "default", id: "conv-1" });
    // Inbound SIP rooms get the dispatch rule's suffix appended.
    expect(parseRoomName(`${roomPrefix("phone", "ws1")}+15551234567_x9`)).toEqual({ kind: "phone", workspaceId: "ws1", id: "+15551234567_x9" });
    expect(parseRoomName("sibyl.other.ws.x")).toBeUndefined();
    expect(parseRoomName("random-room")).toBeUndefined();
    expect(() => roomName("call", "ws.with.dots", "x")).toThrow();
    expect(() => roomName("call", "ws", "../x")).toThrow();
  });

  test("identities", () => {
    expect(userIdentity("u1")).toBe("user:u1");
    expect(userIdentity(undefined)).toBe("user:owner");
    expect(isAgentIdentity("agent:sibyl")).toBe(true);
    expect(isAgentIdentity("user:agent")).toBe(false);
  });
});

describe("tokens", () => {
  test("people may join, listen, speak and send data; never administer or record", async () => {
    const jwt = await issueToken(config, { room: "sibyl.voice.default.c1", identity: "user:u1", name: "Ada" });
    const claims = await new TokenVerifier(config.apiKey, config.apiSecret).verify(jwt);
    expect(claims.sub).toBe("user:u1");
    expect(claims.name).toBe("Ada");
    expect(claims.video).toMatchObject({ room: "sibyl.voice.default.c1", roomJoin: true, canSubscribe: true, canPublishData: true, canPublishSources: ["microphone"], canUpdateOwnMetadata: false });
    expect(claims.video?.roomAdmin).toBeUndefined();
    expect(claims.video?.roomRecord).toBeUndefined();
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(600);
  });
});

describe("floor (group calls)", () => {
  const candidates = [
    { id: "sibyl", name: "Sibyl" },
    { id: "agent-1", name: "Nova" },
    { id: "agent-2", name: "Market Analyst" }
  ];

  test("addressed by name at the start, the end, or with @", () => {
    expect(addressedCandidate("Sibyl, what's on my calendar?", candidates)?.id).toBe("sibyl");
    expect(addressedCandidate("hey nova can you check that", candidates)?.id).toBe("agent-1");
    expect(addressedCandidate("What do you think, Market Analyst?", candidates)?.id).toBe("agent-2");
    expect(addressedCandidate("so I think @nova should look at the numbers from last week first", candidates)?.id).toBe("agent-1");
    // Mentioned in passing in the middle of a long sentence: not addressed.
    expect(addressedCandidate("yesterday I told our team that Sibyl was great at summarising long documents for us", candidates)).toBeUndefined();
    expect(addressedCandidate("the market looks fine", candidates)).toBeUndefined();
    // Speech-to-text spells names its own way.
    expect(addressedCandidate("Hi, Sybil. What is 2+2?", candidates)?.id).toBe("sibyl");
    expect(addressedCandidate("Cybil can you help", candidates)?.id).toBe("sibyl");
    expect(addressedCandidate("Sibel, one more thing", candidates)?.id).toBe("sibyl");
    expect(addressedCandidate("civil rights are on the agenda", candidates)).toBeUndefined();
  });

  test("the floor holder answers; a quick follow-up from the same person goes to the same agent", () => {
    const base = { candidates, now: 10_000 };
    expect(decide({ ...base, text: "what about tomorrow", speaker: "user:a", state: {} })).toBeUndefined();
    expect(decide({ ...base, text: "what about tomorrow", speaker: "user:a", state: { holder: "agent-1" } })).toBe("agent-1");
    const lastReply = { speaker: "user:a", agent: "agent-2", at: 10_000 - FOLLOW_UP_WINDOW_MS + 1 };
    expect(decide({ ...base, text: "and the week after", speaker: "user:a", state: { lastReply } })).toBe("agent-2");
    expect(decide({ ...base, text: "and the week after", speaker: "user:b", state: { lastReply } })).toBeUndefined();
    expect(decide({ ...base, text: "and the week after", speaker: "user:a", state: { lastReply: { ...lastReply, at: 0 } } })).toBeUndefined();
    // A name beats the floor.
    expect(decide({ ...base, text: "Sibyl, your turn", speaker: "user:a", state: { holder: "agent-1" } })).toBe("sibyl");
  });
});

describe("audio", () => {
  test("WAV and raw PCM decode to 16-bit mono; RMS on a 0–1 scale", async () => {
    const tone = new Int16Array(2400).map((_, index) => Math.round(Math.sin(index / 5) * 16_000));
    const decoded = decodeWav(wav(tone, 16_000));
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.samples).toEqual(tone);
    expect(rmsOf(tone)).toBeGreaterThan(0.3);
    expect(rmsOf(new Int16Array(480))).toBe(0);
    expect(resample(decoded, 24_000).length).toBe(3600);
    const raw = await new SpeechDecoder().decode(new Uint8Array(tone.buffer), "audio/pcm;rate=24000");
    expect(raw).toMatchObject({ sampleRate: 24_000 });
    expect(raw.samples.length).toBe(2400);
    await expect(new SpeechDecoder().decode(new Uint8Array(4), "audio/ogg")).rejects.toThrow(/unsupported/);
  });

  test("captions keep only what was spoken", () => {
    expect(spokenText("[warmly] Sure, let me check.\n@brain Look up the weather in Paris")).toBe("Sure, let me check.");
    expect(spokenText("@silence")).toBe("");
  });
});

describe("protocol and permissions", () => {
  test("realtime messages are validated", () => {
    expect(parseClientMessage({ type: REALTIME_EVENTS.JOIN })).toEqual({ success: true, data: { type: "realtime.join" } });
    expect(parseClientMessage({ type: REALTIME_EVENTS.JOIN, callId: "abc123def" }).success).toBe(true);
    expect(parseClientMessage({ type: REALTIME_EVENTS.JOIN, callId: "../../x" }).success).toBe(false);
    expect(parseClientMessage({ type: REALTIME_EVENTS.FLOOR, holder: null }).success).toBe(true);
    expect(parseClientMessage({ type: REALTIME_EVENTS.FLOOR, holder: "sibyl" }).success).toBe(true);
    expect(parseClientMessage({ type: REALTIME_EVENTS.FLOOR, holder: 5 }).success).toBe(false);
    expect(parseServerMessage({ type: REALTIME_EVENTS.TURN, requestId: "r", phase: "start", speaker: "user:a" }).success).toBe(true);
    expect(parseServerMessage({ type: REALTIME_EVENTS.TURN, requestId: "r", phase: "loud", speaker: "user:a" }).success).toBe(false);
  });

  test("HTTP routes need the right permission", () => {
    expect(protectedRoutePermission("POST", "/api/realtime/token")).toEqual({ permission: PERMISSIONS.CHAT_USE });
    expect(protectedRoutePermission("GET", "/api/realtime/streams")).toEqual({ permission: PERMISSIONS.CHAT_USE });
    expect(protectedRoutePermission("POST", "/api/realtime/streams")).toEqual({ permission: PERMISSIONS.TOOLS_WRITE });
    expect(protectedRoutePermission("PUT", "/api/realtime/phone")).toEqual({ permission: PERMISSIONS.ORG_SETTINGS });
    expect(protectedRoutePermission("POST", "/api/realtime/webhook")).toBeUndefined();
    expect(protectedRoutePermission("GET", "/api/recordings")).toEqual({ permission: PERMISSIONS.CALLS_RECORD });
  });
});
