/**
 * The phone line (docs/realtime.md#phone-calls): one line per organization,
 * set up in Settings → Admin → Phone.
 *
 * Two ways to get a number:
 * - a LiveKit phone number (LiveKit Cloud only): rented from LiveKit and
 *   routed to Sibyl's dispatch rule; inbound calls only for now;
 * - a SIP trunk at a provider (Twilio, Telnyx, Plivo, Vonage, …): needed for
 *   self-hosted LiveKit and for calling out. The trunk password goes to
 *   LiveKit and into the vault (PHONE_SIP_PASSWORD, usable only for the
 *   provider's host), so the trunks can be rebuilt later; it is never shown.
 *
 * Inbound calls are answered by Sibyl or the line's agent with the greeting.
 * Outside business hours the line takes a message instead: the caller's words
 * are transcribed and land in the Inbox (a "voicemail" notification). Every
 * call, in or out, gets a call log entry (packages/core/src/calls.ts).
 */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { SIPTransport } from "@livekit/protocol";
import type { SipClient, RoomServiceClient, WebhookEvent } from "livekit-server-sdk";
import {
  effectiveWorkspaceRole,
  roleRank,
  type CallLogRecord,
  type CallRecorder,
  type Principal,
  type Store
} from "@open-gpt-live/core";
import { AGENT_EVENTS } from "@open-gpt-live/protocol";
import type {
  CallLogView,
  LiveKitNumberView,
  PhoneHoursView,
  PhoneLineInput,
  PhoneLineView,
  PhoneOutboundView,
  PhoneProviderPreset,
  PhoneProviderView,
  PhoneTestStep,
  PhoneTestView
} from "@open-gpt-live/protocol";
import type { SecretVault } from "../secrets/vault.js";
import type { VoiceSessionPort } from "../session-port.js";
import type { RealtimeConfig } from "./config.js";
import { LiveKitNumbers, isLiveKitCloud } from "./livekit-numbers.js";
import type { RoomAgent, RoomAgentMode, RoomPresent, RoomSegment, RoomVoiceProfile } from "./room-agent.js";

/** A message the person may see (bad input, not set up). */
export class PhoneError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const PHONE_PROVIDERS: readonly PhoneProviderPreset[] = [
  { id: "livekit", label: "LiveKit phone number", inbound: true, outbound: false, docs: "docs/realtime.md#a-livekit-phone-number-livekit-cloud" },
  { id: "twilio", label: "Twilio", addressHint: "your-trunk.pstn.twilio.com", inbound: true, outbound: true, docs: "docs/realtime.md#twilio-step-by-step" },
  { id: "telnyx", label: "Telnyx", addressHint: "sip.telnyx.com", inbound: true, outbound: true, docs: "docs/realtime.md#other-sip-providers" },
  { id: "plivo", label: "Plivo", addressHint: "your-id.zt.plivo.com", inbound: true, outbound: true, docs: "docs/realtime.md#other-sip-providers" },
  { id: "vonage", label: "Vonage", addressHint: "sip.nexmo.com", inbound: true, outbound: true, docs: "docs/realtime.md#other-sip-providers" },
  { id: "other", label: "Another SIP provider", addressHint: "sip.example.com", inbound: true, outbound: true, docs: "docs/realtime.md#other-sip-providers" }
];

const PROVIDERS = new Set<PhoneProviderView>(PHONE_PROVIDERS.map((preset) => preset.id));
const PHONE_KEY = "realtime.phone";
export const PHONE_SECRET = "PHONE_SIP_PASSWORD";
const E164 = /^\+[1-9]\d{6,14}$/;
const SIP_HOST = /^[A-Za-z0-9.-]{3,253}(:\d{1,5})?$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_NUMBERS = 10;
const DEFAULT_GREETING = "Hello, this is Sibyl. How can I help?";
const DEFAULT_VOICEMAIL = "Hello, you've reached us outside our opening hours. Please leave your name, number and message after this, and we'll get back to you.";
export const RECORDING_ANNOUNCEMENT = "This call is being recorded.";

/** What is stored (kv realtime.phone). Older lines had one `number` and provider "twilio" | "other". */
export interface PhoneLineRecord {
  provider: PhoneProviderView;
  numbers: string[];
  /** Older records: the single number. */
  number?: string;
  workspaceId: string;
  address?: string;
  username?: string;
  /** The trunk password is in the vault under PHONE_SECRET. */
  passwordStored?: boolean;
  agentId?: string;
  greeting?: string;
  hours?: PhoneHoursView;
  afterHours?: "voicemail" | "answer";
  voicemailGreeting?: string;
  outbound?: PhoneOutboundView;
  record?: boolean;
  outboundTrunkId?: string;
  inboundTrunkId?: string;
  dispatchRuleId?: string;
  updatedAt: number;
}

