/**
 * The phone line: setup (SIP providers and LiveKit numbers), the trunk
 * password in the vault, business hours and voicemail, the call log, who may
 * call out, and the route gate. LiveKit itself is faked here; docs/realtime.md
 * ("Verified") lists what was run against a real LiveKit + SIP stack.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createMemoryStore, type Principal } from "@open-gpt-live/core";
import type { WebhookEvent } from "livekit-server-sdk";
import { protectedRoutePermission } from "../identity/http.js";
import { SecretVault } from "../secrets/vault.js";
import type { VoiceSessionPort } from "../session-port.js";
import type { RealtimeConfig } from "./config.js";
import { isLiveKitCloud } from "./livekit-numbers.js";
import { PHONE_SECRET, PhoneLine, isOpen, type PhoneLineDeps } from "./phone.js";
import type { RoomPresent, RoomSegment } from "./room-agent.js";

const config: RealtimeConfig = { url: "ws://livekit:7880", publicUrl: "ws://localhost:7880", apiUrl: "http://livekit:7880", apiKey: "k", apiSecret: "s".repeat(32), tokenTtlSeconds: 600 };
const cloud: RealtimeConfig = { ...config, url: "wss://acme-x1.livekit.cloud", publicUrl: "wss://acme-x1.livekit.cloud", apiUrl: "https://acme-x1.livekit.cloud" };
const admin: Principal = { kind: "user", orgId: "owner", userId: "ann", name: "Ann", orgRole: "admin", workspaceRoles: { default: "admin" } };
const member: Principal = { kind: "user", orgId: "owner", userId: "bob", name: "Bob", workspaceRoles: { default: "member" } };

function fakeSip() {
  const calls: string[] = [];
  let n = 0;
  const trunks = new Map<string, { address?: string; numbers: string[]; authUsername?: string; authPassword?: string }>();
  const rules = new Set<string>();
  return {
    calls,
    trunks,
    sip: {
      createSipOutboundTrunk: async (_name: string, address: string, numbers: string[], options: { authUsername?: string; authPassword?: string }) => {
        const id = `ST_out${++n}`;
        trunks.set(id, { address, numbers, ...(options.authUsername ? { authUsername: options.authUsername, authPassword: options.authPassword } : {}) });
        calls.push(`outbound ${address} ${numbers.join(",")} ${options.authPassword ?? "-"}`);
        return { sipTrunkId: id };
      },
      createSipInboundTrunk: async (_name: string, numbers: string[]) => {
        const id = `ST_in${++n}`;
        trunks.set(id, { numbers });
        calls.push(`inbound ${numbers.join(",")}`);
        return { sipTrunkId: id };
      },
      createSipDispatchRule: async (rule: { roomPrefix: string }, options: { trunkIds?: string[] }) => {
        const id = `SDR_${++n}`;
        rules.add(id);
        calls.push(`rule ${rule.roomPrefix} ${(options.trunkIds ?? []).join(",") || "any"}`);
        return { sipDispatchRuleId: id };
      },
      deleteSipDispatchRule: async (id: string) => void (rules.delete(id), calls.push(`delete ${id}`)),
      deleteSipTrunk: async (id: string) => void (trunks.delete(id), calls.push(`delete ${id}`)),
      listSipInboundTrunk: async (options?: { trunkIds?: string[] }) => (options?.trunkIds ?? []).map((id) => trunks.get(id)).filter(Boolean),
      listSipOutboundTrunk: async (options?: { trunkIds?: string[] }) => (options?.trunkIds ?? []).map((id) => trunks.get(id)).filter(Boolean),
      listSipDispatchRule: async (options?: { dispatchRuleIds?: string[] }) => (options?.dispatchRuleIds ?? []).filter((id) => rules.has(id)).map((id) => ({ sipDispatchRuleId: id })),
      createSipParticipant: async () => ({})
    }
  };
}

function fakeSession(conversationId: string) {
  const said: string[] = [];
  const notes: string[] = [];
  const session = {
    conversationId,
    deliver: () => undefined,
    addNote: (_speaker: string, text: string) => void notes.push(text),
    say: (text: string) => void said.push(text),
    close: () => undefined
  } as unknown as VoiceSessionPort;
  return { session, said, notes };
}

function setup(options: { config?: RealtimeConfig; vault?: boolean; now?: () => number } = {}) {
  const store = createMemoryStore();
  const lk = fakeSip();
  const vault = options.vault === false ? undefined : new SecretVault({ store, key: randomBytes(32) });
  const sessions: Array<ReturnType<typeof fakeSession>> = [];
  const agents: Array<{ mode: string; onStop?: (reason: string, present: RoomPresent[]) => void; onUtterance?: (segment: RoomSegment) => void }> = [];
  const notices: Array<{ title: string; body: string }> = [];
  const numbers = {
    owned: [{ id: "PN_1", number: "+14155550100", status: "active" as const, dispatchRuleIds: [] as string[] }],
    list: async () => numbers.owned,
    search: async () => [{ number: "+14155550199", locality: "San Francisco" }],
    purchase: async (number: string) => ({ id: "PN_2", number, status: "active" as const, dispatchRuleIds: [] }),
    get: async (number: string) => numbers.owned.find((item) => item.number === number),
    route: async (number: string, rule: string) => {
      const found = numbers.owned.find((item) => item.number === number)!;
      found.dispatchRuleIds = rule ? [rule] : [];
      return found;
    }
  };
  const deps: PhoneLineDeps = {
    config: options.config ?? config,
    store,
    ownerId: "owner",
    api: () => ({ rooms: { listRooms: async () => [] } as never, sip: lk.sip as never }),
    prefixFor: (workspaceId) => `sibyl.phone.${workspaceId}.`,
    roomFor: (workspaceId, id) => `sibyl.phone.${workspaceId}.${id}`,
    headless: () => {
      const made = fakeSession(`conv${sessions.length + 1}`);
      sessions.push(made);
      return made.session;
    },
    startAgent: async (input) => {
      agents.push({ mode: input.mode, ...(input.onStop ? { onStop: input.onStop } : {}), ...(input.onUtterance ? { onUtterance: input.onUtterance } : {}) });
      return { stop: async (reason: string) => input.onStop?.(reason, []) } as never;
    },
    candidates: async () => [{ id: "sibyl", name: "Sibyl" }, { id: "nova", name: "Nova" }],
    ...(vault ? { vault: () => vault } : {}),
    notify: (input) => void notices.push(input),
    log: () => undefined,
    ...(options.now ? { now: options.now } : {}),
    numbers,
    resolveHost: async (host) => (host.endsWith(".invalid") ? Promise.reject(new Error("ENOTFOUND")) : "203.0.113.5")
  };
  return { line: new PhoneLine(deps), store, lk, vault, sessions, agents, notices, numbers };
}

const twilio = { provider: "twilio" as const, numbers: ["+15551234567"], address: "acme.pstn.twilio.com", username: "sibyl", password: "trunk-pass-123" };

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("phone line setup", () => {
  test("a SIP trunk: trunks and routing in LiveKit, the password in the vault and never shown", async () => {
    const t = setup();
    const view = await t.line.save(twilio, "default");
    expect(view).toMatchObject({ provider: "twilio", numbers: ["+15551234567"], hasPassword: true, canCallOut: true, outbound: "admin", afterHours: "voicemail" });
    expect(t.lk.calls).toEqual(["outbound acme.pstn.twilio.com +15551234567 trunk-pass-123", "inbound +15551234567", "rule sibyl.phone.default. ST_in2"]);
    expect(JSON.stringify(view)).not.toContain("trunk-pass-123");
    expect(JSON.stringify(await t.store.kv.get("owner", "realtime.phone"))).not.toContain("trunk-pass-123");
    // The vault releases it only for the provider's host.
    expect(await t.vault!.resolve("owner", PHONE_SECRET, { host: "acme.pstn.twilio.com" })).toBe("trunk-pass-123");
    await expect(t.vault!.resolve("owner", PHONE_SECRET, { host: "evil.example.com" })).rejects.toThrow();

    // Changing only the greeting keeps the trunks.
    t.lk.calls.length = 0;
    await t.line.save({ ...twilio, password: undefined, greeting: "Hi, Acme here." } as never, "default");
    expect(t.lk.calls).toEqual([]);
    // A new number rebuilds them with the stored password.
    await t.line.save({ ...twilio, password: undefined, numbers: ["+15551234567", "+15557654321"] } as never, "default");
    expect(t.lk.calls).toContain("outbound acme.pstn.twilio.com +15551234567,+15557654321 trunk-pass-123");

    await t.line.remove();
    expect(await t.line.view()).toBeNull();
    expect(await t.vault!.has("owner", PHONE_SECRET)).toBe(false);
  });

  test("bad input is refused in plain words", async () => {
    const t = setup();
    await expect(t.line.save({ ...twilio, numbers: ["555-1234"] }, "default")).rejects.toThrow(/E\.164/);
    await expect(t.line.save({ ...twilio, address: "not a host!" }, "default")).rejects.toThrow(/SIP address/);
    await expect(t.line.save({ ...twilio, password: undefined } as never, "default")).rejects.toThrow(/password/);
    await expect(t.line.save({ ...twilio, hours: { timeZone: "Mars/Olympus", days: [1], open: "09:00", close: "17:00" } }, "default")).rejects.toThrow(/time zone/);
    // LiveKit numbers need LiveKit Cloud.
    await expect(t.line.save({ provider: "livekit", numbers: ["+14155550100"] }, "default")).rejects.toThrow(/LiveKit Cloud/);
  });

  test("a LiveKit Cloud number: our dispatch rule, the number routed to it, no trunks; inbound only", async () => {
    const t = setup({ config: cloud });
    expect(isLiveKitCloud(cloud)).toBe(true);
    expect(isLiveKitCloud(config)).toBe(false);
    await expect(t.line.save({ provider: "livekit", numbers: ["+14155550111"] }, "default")).rejects.toThrow(/isn't one of this LiveKit project's numbers/);
    const view = await t.line.save({ provider: "livekit", numbers: ["+14155550100"] }, "default");
    expect(view).toMatchObject({ provider: "livekit", canCallOut: false, hasPassword: false });
    expect(t.lk.calls).toEqual(["rule sibyl.phone.default. any"]);
    expect(t.numbers.owned[0]!.dispatchRuleIds).toHaveLength(1);
    const listed = await t.line.liveKitNumbers("415");
    expect(listed.owned[0]).toMatchObject({ number: "+14155550100", routed: true });
    expect(listed.available[0]).toMatchObject({ number: "+14155550199" });
    const test = await t.line.test();
    expect(test.steps.find((step) => step.id === "numbers")).toMatchObject({ status: "ok" });
    await expect(t.line.placeCall({ principal: admin, workspaceId: "default", to: "+15550001111", purpose: "Hi" })).rejects.toThrow(/incoming calls only/);
  });

  test("the test checks LiveKit, SIP, the provider's address, trunks and routing", async () => {
    const t = setup();
    expect((await t.line.test()).steps.map((step) => [step.id, step.status])).toEqual([
      ["livekit", "ok"],
      ["sip", "ok"],
      ["trunks", "skipped"]
    ]);
    await t.line.save(twilio, "default");
    const ok = await t.line.test();
    expect(ok.ok).toBe(true);
    expect(ok.steps.map((step) => step.id)).toEqual(["livekit", "sip", "provider", "trunks", "dispatch", "hours"]);
    t.lk.trunks.clear();
    const broken = await t.line.test();
    expect(broken.ok).toBe(false);
    expect(broken.steps.find((step) => step.id === "trunks")).toMatchObject({ status: "failed" });
  });
});

describe("business hours, voicemail and the call log", () => {
  test("open hours, closing after midnight, and the time zone", () => {
    const hours = { timeZone: "America/New_York", days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00" };
    // Monday 2026-11-09 10:00 in New York = 15:00 UTC.
    expect(isOpen(hours, Date.parse("2026-11-09T15:00:00Z"))).toBe(true);
    expect(isOpen(hours, Date.parse("2026-11-09T23:00:00Z"))).toBe(false);
    // Sunday.
    expect(isOpen(hours, Date.parse("2026-11-08T15:00:00Z"))).toBe(false);
    const night = { timeZone: "UTC", days: [5], open: "22:00", close: "06:00" };
    expect(isOpen(night, Date.parse("2026-11-13T23:00:00Z"))).toBe(true); // Friday night
    expect(isOpen(night, Date.parse("2026-11-14T03:00:00Z"))).toBe(true); // early Saturday, Friday's shift
    expect(isOpen(night, Date.parse("2026-11-15T03:00:00Z"))).toBe(false);
    expect(isOpen(undefined, 0)).toBe(true);
  });

  test("after hours a caller leaves a message: it lands in the Inbox and the call log", async () => {
    let now = Date.parse("2026-11-08T15:00:00Z"); // a Sunday
    const t = setup({ now: () => now });
    await t.line.save({ ...twilio, hours: { timeZone: "UTC", days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00" }, voicemailGreeting: "We're closed, leave a message." }, "default");
    const event = { participant: { attributes: { "sip.phoneNumber": "+15559876543", "sip.trunkPhoneNumber": "+15551234567" } } } as unknown as WebhookEvent;
    await t.line.answer("sibyl.phone.default._+15551234567_abc", event, (ws) => ws === "default");
    expect(t.agents[0]!.mode).toBe("voicemail");
    expect(t.sessions[0]!.said).toEqual(["We're closed, leave a message."]);
    t.agents[0]!.onUtterance!({ speaker: "phone:x", speakerName: "Phone", kind: "person", text: "Hi, it's Carol, please call me back.", startedAt: now, endedAt: now + 2_000 });
    now += 20_000;
    t.agents[0]!.onStop!("room empty", []);
    await settle();
    expect(t.notices).toEqual([{ kind: "voicemail", workspaceId: "default", title: "Voicemail from +15559876543", body: "Hi, it's Carol, please call me back.", links: { conversationId: "conv1" } }]);
    const [call] = await t.line.log({ workspaceId: "default" });
    expect(call).toMatchObject({ direction: "inbound", status: "voicemail", remoteNumber: "+15559876543", lineNumber: "+15551234567", voicemail: "Hi, it's Carol, please call me back.", durationMs: 20_000, conversationId: "conv1" });
  });

  test("open hours: the line's agent answers with the greeting; other organizations' rooms are ignored", async () => {
    const t = setup({ now: () => Date.parse("2026-11-09T10:00:00Z") });
    await t.line.save({ ...twilio, agentId: "nova", greeting: "Nova speaking." }, "default");
    await t.line.answer("sibyl.phone.other._x", { participant: { attributes: {} } } as unknown as WebhookEvent, (ws) => ws === "other-org");
    expect(t.agents).toHaveLength(0);
    await t.line.answer("sibyl.phone.default._x", { participant: { attributes: {} } } as unknown as WebhookEvent, (ws) => ws === "default");
    expect(t.agents[0]!.mode).toBe("conversation");
    expect(t.sessions[0]!.said).toEqual(["Nova speaking."]);
    const [call] = await t.line.log({ workspaceId: "default" });
    expect(call).toMatchObject({ agentId: "nova", agentName: "Nova", status: "active" });
  });

  test("who may call out: admins by default, members when allowed, nobody when off", async () => {
    const t = setup();
    await t.line.save(twilio, "default");
    expect(t.line.mayCallOut(admin, "default")).toBe(true);
    expect(t.line.mayCallOut(member, "default")).toBe(false);
    await expect(t.line.placeCall({ principal: member, workspaceId: "default", to: "+15550001111", purpose: "x" })).rejects.toThrow(/doesn't let you/);
    await t.line.save({ ...twilio, password: undefined, outbound: "member" } as never, "default");
    expect(t.line.mayCallOut(member, "default")).toBe(true);
    const placed = await t.line.placeCall({ principal: member, workspaceId: "default", to: "+15550001111", purpose: "Confirm Tuesday" });
    const [call] = await t.line.log({ workspaceId: "default", direction: "outbound" });
    expect(call).toMatchObject({ id: placed.callId, direction: "outbound", status: "ringing", remoteNumber: "+15550001111", lineNumber: "+15551234567" });
    await t.line.save({ ...twilio, password: undefined, outbound: "off" } as never, "default");
    expect(t.line.mayCallOut(admin, "default")).toBe(false);
  });

  test("routes: the line is org.settings, the call log chat.view_all", () => {
    expect(protectedRoutePermission("POST", "/api/realtime/phone/test")).toEqual({ permission: "org.settings" });
    expect(protectedRoutePermission("GET", "/api/realtime/phone/numbers")).toEqual({ permission: "org.settings" });
    expect(protectedRoutePermission("GET", "/api/realtime/calls")).toEqual({ permission: "chat.view_all" });
    expect(protectedRoutePermission("GET", "/api/realtime/calls/abc123")).toEqual({ permission: "chat.use" });
  });
});
