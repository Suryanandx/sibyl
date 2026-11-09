/**
 * Realtime layer settings (LiveKit). Off unless all three of LIVEKIT_URL,
 * LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set; then voice runs over WebRTC
 * and the WebSocket path stays as the fallback. See docs/realtime.md.
 */

export interface RealtimeConfig {
  /** Where the gateway reaches LiveKit (ws:// or wss://). */
  url: string;
  /** Where browsers reach LiveKit (LIVEKIT_PUBLIC_URL; defaults to url). */
  publicUrl: string;
  /** The same server over HTTP(S), for the server API (rooms, SIP, ingress, egress). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Outbound SIP trunk for phone calls (LIVEKIT_SIP_OUTBOUND_TRUNK_ID; or set up from the app). */
  sipOutboundTrunkId?: string;
  /** Caller ID for outbound calls (E.164). */
  sipFromNumber?: string;
  /** Lifetime of access tokens handed to browsers. */
  tokenTtlSeconds: number;
}

export type RealtimeConfigResult =
  | { config: RealtimeConfig; problem?: undefined }
  | { config?: undefined; problem?: string };

export function realtimeConfigFromEnv(env: NodeJS.ProcessEnv): RealtimeConfigResult {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!url && !apiKey && !apiSecret) return {};
  if (!url || !apiKey || !apiSecret) {
    return { problem: "LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must all be set; realtime stays off" };
  }
  if (!/^wss?:\/\//i.test(url)) return { problem: "LIVEKIT_URL must start with ws:// or wss://; realtime stays off" };
  const publicUrl = env.LIVEKIT_PUBLIC_URL?.trim() || url;
  if (!/^wss?:\/\//i.test(publicUrl)) return { problem: "LIVEKIT_PUBLIC_URL must start with ws:// or wss://; realtime stays off" };
  const trunk = env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID?.trim();
  const from = env.LIVEKIT_SIP_FROM_NUMBER?.trim();
  return {
    config: {
      url,
      publicUrl,
      apiUrl: url.replace(/^ws/i, "http"),
      apiKey,
      apiSecret,
      ...(trunk ? { sipOutboundTrunkId: trunk } : {}),
      ...(from ? { sipFromNumber: from } : {}),
      tokenTtlSeconds: 10 * 60
    }
  };
}