/** What the line needs from the realtime layer (service.ts). */
export interface PhoneLineDeps {
  config: RealtimeConfig;
  store: Store;
  ownerId: string;
  api(): { rooms: RoomServiceClient; sip: SipClient };
  prefixFor(workspaceId: string): string;
  roomFor(workspaceId: string, id: string): string;
  /** A session with no browser, never more than a viewer. */
  headless(principal: Principal, workspaceId: string): VoiceSessionPort;
  startAgent(input: {
    room: string;
    port: VoiceSessionPort;
    mode: RoomAgentMode;
    principal: Principal;
    workspaceId: string;
    idleTimeoutMs: number;
    emptyAfterLeaveMs?: number;
    onStop?: (reason: string, present: RoomPresent[]) => void;
    onUtterance?: (segment: RoomSegment) => void;
  }): Promise<RoomAgent>;
  candidates(principal: Principal, workspaceId: string): Promise<RoomVoiceProfile[]>;
  vault?: () => SecretVault | undefined;
  recorder?: () => CallRecorder | undefined;
  notify?: (input: { kind: "voicemail"; workspaceId: string; title: string; body: string; links: { conversationId?: string } }) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  /** Tests: the LiveKit numbers API and DNS. */
  numbers?: Pick<LiveKitNumbers, "search" | "purchase" | "list" | "get" | "route">;
  resolveHost?: (host: string) => Promise<string>;
}

interface ActiveCall {
  record: CallLogRecord;
  session: VoiceSessionPort;
  mode: RoomAgentMode;
  heard: string[];
}

export class PhoneLine {
  private cache: PhoneLineRecord | undefined;
  private readonly active = new Map<string, ActiveCall>();
  private readonly now: () => number;
  private numbersApi: Pick<LiveKitNumbers, "search" | "purchase" | "list" | "get" | "route"> | undefined;

  constructor(private readonly deps: PhoneLineDeps) {
    this.now = deps.now ?? Date.now;
  }

  get cloud(): boolean {
    return isLiveKitCloud(this.deps.config);
  }

  /** Outbound calls are possible (an outbound trunk from the app or LIVEKIT_SIP_OUTBOUND_TRUNK_ID). */
  get canCallOut(): boolean {
    return Boolean(this.deps.config.sipOutboundTrunkId || this.cache?.outboundTrunkId);
  }

  async settings(): Promise<PhoneLineRecord | undefined> {
    const stored = await this.deps.store.kv.get<PhoneLineRecord>(this.deps.ownerId, PHONE_KEY);
    this.cache = stored ? normalize(stored) : undefined;
    return this.cache;
  }

  async view(): Promise<PhoneLineView | null> {
    const line = await this.settings();
    return line ? this.toView(line) : null;
  }

  /* ───────────── set up ───────────── */

