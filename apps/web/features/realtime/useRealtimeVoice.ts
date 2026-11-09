"use client";

/**
 * Voice mode over LiveKit (when the gateway advertises it in session.config):
 * the chat's live mode joins its conversation's voice room instead of
 * streaming audio.chunk over the WebSocket. Turn detection, the brain, speech
 * and barge-in run in Sibyl's room agent; transcripts, replies, visuals and
 * approvals still arrive on the WebSocket as usual.
 *
 * `start()` resolves false when the room can't be joined, so the caller
 * falls back to the WebSocket voice path.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { REALTIME_EVENTS, type RealtimeTurnMessage, type ServerMessage } from "@open-gpt-live/protocol";
import { useGateway } from "../../lib/gateway";
import { joinRoom, type JoinedRoom } from "./room";

export interface RealtimeVoiceOptions {
  /** A spoken turn the room agent detected (start / end / cancel). */
  onTurn(turn: RealtimeTurnMessage): void;
  /** The room ended without the person stopping it (agent left, network). */
  onEnded(reason: string): void;
}

export interface RealtimeVoice {
  /** The gateway has LiveKit configured. */
  available: boolean;
  /** Voice currently runs through a LiveKit room. */
  active: boolean;
  activeRef: { readonly current: boolean };
  /** Sibyl or an agent is talking in the room. */
  agentSpeaking: boolean;
  start(): Promise<boolean>;
  stop(): void;
}

const JOIN_TIMEOUT_MS = 8_000;

export function useRealtimeVoice(options: RealtimeVoiceOptions): RealtimeVoice {
  const gateway = useGateway();
  const available = Boolean(gateway.capabilities?.realtime);
  const joinedRef = useRef<JoinedRoom | null>(null);
  const activeRef = useRef(false);
  const [active, setActive] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { send, subscribe } = gateway;

  const teardown = useCallback((reason: string, notify: boolean) => {
    const joined = joinedRef.current;
    joinedRef.current = null;
    const wasActive = activeRef.current;
    activeRef.current = false;
    setActive(false);
    setAgentSpeaking(false);
    void joined?.leave().catch(() => undefined);
    if (wasActive && notify) optionsRef.current.onEnded(reason);
  }, []);

  useEffect(
    () =>
      subscribe((message: ServerMessage) => {
        if (message.type === REALTIME_EVENTS.TURN && activeRef.current) optionsRef.current.onTurn(message);
        if (message.type === REALTIME_EVENTS.LEFT && activeRef.current && message.reason !== "left") teardown(message.reason, true);
      }),
    [subscribe, teardown]
  );

  useEffect(() => () => teardown("unmounted", false), [teardown]);

  const start = useCallback(async (): Promise<boolean> => {
    if (!available || activeRef.current) return activeRef.current;
    const joined = await new Promise<Extract<ServerMessage, { type: typeof REALTIME_EVENTS.JOINED }> | null>((resolve) => {
      const timer = window.setTimeout(() => finish(null), JOIN_TIMEOUT_MS);
      const unsubscribe = subscribe((message) => {
        if (message.type === REALTIME_EVENTS.JOINED && !message.callId) finish(message);
        else if (message.type === "error" && !message.requestId) finish(null);
      });
      function finish(value: Extract<ServerMessage, { type: typeof REALTIME_EVENTS.JOINED }> | null) {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(value);
      }
      if (!send({ type: REALTIME_EVENTS.JOIN })) finish(null);
    });
    if (!joined) return false;
    let room: JoinedRoom | undefined;
    try {
      room = await joinRoom(joined.url, joined.token, {
        onChange: () => {
          const speaking = [...(joinedRef.current?.room.activeSpeakers ?? [])].some((participant) => participant.identity.startsWith("agent:"));
          setAgentSpeaking(speaking);
        },
        onDisconnected: (reason) => {
          if (room && joinedRef.current === room) teardown(reason, true);
        }
      });
      // Voice needs the microphone; without it the caller shows its own error.
      if (!room.microphone) throw new Error("microphone unavailable");
      joinedRef.current = room;
      activeRef.current = true;
      setActive(true);
      return true;
    } catch {
      void room?.leave().catch(() => undefined);
      send({ type: REALTIME_EVENTS.LEAVE });
      return false;
    }
  }, [available, send, subscribe, teardown]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    send({ type: REALTIME_EVENTS.LEAVE });
    teardown("stopped", false);
  }, [send, teardown]);

  return { available, active, activeRef, agentSpeaking, start, stop };
}
