"use client";

import { useCallback, useEffect, useState } from "react";
import {
  COMPUTER_EVENTS,
  type ComputerActionView,
  type ComputerRunView,
  type ComputerStatusView,
  type ComputersInfoMessage
} from "@open-gpt-live/protocol";
import { useGateway } from "../../lib/gateway";

const LIVE_ACTIONS_KEPT = 200;
/** Views watching each agent on this page (the socket watch is shared; unwatch when the last one goes). */
const viewers = new Map<string, number>();

export interface ComputerState {
  status: ComputerStatusView | null;
  /** The latest screen frame as a data URL. */
  frame: string | null;
  /** Actions seen live on this page (newest last). */
  live: ComputerActionView[];
  /** The timeline being shown (a past or the current run). */
  runs: ComputerRunView[];
  runId?: string;
  actions: ComputerActionView[];
  error: string | null;
}

/**
 * Watch one agent's computer over the shared socket: status, live frames and
 * actions while mounted (the gateway only sends them to people who can see
 * the agent), plus a run's timeline on request.
 */
export function useComputer(agentId: string | undefined, options: { timeline?: boolean } = {}) {
  const { send, subscribe, connected } = useGateway();
  const [state, setState] = useState<ComputerState>({ status: null, frame: null, live: [], runs: [], actions: [], error: null });
  const wantTimeline = options.timeline ?? false;

  useEffect(() => {
    if (!agentId) return;
    const unsubscribe = subscribe((message) => {
      if (message.type === COMPUTER_EVENTS.STATUS && message.status.agentId === agentId) {
        setState((s) => ({ ...s, status: message.status, error: null, ...(message.status.state === "running" ? {} : { frame: null }) }));
      } else if (message.type === COMPUTER_EVENTS.FRAME && message.agentId === agentId) {
        setState((s) => ({ ...s, frame: `data:${message.mimeType};base64,${message.data}` }));
      } else if (message.type === COMPUTER_EVENTS.ACTION && message.action.agentId === agentId) {
        setState((s) => ({
          ...s,
          live: [...s.live, message.action].slice(-LIVE_ACTIONS_KEPT),
          // The run on screen keeps growing while it is the current one.
          ...(wantTimeline && (!s.runId || s.runId === message.action.runId) ? { runId: message.action.runId, actions: [...s.actions, message.action] } : {})
        }));
      } else if (message.type === COMPUTER_EVENTS.TIMELINE && message.agentId === agentId) {
        setState((s) => ({ ...s, runs: message.runs, ...(message.runId ? { runId: message.runId } : {}), actions: message.actions }));
      } else if (message.type === "error" && /agent|computer/i.test(message.message)) {
        setState((s) => ({ ...s, error: message.message }));
      }
    });
    return unsubscribe;
  }, [agentId, subscribe, wantTimeline]);

  useEffect(() => {
    if (!agentId || !connected) return;
    viewers.set(agentId, (viewers.get(agentId) ?? 0) + 1);
    send({ type: COMPUTER_EVENTS.WATCH, agentId });
    if (wantTimeline) send({ type: COMPUTER_EVENTS.TIMELINE_REQUEST, agentId });
    return () => {
      const left = (viewers.get(agentId) ?? 1) - 1;
      if (left > 0) viewers.set(agentId, left);
      else {
        viewers.delete(agentId);
        send({ type: COMPUTER_EVENTS.UNWATCH, agentId });
      }
    };
  }, [agentId, connected, send, wantTimeline]);

  const stop = useCallback(() => {
    if (agentId) send({ type: COMPUTER_EVENTS.STOP, agentId });
  }, [agentId, send]);

  const openRun = useCallback(
    (runId: string) => {
      if (agentId) send({ type: COMPUTER_EVENTS.TIMELINE_REQUEST, agentId, runId });
    },
    [agentId, send]
  );

  return { ...state, stop, openRun };
}

/** Is the feature available on this gateway, and its default limits. */
export function useComputersInfo(): Omit<ComputersInfoMessage, "type"> | null {
  const { send, subscribe, connected } = useGateway();
  const [info, setInfo] = useState<Omit<ComputersInfoMessage, "type"> | null>(null);
  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === COMPUTER_EVENTS.INFO) {
          const { type: _type, ...rest } = message;
          setInfo(rest);
        }
      }),
    [subscribe]
  );
  useEffect(() => {
    if (connected) send({ type: COMPUTER_EVENTS.INFO_REQUEST });
  }, [connected, send]);
  return info;
}