  async save(input: PhoneLineInput, workspaceId: string): Promise<PhoneLineView> {
    const provider = input.provider;
    if (!PROVIDERS.has(provider)) throw new PhoneError("Pick a provider.");
    const numbers = [...new Set((input.numbers ?? []).map((value) => String(value).replace(/[\s()-]/g, "")).filter(Boolean))];
    if (numbers.length === 0) throw new PhoneError("Add the line's phone number.");
    if (numbers.length > MAX_NUMBERS) throw new PhoneError(`A line has at most ${MAX_NUMBERS} numbers.`);
    const wrong = numbers.find((value) => !E164.test(value));
    if (wrong) throw new PhoneError(`${wrong} isn't in E.164 form, like +15551234567.`);
    const hours = input.hours === null || input.hours === undefined ? undefined : checkHours(input.hours);
    const current = await this.settings();
    const sip = provider !== "livekit";
    const address = sip ? input.address?.trim().toLowerCase() : undefined;
    const username = sip ? input.username?.trim() || undefined : undefined;
    if (sip && (!address || !SIP_HOST.test(address))) throw new PhoneError("Enter the provider's SIP address, a host name like example.pstn.twilio.com.");
    if (!sip && !this.cloud) throw new PhoneError("LiveKit phone numbers need LiveKit Cloud (LIVEKIT_URL at *.livekit.cloud). Self-hosted LiveKit uses a SIP provider instead.", 409);
    const password = input.password?.trim() || undefined;
    const vault = this.deps.vault?.();

    const trunkChanged =
      !current ||
      current.provider !== provider ||
      current.address !== address ||
      current.username !== username ||
      Boolean(password) ||
      current.numbers.join(",") !== numbers.join(",") ||
      current.workspaceId !== workspaceId ||
      (sip ? !current.outboundTrunkId || !current.inboundTrunkId : !current.dispatchRuleId);

    let stored = current?.passwordStored ?? false;
    if (sip && password) {
      if (vault) {
        await vault.set(this.deps.ownerId, {
          name: PHONE_SECRET,
          value: password,
          service: "Phone line (SIP trunk)",
          description: "The SIP trunk password of the phone line. Sent only to LiveKit for the provider's host.",
          allowedHosts: [hostOf(address!)]
        });
        stored = true;
      } else {
        // No vault (SIBYL_SECRET_KEY unset): LiveKit keeps it in the trunk; changing the trunk later needs it again.
        stored = false;
      }
    }
    if (!sip && current?.passwordStored && vault) {
      await vault.delete(this.deps.ownerId, PHONE_SECRET).catch(() => false);
      stored = false;
    }

    let trunks: Pick<PhoneLineRecord, "outboundTrunkId" | "inboundTrunkId" | "dispatchRuleId"> = {
      ...(current?.outboundTrunkId ? { outboundTrunkId: current.outboundTrunkId } : {}),
      ...(current?.inboundTrunkId ? { inboundTrunkId: current.inboundTrunkId } : {}),
      ...(current?.dispatchRuleId ? { dispatchRuleId: current.dispatchRuleId } : {})
    };
    if (trunkChanged) {
      let secret = password;
      if (sip && !secret && username && stored && vault) secret = await vault.resolve(this.deps.ownerId, PHONE_SECRET, { host: hostOf(address!) }).catch(() => undefined);
      if (sip && username && !secret) throw new PhoneError("Enter the trunk password (it is stored in the vault and never shown again).");
      if (current) await this.teardown(current, { keepSecret: true });
      trunks = sip
        ? await this.createTrunks({ address: address!, numbers, workspaceId, ...(username && secret ? { username, password: secret } : {}) })
        : await this.routeNumbers(numbers, workspaceId);
    }
    const record: PhoneLineRecord = {
      provider,
      numbers,
      workspaceId,
      ...(address ? { address } : {}),
      ...(username ? { username } : {}),
      ...(stored ? { passwordStored: true } : {}),
      ...(input.agentId ? { agentId: String(input.agentId) } : {}),
      ...(input.greeting?.trim() ? { greeting: input.greeting.trim().slice(0, 300) } : {}),
      ...(hours ? { hours } : {}),
      afterHours: input.afterHours === "answer" ? "answer" : "voicemail",
      ...(input.voicemailGreeting?.trim() ? { voicemailGreeting: input.voicemailGreeting.trim().slice(0, 400) } : {}),
      outbound: input.outbound === "member" || input.outbound === "off" ? input.outbound : "admin",
      record: Boolean(input.record),
      ...trunks,
      updatedAt: this.now()
    };
    await this.deps.store.kv.set(this.deps.ownerId, PHONE_KEY, record);
    this.cache = record;
    this.deps.log("realtime.phone_setup", { workspaceId, provider, numbers: numbers.length, rebuilt: trunkChanged });
    return this.toView(record);
  }

  async remove(): Promise<void> {
    const current = await this.settings();
    if (!current) return;
    await this.teardown(current, { keepSecret: false });
    await this.deps.store.kv.delete(this.deps.ownerId, PHONE_KEY);
    this.cache = undefined;
    this.deps.log("realtime.phone_removed", {});
  }

  private async createTrunks(input: { address: string; numbers: string[]; workspaceId: string; username?: string; password?: string }) {
    const { sip } = this.deps.api();
    const auth = input.username && input.password ? { authUsername: input.username, authPassword: input.password } : {};
    const outbound = await sip.createSipOutboundTrunk("Sibyl outbound", input.address, input.numbers, { transport: SIPTransport.SIP_TRANSPORT_AUTO, ...auth });
    const inbound = await sip.createSipInboundTrunk("Sibyl inbound", input.numbers, {});
    // Rooms are named after the called line (never the caller): sibyl.phone.<space>.<line>_<random>.
    const rule = await sip.createSipDispatchRule(
      { type: "callee", roomPrefix: this.deps.prefixFor(input.workspaceId), randomize: true },
      { name: "Sibyl inbound", trunkIds: [inbound.sipTrunkId] }
    );
    return { outboundTrunkId: outbound.sipTrunkId, inboundTrunkId: inbound.sipTrunkId, dispatchRuleId: rule.sipDispatchRuleId };
  }

  /** LiveKit numbers: a dispatch rule of our own, and every number routed to it. */
  private async routeNumbers(numbers: string[], workspaceId: string) {
    const api = this.numbers();
    const owned = await api.list();
    const missing = numbers.filter((number) => !owned.some((item) => item.number === number));
    if (missing.length > 0) throw new PhoneError(`${missing.join(", ")} isn't one of this LiveKit project's numbers. Buy it below or in the LiveKit Cloud dashboard first.`, 409);
    const { sip } = this.deps.api();
    const rule = await sip.createSipDispatchRule(
      { type: "callee", roomPrefix: this.deps.prefixFor(workspaceId), randomize: true },
      { name: "Sibyl inbound (LiveKit numbers)" }
    );
    for (const number of numbers) await api.route(number, rule.sipDispatchRuleId);
    return { dispatchRuleId: rule.sipDispatchRuleId };
  }

