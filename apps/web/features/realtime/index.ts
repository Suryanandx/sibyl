/**
 * Realtime feature (LiveKit; docs/realtime.md). Only active when the gateway
 * advertises `capabilities.realtime` in session.config.
 *
 *   const realtime = useRealtimeVoice({ onTurn, onEnded });   // the chat's live mode
 *   if (realtime.available && (await realtime.start())) …       // else the WebSocket path
 *
 * Meeting rooms (/call/<id>) are in features/meetings.
 */
export { useRealtimeVoice, type RealtimeVoice, type RealtimeVoiceOptions } from "./useRealtimeVoice";
export { joinRoom, participantKind, type Caption, type JoinedRoom } from "./room";
