/**
 * LiveKit Phone Numbers (LiveKit Cloud only): search, buy and route US
 * numbers without a separate SIP provider. The server SDK has no client for
 * it yet, so this speaks LiveKit's Twirp API directly
 * (POST <server>/twirp/livekit.PhoneNumberService/<Method>, JSON, a token
 * with the SIP admin grant). Reference:
 * https://docs.livekit.io/reference/telephony/phone-numbers-api/
 *
 * Limits (LiveKit's docs, 2026-11): US local and toll-free numbers only,
 * inbound calls only (outbound still needs a SIP trunk), one free local
 * number per Cloud project, billed per month.
 */
import { AccessToken } from "livekit-server-sdk";
import type { RealtimeConfig } from "./config.js";

export interface LiveKitNumber {
  id: string;
  /** E.164, e.g. +14155550100. */
  number: string;
  status: "active" | "pending" | "released" | "offline" | "unknown";
  locality?: string;
  region?: string;
  /** Dispatch rules the number routes to. */
  dispatchRuleIds: string[];
}

export interface AvailableNumber {
  number: string;
  locality?: string;
  region?: string;
  type?: string;
}

const STATUS: Record<string, LiveKitNumber["status"]> = {
  PHONE_NUMBER_STATUS_ACTIVE: "active",
  PHONE_NUMBER_STATUS_PENDING: "pending",
  PHONE_NUMBER_STATUS_RELEASED: "released",
  PHONE_NUMBER_STATUS_OFFLINE: "offline",
  "1": "active",
  "2": "pending",
  "3": "released",
  "4": "offline"
};

/** LiveKit Cloud project URLs end in .livekit.cloud; self-hosted servers need a SIP provider instead. */
export function isLiveKitCloud(config: Pick<RealtimeConfig, "url">): boolean {
  try {
    return new URL(config.url.replace(/^ws/i, "http")).hostname.endsWith(".livekit.cloud");
  } catch {
    return false;
  }
}

export class LiveKitNumbersError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class LiveKitNumbers {
  constructor(
    private readonly config: RealtimeConfig,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async search(input: { areaCode?: string; limit?: number }): Promise<AvailableNumber[]> {
    const body: Record<string, unknown> = { country_code: "US", limit: Math.min(Math.max(input.limit ?? 10, 1), 50) };
    if (input.areaCode) body.area_code = input.areaCode;
    const result = await this.call<{ items?: Array<Record<string, unknown>> }>("SearchPhoneNumbers", body);
    return (result.items ?? []).map((item) => ({
      number: String(item.e164_format ?? item.e164Format ?? ""),
      ...(typeof item.locality === "string" && item.locality ? { locality: item.locality } : {}),
      ...(typeof item.region === "string" && item.region ? { region: item.region } : {}),
      ...(typeof (item.number_type ?? item.numberType) === "string" ? { type: String(item.number_type ?? item.numberType) } : {})
    })).filter((item) => item.number);
  }

  /** Rent a number (billed by LiveKit) and route it to a dispatch rule. */
  async purchase(number: string, dispatchRuleId?: string): Promise<LiveKitNumber> {
    const result = await this.call<{ phone_numbers?: Array<Record<string, unknown>>; phoneNumbers?: Array<Record<string, unknown>> }>("PurchasePhoneNumber", {
      phone_numbers: [number],
      ...(dispatchRuleId ? { sip_dispatch_rule_id: dispatchRuleId } : {})
    });
    const bought = (result.phone_numbers ?? result.phoneNumbers ?? [])[0];
    if (!bought) throw new LiveKitNumbersError("LiveKit didn't return the number.", 502);
    return toNumber(bought);
  }

  async list(): Promise<LiveKitNumber[]> {
    const result = await this.call<{ items?: Array<Record<string, unknown>> }>("ListPhoneNumbers", { limit: 50 });
    return (result.items ?? []).map(toNumber).filter((item) => item.status !== "released");
  }

  async get(number: string): Promise<LiveKitNumber | undefined> {
    try {
      const result = await this.call<{ phone_number?: Record<string, unknown>; phoneNumber?: Record<string, unknown> }>("GetPhoneNumber", { phone_number: number });
      const found = result.phone_number ?? result.phoneNumber;
      return found ? toNumber(found) : undefined;
    } catch (error) {
      if (error instanceof LiveKitNumbersError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Route a number to a dispatch rule (empty: unroute). */
  async route(number: string, dispatchRuleId: string): Promise<LiveKitNumber> {
    const result = await this.call<{ phone_number?: Record<string, unknown>; phoneNumber?: Record<string, unknown> }>("UpdatePhoneNumber", {
      phone_number: number,
      sip_dispatch_rule_id: dispatchRuleId
    });
    const updated = result.phone_number ?? result.phoneNumber;
    if (!updated) throw new LiveKitNumbersError("LiveKit didn't return the number.", 502);
    return toNumber(updated);
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, { ttl: 60 });
    token.addSIPGrant({ admin: true });
    const response = await this.fetcher(`${this.config.apiUrl.replace(/\/+$/, "")}/twirp/livekit.PhoneNumberService/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token.toJwt()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `LiveKit answered ${response.status}.`;
      try {
        const parsed = JSON.parse(text) as { msg?: unknown; code?: unknown };
        if (typeof parsed.msg === "string" && parsed.msg) message = parsed.msg.slice(0, 300);
      } catch {
        // Not JSON.
      }
      throw new LiveKitNumbersError(message, response.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function toNumber(item: Record<string, unknown>): LiveKitNumber {
  const rules = item.sip_dispatch_rule_ids ?? item.sipDispatchRuleIds;
  const single = item.sip_dispatch_rule_id ?? item.sipDispatchRuleId;
  return {
    id: String(item.id ?? ""),
    number: String(item.e164_format ?? item.e164Format ?? ""),
    status: STATUS[String(item.status ?? "")] ?? "unknown",
    ...(typeof item.locality === "string" && item.locality ? { locality: item.locality } : {}),
    ...(typeof item.region === "string" && item.region ? { region: item.region } : {}),
    dispatchRuleIds: Array.isArray(rules) ? rules.map(String) : typeof single === "string" && single ? [single] : []
  };
}