  private async teardown(line: PhoneLineRecord, options: { keepSecret: boolean }): Promise<void> {
    const { sip } = this.deps.api();
    if (line.provider === "livekit" && this.cloud) {
      for (const number of line.numbers) await this.numbers().route(number, "").catch(() => undefined);
    }
    if (line.dispatchRuleId) await sip.deleteSipDispatchRule(line.dispatchRuleId).catch(() => undefined);
    for (const trunk of [line.inboundTrunkId, line.outboundTrunkId]) {
      if (trunk) await sip.deleteSipTrunk(trunk).catch(() => undefined);
    }
    if (!options.keepSecret && line.passwordStored) await this.deps.vault?.()?.delete(this.deps.ownerId, PHONE_SECRET).catch(() => false);
  }

  /* ───────────── LiveKit Cloud numbers ───────────── */

  numbers(): Pick<LiveKitNumbers, "search" | "purchase" | "list" | "get" | "route"> {
    this.numbersApi ??= this.deps.numbers ?? new LiveKitNumbers(this.deps.config);
    return this.numbersApi;
  }

  async liveKitNumbers(areaCode?: string): Promise<{ owned: LiveKitNumberView[]; available: LiveKitNumberView[] }> {
    if (!this.cloud) throw new PhoneError("LiveKit phone numbers need LiveKit Cloud (LIVEKIT_URL at *.livekit.cloud).", 409);
    const line = await this.settings();
    const api = this.numbers();
    const [owned, available] = await Promise.all([
      api.list(),
      areaCode !== undefined ? api.search({ ...(areaCode ? { areaCode } : {}), limit: 10 }) : Promise.resolve([])
    ]);
    return {
      owned: owned.map((item) => ({
        id: item.id,
        number: item.number,
        status: item.status,
        ...(item.locality ? { locality: item.locality } : {}),
        ...(item.region ? { region: item.region } : {}),
        routed: Boolean(line?.dispatchRuleId && item.dispatchRuleIds.includes(line.dispatchRuleId))
      })),
      available: available.map((item) => ({ number: item.number, ...(item.locality ? { locality: item.locality } : {}), ...(item.region ? { region: item.region } : {}) }))
    };
  }

  /** Rent a LiveKit number (LiveKit bills it monthly); routed to the line when one is set up. */
  async buyNumber(number: string): Promise<LiveKitNumberView> {
    if (!this.cloud) throw new PhoneError("LiveKit phone numbers need LiveKit Cloud.", 409);
    if (!E164.test(number)) throw new PhoneError("Pick a number from the list.");
    const line = await this.settings();
    const bought = await this.numbers().purchase(number, line?.provider === "livekit" ? line.dispatchRuleId : undefined);
    this.deps.log("realtime.phone_number_bought", {});
    return { id: bought.id, number: bought.number, status: bought.status };
  }

  /* ───────────── test ───────────── */

