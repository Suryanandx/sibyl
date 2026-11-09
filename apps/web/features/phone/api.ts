"use client";

/** The phone line and its call log (docs/realtime.md#phone-calls) over the one gateway HTTP client. */
import type { CallLogView, LiveKitNumberView, PhoneLineInput, PhoneLineView, PhoneProviderPreset, PhoneTestView } from "@open-gpt-live/protocol";
import { gatewayRequest } from "../../lib/gateway-http";

export interface PhoneState {
  phone: PhoneLineView | null;
  /** LIVEKIT_URL points at LiveKit Cloud: LiveKit phone numbers are possible. */
  cloud: boolean;
  providers: PhoneProviderPreset[];
}

export const phoneApi = {
  get: () => gatewayRequest<PhoneState>("/api/realtime/phone"),
  save: (input: PhoneLineInput) => gatewayRequest<{ phone: PhoneLineView }>("/api/realtime/phone", { method: "PUT", body: input }).then((r) => r.phone),
  remove: () => gatewayRequest("/api/realtime/phone", { method: "DELETE" }),
  test: () => gatewayRequest<PhoneTestView>("/api/realtime/phone/test", { method: "POST" }),
  numbers: (areaCode?: string) =>
    gatewayRequest<{ owned: LiveKitNumberView[]; available: LiveKitNumberView[] }>(`/api/realtime/phone/numbers${areaCode !== undefined ? `?areaCode=${encodeURIComponent(areaCode)}` : ""}`),
  buy: (number: string) => gatewayRequest<{ number: LiveKitNumberView }>("/api/realtime/phone/numbers", { method: "POST", body: { number } }).then((r) => r.number),
  calls: (query: { direction?: "inbound" | "outbound"; before?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.direction) params.set("direction", query.direction);
    if (query.before) params.set("before", String(query.before));
    const search = params.toString();
    return gatewayRequest<{ items: CallLogView[] }>(`/api/realtime/calls${search ? `?${search}` : ""}`).then((r) => r.items);
  }
};

/** "1:05" or "12 s". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
