/**
 * Access tokens: the gateway is the only place that mints them, after its
 * own sign-in and permission checks. People may join, listen, speak with
 * their microphone and send data; never administer or record a room.
 */
import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { RealtimeConfig } from "./config.js";

export interface TokenRequest {
  room: string;
  identity: string;
  name?: string;
  attributes?: Record<string, string>;
  /** Agents (the gateway's own participants) may also publish their voice. */
  agent?: boolean;
  /** People in a call or meeting may also share their camera and screen (voice rooms: microphone only). */
  video?: boolean;
  ttlSeconds?: number;
}

export async function issueToken(config: RealtimeConfig, request: TokenRequest): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: request.identity,
    ...(request.name ? { name: request.name } : {}),
    ...(request.attributes ? { attributes: request.attributes } : {}),
    ttl: request.ttlSeconds ?? config.tokenTtlSeconds
  });
  token.addGrant({
    room: request.room,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    canPublishSources: request.video
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
      : [TrackSource.MICROPHONE],
    // Only the gateway's own participants may change their name and attributes.
    canUpdateOwnMetadata: Boolean(request.agent)
  });
  return token.toJwt();
}