  async test(): Promise<PhoneTestView> {
    const line = await this.settings();
    const steps: PhoneTestStep[] = [];
    const add = (step: PhoneTestStep) => steps.push(step);
    const { rooms, sip } = this.deps.api();
    try {
      await rooms.listRooms([]);
      add({ id: "livekit", label: "LiveKit server", status: "ok", detail: `Reached ${this.deps.config.publicUrl}${this.cloud ? " (LiveKit Cloud)" : ""}.` });
    } catch (error) {
      add({ id: "livekit", label: "LiveKit server", status: "failed", detail: `LiveKit didn't answer: ${short(error)}` });
      return { ok: false, steps, at: this.now() };
    }
    try {
      await sip.listSipInboundTrunk();
      add({
        id: "sip",
        label: "LiveKit SIP",
        status: "ok",
        detail: this.cloud ? "LiveKit Cloud telephony answered." : "LiveKit's SIP API answered. The SIP bridge (the sip service, docker compose --profile phone) must also run and be reachable on UDP 5060."
      });
    } catch (error) {
      add({ id: "sip", label: "LiveKit SIP", status: "failed", detail: `LiveKit's SIP API failed (${short(error)}). Self-hosted: start Redis and the sip service (docker compose --profile phone).` });
    }
    if (!line) {
      add({ id: "trunks", label: "Phone line", status: "skipped", detail: "No line is set up yet." });
      return { ok: steps.every((step) => step.status === "ok" || step.status === "skipped"), steps, at: this.now() };
    }
    if (line.provider !== "livekit" && line.address) {
      const host = hostOf(line.address);
      try {
        const ip = await (this.deps.resolveHost ?? (async (name: string) => (await lookup(name)).address))(host);
        add({ id: "provider", label: "Provider's SIP address", status: "ok", detail: `${host} resolves (${ip}).` });
      } catch (error) {
        add({ id: "provider", label: "Provider's SIP address", status: "failed", detail: `${host} doesn't resolve: ${short(error)}` });
      }
      try {
        const outbound = line.outboundTrunkId ? (await sip.listSipOutboundTrunk({ trunkIds: [line.outboundTrunkId] })).find(Boolean) : undefined;
        const inbound = line.inboundTrunkId ? (await sip.listSipInboundTrunk({ trunkIds: [line.inboundTrunkId] })).find(Boolean) : undefined;
        const ok = Boolean(outbound && inbound && line.numbers.every((number) => outbound.numbers.includes(number) && inbound.numbers.includes(number)));
        add({
          id: "trunks",
          label: "SIP trunks in LiveKit",
          status: ok ? "ok" : "failed",
          detail: ok
            ? `Outbound trunk to ${outbound!.address}${outbound!.authUsername ? " with a user name and password" : ""} and inbound trunk for ${line.numbers.join(", ")}.`
            : "The trunks are missing or changed in LiveKit. Save the line again to rebuild them."
        });
      } catch (error) {
        add({ id: "trunks", label: "SIP trunks in LiveKit", status: "failed", detail: short(error) });
      }
    }
    try {
      const rule = line.dispatchRuleId ? (await sip.listSipDispatchRule({ dispatchRuleIds: [line.dispatchRuleId] })).find(Boolean) : undefined;
      add({
        id: "dispatch",
        label: "Inbound routing",
        status: rule ? "ok" : "failed",
        detail: rule ? "Calls to the line open a room Sibyl answers." : "The dispatch rule is missing in LiveKit. Save the line again."
      });
    } catch (error) {
      add({ id: "dispatch", label: "Inbound routing", status: "failed", detail: short(error) });
    }
    if (line.provider === "livekit") {
      try {
        const numbers = await Promise.all(line.numbers.map((number) => this.numbers().get(number)));
        const bad = line.numbers.filter((_number, index) => {
          const found = numbers[index];
          return !found || found.status !== "active" || !line.dispatchRuleId || !found.dispatchRuleIds.includes(line.dispatchRuleId);
        });
        add({
          id: "numbers",
          label: "LiveKit numbers",
          status: bad.length === 0 ? "ok" : "failed",
          detail: bad.length === 0 ? `${line.numbers.join(", ")} active and routed to Sibyl.` : `Not active or not routed: ${bad.join(", ")}. Save the line again.`
        });
      } catch (error) {
        add({ id: "numbers", label: "LiveKit numbers", status: "failed", detail: short(error) });
      }
    }
    const open = isOpen(line.hours, this.now());
    add({
      id: "hours",
      label: "Business hours",
      status: "ok",
      detail: !line.hours ? "Always open: Sibyl answers every call." : open ? "Open now: calls are answered." : line.afterHours === "answer" ? "Closed now; calls are still answered." : "Closed now: callers can leave a message (it goes to the Inbox)."
    });
    return { ok: steps.every((step) => step.status === "ok" || step.status === "skipped"), steps, at: this.now() };
  }

  /* ───────────── calls ───────────── */

  /** May this person ask for outbound calls (each call still needs an approval)? */
  mayCallOut(principal: Principal, workspaceId: string): boolean {
    const setting = this.cache?.outbound ?? "admin";
    if (setting === "off") return false;
    if (principal.kind !== "user") return true;
    const role = effectiveWorkspaceRole(principal, workspaceId);
    return Boolean(role) && roleRank(role!) >= roleRank(setting);
  }

  /**
   * Place a call: Sibyl (or an agent) joins a new room, then LiveKit dials the
   * number into it. Reached only through the place_phone_call tool, which
   * always needs the person's approval.
   */
  async placeCall(input: { principal: Principal; workspaceId: string; to: string; purpose: string; agentId?: string }): Promise<{ callId: string; room: string; conversationId: string }> {
    const line = this.cache ?? (await this.settings());
    const trunk = this.deps.config.sipOutboundTrunkId ?? line?.outboundTrunkId;
    if (!trunk) {
      throw new PhoneError(
        line?.provider === "livekit"
          ? "LiveKit phone numbers take incoming calls only. Calling out needs a SIP provider (Settings → Phone)."
          : "Phone calls aren't set up on this Sibyl (Settings → Phone, see docs/realtime.md#phone-calls).",
        409
      );
    }
    if (!this.mayCallOut(input.principal, input.workspaceId)) throw new PhoneError("Your organization doesn't let you place phone calls. Ask an admin (Settings → Phone).", 403);
    if (!E164.test(input.to)) throw new PhoneError("The number must be in E.164 form, like +15551234567.");
    const id = randomBytes(12).toString("base64url");
    const room = this.deps.roomFor(input.workspaceId, id);
    const session = this.deps.headless(input.principal, input.workspaceId);
    if (input.agentId) session.deliver({ type: AGENT_EVENTS.SELECT, agentId: input.agentId });
    const caller = input.principal.name ?? input.principal.email ?? "the person you work for";
    session.addNote(
      "Call brief",
      `You are on a phone call you placed for ${caller}. Purpose: ${input.purpose.slice(0, 1_000)} ` +
        "When they answer, greet them, say who you are calling for, handle the purpose briefly and politely, and end the call when done."
    );
    const record = await this.startRecord({
      id,
      direction: "outbound",
      room,
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? "sibyl",
      principal: input.principal,
      remoteNumber: input.to,
      ...(line?.numbers[0] ? { lineNumber: this.deps.config.sipFromNumber ?? line.numbers[0] } : {}),
      conversationId: session.conversationId,
      status: "ringing"
    });
    const agent = await this.deps.startAgent({
      room,
      port: session,
      mode: "conversation",
      principal: input.principal,
      workspaceId: input.workspaceId,
      idleTimeoutMs: 60_000,
      emptyAfterLeaveMs: 2_000,
      onStop: (reason) => {
        session.close("call ended");
        void this.finish(room, reason);
      },
      onUtterance: (segment) => this.heard(room, segment)
    });
    this.active.set(room, { record, session, mode: "conversation", heard: [] });
    try {
      await this.deps.api().sip.createSipParticipant(trunk, input.to, room, {
        participantIdentity: `phone:${id}`,
        participantName: "Phone",
        ...((this.deps.config.sipFromNumber ?? line?.numbers[0]) ? { fromNumber: this.deps.config.sipFromNumber ?? line?.numbers[0] } : {}),
        ringingTimeout: 45,
        maxCallDuration: 30 * 60,
        playDialtone: false
      });
    } catch (error) {
      await this.update(room, { status: "failed", error: short(error) });
      await agent.stop("dial failed");
      throw error;
    }
    if (line?.record) void this.record(room, input.principal, input.workspaceId);
    this.deps.log("realtime.phone_call", { room, workspaceId: input.workspaceId });
    return { callId: id, room, conversationId: session.conversationId };
  }

  /** The caller's phone joined a room of the line (LiveKit webhook): answer it, or take a message after hours. */
  async answer(room: string, event: WebhookEvent, spaceMatches: (workspaceId: string) => boolean): Promise<void> {
    if (this.active.has(room)) {
      // An outbound call: LiveKit adds the callee's leg while it dials; it is answered once its call status is "active"
      // (otherwise the first words heard mark it answered).
      const call = this.active.get(room)!;
      if (call.record.direction === "outbound" && !call.record.answeredAt && event.participant?.attributes?.["sip.callStatus"] === "active") {
        await this.update(room, { status: "active", answeredAt: this.now() });
      }
      return;
    }
    const line = await this.settings();
    if (!line || !spaceMatches(line.workspaceId)) {
      this.deps.log("realtime.phone_unrouted", { room });
      return;
    }
    const attributes = event.participant?.attributes ?? {};
    const remote = typeof attributes["sip.phoneNumber"] === "string" && E164.test(attributes["sip.phoneNumber"]) ? attributes["sip.phoneNumber"] : undefined;
    const called = typeof attributes["sip.trunkPhoneNumber"] === "string" && E164.test(attributes["sip.trunkPhoneNumber"]) ? attributes["sip.trunkPhoneNumber"] : line.numbers[0];
    const open = isOpen(line.hours, this.now());
    const mode: RoomAgentMode = open || line.afterHours === "answer" ? "conversation" : "voicemail";
    // The caller is a stranger: a viewer-level session with no person behind it.
    const principal: Principal = { kind: "user", orgId: this.deps.ownerId, name: "Phone caller", workspaceRoles: { [line.workspaceId]: "viewer" } };
    const session = this.deps.headless(principal, line.workspaceId);
    if (line.agentId && mode === "conversation") session.deliver({ type: AGENT_EVENTS.SELECT, agentId: line.agentId });
    if (mode === "voicemail") session.addNote("Voicemail", "The line is closed: this call only takes a message. Lines below are what the caller said.");
    const record = await this.startRecord({
      id: randomBytes(12).toString("base64url"),
      direction: "inbound",
      room,
      workspaceId: line.workspaceId,
      agentId: mode === "conversation" ? line.agentId ?? "sibyl" : "sibyl",
      principal,
      ...(remote ? { remoteNumber: remote } : {}),
      ...(called ? { lineNumber: called } : {}),
      conversationId: session.conversationId,
      status: "active",
      answeredAt: this.now()
    });
    this.active.set(room, { record, session, mode, heard: [] });
    await this.deps.startAgent({
      room,
      port: session,
      mode,
      principal,
      workspaceId: line.workspaceId,
      idleTimeoutMs: 30_000,
      emptyAfterLeaveMs: 2_000,
      onStop: (reason) => {
        session.close("call ended");
        void this.finish(room, reason);
      },
      onUtterance: (segment) => this.heard(room, segment)
    });
    session.say(mode === "voicemail" ? line.voicemailGreeting ?? DEFAULT_VOICEMAIL : line.greeting ?? DEFAULT_GREETING);
    if (line.record) void this.record(room, undefined, line.workspaceId);
    this.deps.log("realtime.phone_answered", { room, workspaceId: line.workspaceId, mode });
  }

  /** A recording of a phone room started or stopped: the caller hears it. */
  announce(room: string, state: "started" | "stopped"): boolean {
    const call = this.active.get(room);
    if (!call) return false;
    if (state === "started") call.session.say(RECORDING_ANNOUNCEMENT);
    return true;
  }

  async linkRecording(room: string, recordingId: string): Promise<void> {
    await this.update(room, { recordingId });
  }

  /** The call log entry of a phone room (live or past). */
  async callOfRoom(room: string): Promise<CallLogRecord | undefined> {
    const live = this.active.get(room);
    if (live) return live.record;
    const recent = await this.deps.store.calls.list(this.deps.ownerId, { limit: 200 });
    return recent.find((call) => call.room === room);
  }

  async log(query: { workspaceId: string; direction?: "inbound" | "outbound"; before?: number; limit?: number }): Promise<CallLogView[]> {
    const calls = await this.deps.store.calls.list(this.deps.ownerId, {
      workspaceId: query.workspaceId,
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.before ? { before: query.before } : {}),
      limit: Math.min(Math.max(query.limit ?? 50, 1), 200)
    });
    return calls.map(callView);
  }

  private async record(room: string, principal: Principal | undefined, workspaceId: string): Promise<void> {
    const recorder = this.deps.recorder?.();
    if (!recorder) return;
    try {
      await recorder.start({ ...(principal ? { principal } : {}), workspaceId, room, video: false });
    } catch (error) {
      this.deps.log("realtime.phone_record_failed", { room, error: short(error) });
    }
  }

  private heard(room: string, segment: RoomSegment): void {
    const call = this.active.get(room);
    if (!call) return;
    call.heard.push(segment.text);
    if (!call.record.answeredAt) void this.update(room, { status: "active", answeredAt: segment.startedAt });
  }

  private async startRecord(input: {
    id: string;
    direction: "inbound" | "outbound";
    room: string;
    workspaceId: string;
    agentId: string;
    principal: Principal;
    remoteNumber?: string;
    lineNumber?: string;
    conversationId: string;
    status: CallLogRecord["status"];
    answeredAt?: number;
  }): Promise<CallLogRecord> {
    const profiles = await this.deps.candidates(input.principal, input.workspaceId).catch(() => [] as RoomVoiceProfile[]);
    const now = this.now();
    const record: CallLogRecord = {
      id: input.id,
      ownerId: this.deps.ownerId,
      workspaceId: input.workspaceId,
      direction: input.direction,
      status: input.status,
      room: input.room,
      ...(input.lineNumber ? { lineNumber: input.lineNumber } : {}),
      ...(input.remoteNumber ? { remoteNumber: input.remoteNumber } : {}),
      agentId: input.agentId,
      agentName: profiles.find((profile) => profile.id === input.agentId)?.name ?? (input.agentId === "sibyl" ? "Sibyl" : "Agent"),
      ...(input.direction === "outbound" && input.principal.userId ? { placedBy: input.principal.userId } : {}),
      conversationId: input.conversationId,
      startedAt: now,
      ...(input.answeredAt ? { answeredAt: input.answeredAt } : {}),
      updatedAt: now
    };
    await this.deps.store.calls.upsert(record);
    return record;
  }

  private async update(room: string, patch: Partial<CallLogRecord>): Promise<void> {
    const call = this.active.get(room);
    const current = call?.record ?? (await this.callOfRoom(room));
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: this.now() };
    if (call) call.record = next;
    await this.deps.store.calls.upsert(next);
  }

  /** The call ended: duration, status, cost from the usage meter, and the voicemail into the Inbox. */
  private async finish(room: string, reason: string): Promise<void> {
    const call = this.active.get(room);
    if (!call) return;
    this.active.delete(room);
    const ended = this.now();
    const record = call.record;
    const transcript = call.heard.join(" ").trim();
    const status: CallLogRecord["status"] =
      record.status === "failed" ? "failed" : call.mode === "voicemail" ? (transcript ? "voicemail" : "missed") : record.answeredAt || transcript ? "completed" : "missed";
    let costUsd = 0;
    try {
      const events = await this.deps.store.usage.list(this.deps.ownerId, record.startedAt, ended + 1);
      costUsd = events.filter((event) => event.conversationId === record.conversationId).reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
    } catch {
      // Cost is best effort.
    }
    const next: CallLogRecord = {
      ...record,
      status,
      endedAt: ended,
      durationMs: Math.max(0, ended - (record.answeredAt ?? record.startedAt)),
      ...(costUsd > 0 ? { costUsd: Number(costUsd.toFixed(6)) } : {}),
      ...(status === "voicemail" ? { voicemail: { transcript: transcript.slice(0, 4_000) } } : {}),
      updatedAt: ended
    };
    await this.deps.store.calls.upsert(next);
    this.deps.log("realtime.phone_ended", { room, status, reason, ms: next.durationMs });
    if (status === "voicemail" && this.deps.notify) {
      this.deps.notify({
        kind: "voicemail",
        workspaceId: record.workspaceId,
        title: `Voicemail from ${record.remoteNumber ?? "an unknown number"}`,
        body: transcript.slice(0, 2_000),
        links: { ...(record.conversationId ? { conversationId: record.conversationId } : {}) }
      });
    }
  }

  private toView(line: PhoneLineRecord): PhoneLineView {
    return {
      provider: line.provider,
      numbers: line.numbers,
      workspaceId: line.workspaceId,
      ...(line.address ? { address: line.address } : {}),
      ...(line.username ? { username: line.username } : {}),
      hasPassword: Boolean(line.passwordStored),
      ...(line.agentId ? { agentId: line.agentId } : {}),
      ...(line.greeting ? { greeting: line.greeting } : {}),
      ...(line.hours ? { hours: line.hours } : {}),
      afterHours: line.afterHours ?? "voicemail",
      ...(line.voicemailGreeting ? { voicemailGreeting: line.voicemailGreeting } : {}),
      outbound: line.outbound ?? "admin",
      record: Boolean(line.record),
      canCallOut: Boolean(this.deps.config.sipOutboundTrunkId || line.outboundTrunkId),
      openNow: isOpen(line.hours, this.now()),
      updatedAt: line.updatedAt
    };
  }
}

/* ───────────── pure helpers ───────────── */

function normalize(stored: PhoneLineRecord): PhoneLineRecord {
  const numbers = stored.numbers?.length ? stored.numbers : stored.number ? [stored.number] : [];
  return { ...stored, numbers, provider: PROVIDERS.has(stored.provider) ? stored.provider : "other" };
}

function checkHours(hours: PhoneHoursView): PhoneHoursView {
  const days = [...new Set((hours.days ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  if (days.length === 0) throw new PhoneError("Pick at least one open day, or turn business hours off.");
  if (!CLOCK.test(hours.open) || !CLOCK.test(hours.close)) throw new PhoneError("Opening hours look like 09:00 and 17:30.");
  if (hours.open === hours.close) throw new PhoneError("Opening and closing time can't be the same.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: hours.timeZone });
  } catch {
    throw new PhoneError("Unknown time zone.");
  }
  return { timeZone: hours.timeZone, days, open: hours.open, close: hours.close };
}

/** Is the line open at `at`? No hours: always. Closing before opening spans midnight (22:00–06:00). */
export function isOpen(hours: PhoneHoursView | undefined, at: number): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: hours.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const [openH, openM] = hours.open.split(":").map(Number);
  const [closeH, closeM] = hours.close.split(":").map(Number);
  const open = openH! * 60 + openM!;
  const close = closeH! * 60 + closeM!;
  if (open < close) return hours.days.includes(day) && minutes >= open && minutes < close;
  // Overnight: the evening part belongs to today, the early-morning part to yesterday's opening.
  if (minutes >= open) return hours.days.includes(day);
  return minutes < close && hours.days.includes((day + 6) % 7);
}

function hostOf(address: string): string {
  return address.replace(/:\d+$/, "");
}

function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export function callView(record: CallLogRecord): CallLogView {
  return {
    id: record.id,
    direction: record.direction,
    status: record.status,
    workspaceId: record.workspaceId,
    ...(record.lineNumber ? { lineNumber: record.lineNumber } : {}),
    ...(record.remoteNumber ? { remoteNumber: record.remoteNumber } : {}),
    agentId: record.agentId,
    agentName: record.agentName,
    startedAt: record.startedAt,
    ...(record.answeredAt ? { answeredAt: record.answeredAt } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.costUsd ? { costUsd: record.costUsd } : {}),
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    ...(record.recordingId ? { recordingId: record.recordingId } : {}),
    ...(record.voicemail ? { voicemail: record.voicemail.transcript } : {}),
    ...(record.error ? { error: record.error } : {})
  };
}
