"use client";

/**
 * A meeting room (/call/<id>): people and agents together, like a video call.
 *
 * - Pre-join: camera / microphone check. The host's own session then brings
 *   Sibyl in (realtime.join), so replies, visuals and approvals land in the
 *   host's chat; workspace members join over HTTP; guests come through the
 *   lobby (/join/<id>) and arrive here with their token.
 * - Stage: the active speaker (or a shared screen, or whoever you pinned)
 *   large, everyone else in a filmstrip. Agents show their animated avatar
 *   and a speaking ring; silent note-takers say "Taking notes".
 * - Controls: microphone, camera, screen, captions, raise hand, people,
 *   AI notes, add agent, invite link, leave / end for everyone.
 * - Side panel (members): Summary, Transcript, Actions, Ask AI, and People
 *   (the host admits guests, mutes, removes, and switches agent roles live).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Participant, Track } from "livekit-client";
import { normalizeAvatar } from "@open-gpt-live/core/avatar";
import {
  MEETING_EVENTS,
  MEETING_HAND_TOPIC,
  MEETING_SIGNAL_TOPIC,
  REALTIME_EVENTS,
  type AgentAvatarView,
  type MeetingAgentRoleView,
  type MeetingLobbyEntryView,
  type MeetingSegmentView,
  type MeetingView,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { Mark } from "../../components/Brand";
import { Icon, type IconName } from "../../components/Icon";
import { Button, Dialog, EmptyState, Field, Notice, Select } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { useGateway } from "../../lib/gateway";
import { errorText, gatewayRequest } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import { AgentAvatar } from "../agents";
import { joinRoom, participantKind, type Caption, type JoinedRoom } from "../realtime/room";
import { colorOf, meetingsApi } from "./api";
import { AssistPanel } from "./AssistPanel";
import { NotesPanel, type NotesTab } from "./NotesPanel";
import { PreJoin, type JoinChoice } from "./PreJoin";
import { initials, speakerColor } from "./speakers";
import styles from "./meetings.module.css";

type Phase = "prejoin" | "joining" | "live" | "ended" | "error";
type SidePanel = "notes" | "ask" | "people" | null;

interface TileModel {
  key: string;
  identity: string;
  name: string;
  kind: ReturnType<typeof participantKind>;
  local: boolean;
  speaking: boolean;
  micOff: boolean;
  video?: Track;
  screen: boolean;
  agentId?: string;
  avatar?: AgentAvatarView;
  role?: MeetingAgentRoleView;
  host: boolean;
}

export interface GuestGrant {
  url: string;
  token: string;
  room: string;
  identity: string;
}

export function MeetingRoom({ meetingId, guest }: { meetingId: string; guest?: { grant: GuestGrant; title: string; choice: JoinChoice } }) {
  const gateway = useGateway();
  const session = useAppSession();
  const { connected, send, subscribe } = gateway;
  const [phase, setPhase] = useState<Phase>(guest ? "joining" : "prejoin");
  const [error, setError] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [segments, setSegments] = useState<MeetingSegmentView[]>([]);
  const [lobby, setLobby] = useState<MeetingLobbyEntryView[]>([]);
  const [tiles, setTiles] = useState<TileModel[]>([]);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [showCaptions, setShowCaptions] = useState(true);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [hands, setHands] = useState<Set<string>>(new Set());
  const [side, setSide] = useState<SidePanel>(null);
  const [notesTab, setNotesTab] = useState<NotesTab>("summary");
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<string | null>(null);
  const [menu, setMenu] = useState<"leave" | "invite" | null>(null);
  const [adding, setAdding] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingTasks, setPendingTasks] = useState<Set<string>>(new Set());
  const joinedRef = useRef<JoinedRoom | null>(null);
  const lastSpeaker = useRef<string | null>(null);
  const peopleCount = useRef(0);
  const handRef = useRef(false);
  const isGuest = Boolean(guest);
  const isHost = Boolean(meeting?.isHost);
  const available = Boolean(gateway.capabilities?.realtime) || isGuest;
  const canRecord = !isGuest && session.hasFeature("recordings") && session.can("calls.record");

  /* ───────────── meeting data (members only) ───────────── */

  const loadMeeting = useCallback(async () => {
    if (isGuest) return;
    try {
      const [view, lines] = await Promise.all([meetingsApi.get(meetingId), meetingsApi.transcript(meetingId)]);
      setMeeting(view);
      setSegments(lines);
    } catch (reason) {
      setError(errorText(reason));
      setPhase((current) => (current === "prejoin" ? "error" : current));
    }
  }, [isGuest, meetingId]);

  // A finished line in the room: fetch the transcript shortly after (it is stored by then).
  const transcriptTimer = useRef<number | undefined>(undefined);
  const transcriptSoon = useCallback(() => {
    if (isGuest) return;
    window.clearTimeout(transcriptTimer.current);
    transcriptTimer.current = window.setTimeout(() => {
      void meetingsApi
        .transcript(meetingId)
        .then(setSegments)
        .catch(() => undefined);
    }, 1_500);
  }, [isGuest, meetingId]);

  const loadLobby = useCallback(async () => {
    if (isGuest || !meeting?.isHost) return;
    setLobby(await meetingsApi.lobby(meetingId).catch(() => []));
  }, [isGuest, meeting?.isHost, meetingId]);

  useEffect(() => {
    void loadMeeting();
  }, [loadMeeting]);

  // Live: notes and transcript every 20 s (sooner when the gateway nudges), the lobby every 8 s for the host.
  useEffect(() => {
    if (phase !== "live" || isGuest) return;
    const notes = window.setInterval(() => void loadMeeting(), 20_000);
    const knocks = window.setInterval(() => void loadLobby(), 8_000);
    void loadLobby();
    return () => {
      window.clearInterval(notes);
      window.clearInterval(knocks);
    };
  }, [phase, isGuest, loadMeeting, loadLobby]);

  /* ───────────── room ───────────── */

  const refresh = useCallback(() => {
    const room = joinedRef.current?.room;
    if (!room) return;
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()].filter((participant) => !participant.identity.startsWith("EG_"));
    const next: TileModel[] = [];
    for (const participant of all) {
      const local = participant === room.localParticipant;
      const base = tileOf(participant, local);
      const camera = [...participant.trackPublications.values()].find((publication) => publication.source === "camera" && publication.track && !publication.isMuted);
      next.push({ ...base, ...(camera?.track ? { video: camera.track } : {}) });
      const screen = [...participant.trackPublications.values()].find((publication) => publication.source === "screen_share" && publication.track);
      if (screen?.track) next.push({ ...base, key: `${participant.identity}:screen`, name: `${base.name} (screen)`, video: screen.track, screen: true, speaking: false });
    }
    // The main tile follows whoever else is talking (never yourself, as in any video call).
    const speaker = room.activeSpeakers.find((participant) => participant !== room.localParticipant);
    if (speaker) lastSpeaker.current = speaker.identity;
    setTiles(next);
    setRecording(room.isRecording);
    // Someone new: tell them my hand is up.
    const people = room.remoteParticipants.size;
    if (people > peopleCount.current && handRef.current) void joinedRef.current?.send(MEETING_HAND_TOPIC, { raised: true });
    peopleCount.current = people;
  }, []);

  const connect = useCallback(
    async (url: string, token: string, choice: JoinChoice) => {
      const joined = await joinRoom(
        url,
        token,
        {
          onChange: refresh,
          onCaption: (caption) => {
            setCaptions((current) => [...current.filter((item) => item.id !== caption.id), caption].slice(-40));
            if (caption.final) transcriptSoon();
          },
          onData: (topic, payload, from) => {
            if (topic === MEETING_HAND_TOPIC && from) {
              const raised = Boolean((payload as { raised?: unknown })?.raised);
              setHands((current) => {
                const next = new Set(current);
                if (raised) next.add(from);
                else next.delete(from);
                return next;
              });
            }
            if (topic === MEETING_SIGNAL_TOPIC) {
              const type = (payload as { type?: unknown })?.type;
              if (type === "notes" || type === "roles") void loadMeeting();
              if (type === "lobby") void loadLobby();
              if (type === "ended") setPhase("ended");
            }
          },
          onDisconnected: () => {
            if (joinedRef.current === joined) {
              joinedRef.current = null;
              setPhase("ended");
            }
          }
        },
        {
          microphone: choice.microphone,
          camera: choice.camera,
          ...(choice.audioDeviceId ? { audioDeviceId: choice.audioDeviceId } : {}),
          ...(choice.videoDeviceId ? { videoDeviceId: choice.videoDeviceId } : {})
        }
      );
      joinedRef.current = joined;
      setMuted(!choice.microphone || !joined.microphone);
      setCameraOn(joined.room.localParticipant.isCameraEnabled);
      if (choice.microphone && !joined.microphone) setError("Your microphone is blocked or missing: you can listen but not talk. Allow it in the browser and rejoin.");
      setPhase("live");
      refresh();
    },
    [refresh, loadMeeting, loadLobby, transcriptSoon]
  );

  // Guests arrive with their token.
  const guestStarted = useRef(false);
  useEffect(() => {
    if (!guest || guestStarted.current) return;
    guestStarted.current = true;
    void connect(guest.grant.url, guest.grant.token, guest.choice).catch((reason: unknown) => {
      setError(errorText(reason));
      setPhase("error");
    });
  }, [guest, connect]);

  async function join(choice: JoinChoice): Promise<void> {
    setPhase("joining");
    setError(null);
    try {
      if (meeting?.isHost) {
        // The host's own session brings Sibyl in (and gets the host's token back).
        const grant = await new Promise<{ url: string; token: string }>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            off();
            reject(new Error("Sibyl didn't answer. Check the connection and try again."));
          }, 20_000);
          const off = subscribe((message: ServerMessage) => {
            if (message.type === REALTIME_EVENTS.JOINED && message.callId === meetingId) {
              window.clearTimeout(timer);
              off();
              resolve(message);
            } else if (message.type === "error" && !message.requestId) {
              window.clearTimeout(timer);
              off();
              reject(new Error(message.message));
            }
          });
          if (!send({ type: REALTIME_EVENTS.JOIN, callId: meetingId })) {
            window.clearTimeout(timer);
            off();
            reject(new Error("Not connected to Sibyl yet. Try again in a moment."));
          }
        });
        await connect(grant.url, grant.token, choice);
        void loadMeeting();
        return;
      }
      const grant = await gatewayRequest<{ url: string; token: string }>("/api/realtime/token", { method: "POST", body: { callId: meetingId } });
      await connect(grant.url, grant.token, choice);
    } catch (reason) {
      setError(errorText(reason));
      setPhase("prejoin");
    }
  }

  // Leaving the screen ends your part of the call.
  useEffect(
    () => () => {
      const joined = joinedRef.current;
      joinedRef.current = null;
      void joined?.leave();
    },
    []
  );

  // Task results (Create task from an action item).
  useEffect(
    () =>
      subscribe((message: ServerMessage) => {
        if (message.type !== MEETING_EVENTS.TASK_RESULT || message.meetingId !== meetingId) return;
        setPendingTasks((current) => {
          const next = new Set(current);
          next.delete(message.actionId);
          return next;
        });
        flash(message.status === "created" ? "Task created." : message.message ?? "No task was created.");
        if (message.status === "created") void loadMeeting();
      }),
    [subscribe, meetingId, loadMeeting]
  );

  // Captions fade after a few seconds.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (phase !== "live") return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  function flash(text: string): void {
    setToast(text);
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 4_000);
  }

  /* ───────────── controls ───────────── */

  async function toggleMute(): Promise<void> {
    const next = !muted;
    setMuted(next);
    await joinedRef.current?.setMuted(next).catch(() => setMuted(!next));
  }

  async function toggleCamera(): Promise<void> {
    const next = !cameraOn;
    const ok = await joinedRef.current?.setCamera(next);
    if (ok) setCameraOn(next);
    else if (next) flash("The camera isn't available. Allow it in the browser.");
  }

  async function toggleShare(): Promise<void> {
    const next = !sharing;
    const ok = await joinedRef.current?.setScreenShare(next);
    if (ok) setSharing(next);
  }

  function toggleHand(): void {
    const raised = !handRef.current;
    handRef.current = raised;
    const me = joinedRef.current?.room.localParticipant.identity;
    if (me) {
      setHands((current) => {
        const next = new Set(current);
        if (raised) next.add(me);
        else next.delete(me);
        return next;
      });
    }
    void joinedRef.current?.send(MEETING_HAND_TOPIC, { raised });
  }

  function leave(): void {
    setMenu(null);
    // The host's session also sends Sibyl home (the notes are then finished).
    if (isHost) send({ type: REALTIME_EVENTS.LEAVE });
    const joined = joinedRef.current;
    joinedRef.current = null;
    void joined?.leave();
    setPhase("ended");
  }

  async function endForAll(): Promise<void> {
    setMenu(null);
    try {
      await meetingsApi.end(meetingId);
    } catch (reason) {
      flash(errorText(reason));
      return;
    }
    leave();
  }

  async function copy(text: string, label: string): Promise<void> {
    setMenu(null);
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    flash(label);
  }

  async function toggleRecording(): Promise<void> {
    const room = joinedRef.current?.room.name;
    try {
      if (recordingId) {
        await gatewayRequest(`/api/recordings/${encodeURIComponent(recordingId)}/stop`, { method: "POST" });
        setRecordingId(null);
      } else if (room) {
        const started = await gatewayRequest<{ id: string }>("/api/recordings", { method: "POST", body: { room } });
        setRecordingId(started.id);
        await meetingsApi.update(meetingId, { recordingId: started.id }).catch(() => undefined);
      }
    } catch (reason) {
      flash(errorText(reason));
    }
  }

  async function host<T>(work: () => Promise<T>): Promise<void> {
    try {
      await work();
      void loadMeeting();
    } catch (reason) {
      flash(errorText(reason));
    }
  }

  function createTask(actionId: string): void {
    if (!send({ type: MEETING_EVENTS.TASK, meetingId, actionId })) return flash("Not connected to Sibyl.");
    setPendingTasks((current) => new Set(current).add(actionId));
    flash("Approve the task in the approval card or your Inbox.");
  }

  /* ───────────── layout ───────────── */

  const participants = meeting?.participants ?? [];
  const colorFor = (identity: string) => speakerColor(colorOf(participants, identity));
  const main = useMemo(() => {
    const byKey = (key: string | null) => (key ? tiles.find((tile) => tile.key === key) : undefined);
    return (
      byKey(pinned) ??
      tiles.find((tile) => tile.screen) ??
      tiles.find((tile) => tile.identity === lastSpeaker.current && !tile.screen) ??
      tiles.find((tile) => !tile.local && tile.kind !== "agent") ??
      tiles.find((tile) => !tile.local) ??
      tiles[0]
    );
  }, [tiles, pinned]);
  const others = tiles.filter((tile) => tile !== main);
  const recent = captions.filter((caption) => Date.now() - caption.at < 9_000).slice(-3);
  const names = new Map(tiles.map((tile) => [tile.identity, tile.name]));
  const invitable = gateway.agents.agents.filter((agent) => !tiles.some((tile) => tile.agentId === agent.id));
  const memberLink = typeof window === "undefined" ? "" : `${window.location.origin}${paths.call(meetingId)}`;
  const guestLink = typeof window === "undefined" || !meeting?.guestPath ? "" : `${window.location.origin}${meeting.guestPath}`;

  if (!available && gateway.capabilities) {
    return (
      <div className={styles.prejoin}>
        <EmptyState title="Calls aren't set up on this Sibyl">
          <p>Meetings need the realtime layer (LiveKit). See docs/realtime.md to turn it on. Notes of past meetings are under Meetings.</p>
          <Link href={paths.meeting(meetingId)}>Open the meeting's notes</Link>
        </EmptyState>
      </div>
    );
  }

  if (phase === "prejoin" || (phase === "joining" && !isGuest)) {
    return (
      <PreJoin
        title={meeting?.title ?? "Meeting"}
        lead={meeting ? (meeting.isHost ? "You're the host. Sibyl joins with you and keeps the transcript." : `Hosted by ${meeting.hostName}.`) : "Loading the meeting…"}
        busy={phase === "joining" || !meeting || !connected}
        joinLabel={meeting?.isHost && meeting.status !== "live" ? "Start meeting" : "Join now"}
        error={error}
        onJoin={(choice) => void join(choice)}
      />
    );
  }

  if (phase === "error") {
    return (
      <div className={styles.prejoin}>
        <EmptyState title="Can't join this meeting">
          <p>{error}</p>
        </EmptyState>
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className={styles.prejoin}>
        <EmptyState icon={<Icon name="phoneOff" size={22} />} title="You left the meeting">
          {isGuest ? (
            <p>Thanks for joining.</p>
          ) : (
            <p>
              The notes, transcript and action items are on <Link href={paths.meeting(meetingId)}>the meeting's page</Link>.
            </p>
          )}
        </EmptyState>
      </div>
    );
  }

  const title = meeting?.title ?? guest?.title ?? "Meeting";
  return (
    <div className={styles.room}>
      <header className={styles.roomTop}>
        <div className={styles.roomTitle}>
          <strong>{title}</strong>
          {phase === "live" ? <span className={styles.liveBadge}>Live</span> : null}
          {recording ? <span className={styles.liveBadge}>Recording</span> : null}
        </div>
        {meeting?.notes ? (
          <span className={`${styles.badge} ${styles.hideNarrow}`}>
            <Icon name="sparkle" size={12} />
            Notes updated {new Date(meeting.notes.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        ) : null}
      </header>

      <div className={styles.roomBody}>
        <div className={styles.stage}>
          <div className={styles.mainTile}>{main ? <VideoTile tile={main} color={colorFor(main.identity)} hand={hands.has(main.identity)} large onPin={() => setPinned(pinned === main.key ? null : main.key)} pinned={pinned === main.key} /> : null}</div>
          {others.length > 0 ? (
            <div className={styles.filmstrip} aria-label="Everyone else">
              {others.map((tile) => (
                <VideoTile key={tile.key} tile={tile} color={colorFor(tile.identity)} hand={hands.has(tile.identity)} onPin={() => setPinned(tile.key)} pinned={false} />
              ))}
            </div>
          ) : null}
          {showCaptions && recent.length > 0 ? (
            <div className={styles.captions} aria-live="polite">
              {recent.map((caption) => (
                <p key={caption.id} className={styles.caption} style={{ ["--speaker" as string]: colorFor(caption.speaker) }}>
                  <strong>{caption.speakerName ?? names.get(caption.speaker) ?? (caption.speaker === "agent:sibyl" ? "Sibyl" : "Someone")}</strong>
                  {caption.text}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        {side ? (
          <aside className={styles.side} aria-label="Meeting panel">
            <div className={styles.sideHead}>
              <div className={styles.tabBar} role="tablist">
                {!isGuest ? (
                  <button type="button" role="tab" aria-selected={side === "notes"} onClick={() => setSide("notes")}>
                    AI notes
                  </button>
                ) : null}
                {!isGuest ? (
                  <button type="button" role="tab" aria-selected={side === "ask"} onClick={() => setSide("ask")}>
                    Ask AI
                  </button>
                ) : null}
                <button type="button" role="tab" aria-selected={side === "people"} onClick={() => setSide("people")}>
                  People{lobby.length > 0 ? <span className={styles.count}>{lobby.length}</span> : null}
                </button>
              </div>
              <Button size="sm" variant="ghost" iconOnly onClick={() => setSide(null)} aria-label="Close panel">
                <Icon name="close" size={16} />
              </Button>
            </div>
            <div className={styles.sideScroll}>
              {side === "notes" && meeting ? (
                <NotesPanel
                  meeting={meeting}
                  segments={segments}
                  tab={notesTab}
                  onTab={setNotesTab}
                  query={query}
                  onQuery={setQuery}
                  onCreateTask={createTask}
                  pendingTasks={pendingTasks}
                  onRefresh={() => void host(() => meetingsApi.refreshNotes(meetingId))}
                />
              ) : null}
              {side === "ask" && meeting ? (
                <AssistPanel
                  meeting={meeting}
                  segments={segments}
                  tabs={["ask", "keyword"]}
                  onKeyword={(word) => {
                    setQuery(word);
                    setNotesTab("transcript");
                    setSide("notes");
                  }}
                />
              ) : null}
              {side === "people" ? (
                <People
                  tiles={tiles}
                  lobby={lobby}
                  hands={hands}
                  isHost={isHost}
                  colorFor={colorFor}
                  onAdmit={(ticket, admit) => void host(async () => {
                    await meetingsApi.decide(meetingId, ticket, admit);
                    await loadLobby();
                  })}
                  onMute={(identity) => void host(() => meetingsApi.mute(meetingId, identity))}
                  onRemove={(identity) => void host(() => meetingsApi.removeParticipant(meetingId, identity))}
                  onRole={(agentId, role) => void host(() => meetingsApi.setAgent(meetingId, agentId, role))}
                />
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {toast ? (
        <div style={{ position: "fixed", left: "50%", bottom: 84, transform: "translateX(-50%)", zIndex: 40 }}>
          <Notice>{toast}</Notice>
        </div>
      ) : null}
      {error && phase === "live" ? (
        <div style={{ padding: "0 16px" }}>
          <Notice tone="warning">{error}</Notice>
        </div>
      ) : null}

      <footer className={styles.controls}>
        <div className={styles.controlGroup}>
          <Control icon={muted ? "micOff" : "mic"} label={muted ? "Turn microphone on" : "Turn microphone off"} off={muted} onClick={() => void toggleMute()} />
          <Control icon={cameraOn ? "video" : "videoOff"} label={cameraOn ? "Turn camera off" : "Turn camera on"} off={!cameraOn} onClick={() => void toggleCamera()} />
          <Control icon="screen" label={sharing ? "Stop presenting" : "Present your screen"} pressed={sharing} onClick={() => void toggleShare()} className={styles.hideNarrow} />
          <Control icon="captions" label={showCaptions ? "Hide captions" : "Show captions"} pressed={showCaptions} onClick={() => setShowCaptions((value) => !value)} />
          <Control icon="hand" label={handRef.current ? "Lower your hand" : "Raise your hand"} pressed={handRef.current} onClick={toggleHand} />
        </div>
        <div className={styles.controlGroup}>
          <Control icon="users" label="People" pressed={side === "people"} badge={isHost ? lobby.length : 0} onClick={() => setSide(side === "people" ? null : "people")} />
          {!isGuest ? <Control icon="sparkle" label="AI notes" pressed={side === "notes" || side === "ask"} onClick={() => setSide(side === "notes" ? null : "notes")} /> : null}
          {isHost ? <Control icon="userPlus" label="Add an agent" onClick={() => setAdding(true)} className={styles.hideNarrow} /> : null}
          {!isGuest ? (
            <span style={{ position: "relative" }}>
              <Control icon="link" label="Invite" pressed={menu === "invite"} onClick={() => setMenu(menu === "invite" ? null : "invite")} />
              {menu === "invite" ? (
                <div className={styles.menu} role="menu">
                  <button type="button" role="menuitem" onClick={() => void copy(memberLink, "Link copied: people in this workspace can join with it.")}>
                    Copy link for the workspace
                  </button>
                  {guestLink ? (
                    <button type="button" role="menuitem" onClick={() => void copy(guestLink, "Guest link copied: guests ask to join and you admit them.")}>
                      Copy guest link
                    </button>
                  ) : null}
                  {isHost ? (
                    <button type="button" role="menuitem" onClick={() => setAdding(true)}>
                      Add an agent…
                    </button>
                  ) : null}
                  {canRecord ? (
                    <button type="button" role="menuitem" onClick={() => void toggleRecording()}>
                      {recordingId ? "Stop recording" : "Record (audio)"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </span>
          ) : null}
        </div>
        <span style={{ position: "relative" }}>
          <button type="button" className={styles.leave} onClick={() => (isHost ? setMenu(menu === "leave" ? null : "leave") : leave())} aria-haspopup={isHost ? "menu" : undefined} aria-label="Leave" title="Leave">
            <Icon name="phoneOff" size={18} />
            <span className={styles.hideNarrow}>Leave</span>
          </button>
          {menu === "leave" ? (
            <div className={styles.menu} role="menu">
              <button type="button" role="menuitem" onClick={() => void endForAll()}>
                End meeting for everyone
              </button>
              <button type="button" role="menuitem" onClick={leave}>
                Leave (Sibyl leaves with you)
              </button>
            </div>
          ) : null}
        </span>
      </footer>

      {adding ? (
        <AddAgent
          agents={invitable}
          onClose={() => setAdding(false)}
          onAdd={(agentId, role) => {
            setAdding(false);
            void host(() => meetingsApi.setAgent(meetingId, agentId, role));
          }}
        />
      ) : null}
    </div>
  );
}

/* ───────────── pieces ───────────── */

function Control({ icon, label, onClick, pressed, off, badge = 0, className }: { icon: IconName; label: string; onClick(): void; pressed?: boolean; off?: boolean; badge?: number; className?: string }) {
  return (
    <button type="button" className={`${styles.ctl}${className ? ` ${className}` : ""}`} aria-label={label} title={label} aria-pressed={pressed} data-off={off || undefined} onClick={onClick}>
      <Icon name={icon} size={19} />
      {badge > 0 ? <span className={styles.ctlBadge}>{badge}</span> : null}
    </button>
  );
}

function VideoTile({ tile, color, hand, large = false, onPin, pinned }: { tile: TileModel; color: string; hand: boolean; large?: boolean; onPin(): void; pinned: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    const track = tile.video;
    if (!element || !track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [tile.video]);
  return (
    <div className={styles.tile} data-speaking={tile.speaking} style={{ ["--speaker" as string]: color }}>
      {tile.video ? (
        <video ref={ref} autoPlay playsInline muted data-mirror={tile.local && !tile.screen} data-fit={tile.screen ? "contain" : "cover"} />
      ) : tile.kind === "agent" ? (
        <span className={styles.agentFace}>{tile.avatar ? <AgentAvatar avatar={tile.avatar} mood={tile.speaking ? "speaking" : "listening"} size={large ? 112 : 52} /> : <Mark size={large ? 72 : 36} />}</span>
      ) : (
        <span className={styles.face}>{initials(tile.name)}</span>
      )}
      <button type="button" className={styles.tileHit} onClick={onPin} aria-label={pinned ? `Unpin ${tile.name}` : `Show ${tile.name} large`} />
      <span className={styles.tileBadges}>
        {tile.role === "notetaker" ? (
          <span className={styles.tileBadge}>
            <Icon name="notes" size={12} />
            Taking notes
          </span>
        ) : null}
        {tile.host ? <span className={styles.tileBadge}>Host</span> : null}
        {tile.kind === "guest" ? <span className={styles.tileBadge}>Guest</span> : null}
        {hand ? (
          <span className={styles.tileBadge}>
            <Icon name="hand" size={12} />
            Hand raised
          </span>
        ) : null}
        {pinned ? <span className={styles.tileBadge}>Pinned</span> : null}
      </span>
      <span className={styles.pill}>
        <span className={styles.dot} />
        <span>
          {tile.name}
          {tile.local && !tile.screen ? " (you)" : ""}
        </span>
        {tile.micOff ? <Icon name="micOff" size={13} /> : null}
      </span>
    </div>
  );
}

function People({
  tiles,
  lobby,
  hands,
  isHost,
  colorFor,
  onAdmit,
  onMute,
  onRemove,
  onRole
}: {
  tiles: TileModel[];
  lobby: MeetingLobbyEntryView[];
  hands: ReadonlySet<string>;
  isHost: boolean;
  colorFor(identity: string): string;
  onAdmit(ticket: string, admit: boolean): void;
  onMute(identity: string): void;
  onRemove(identity: string): void;
  onRole(agentId: string, role: MeetingAgentRoleView | null): void;
}) {
  const people = tiles.filter((tile) => !tile.screen && tile.kind !== "agent");
  const agents = tiles.filter((tile) => !tile.screen && tile.kind === "agent");
  return (
    <>
      {isHost && lobby.length > 0 ? (
        <>
          <p className={styles.groupLabel}>Asking to join</p>
          {lobby.map((entry) => (
            <div key={entry.ticket} className={styles.person}>
              <span className={styles.chipFace}>{initials(entry.name)}</span>
              <div>
                <strong>{entry.name}</strong>
                <span className={styles.small}>Guest</span>
              </div>
              <span className={styles.personActions}>
                <Button size="sm" variant="ghost" onClick={() => onAdmit(entry.ticket, false)}>
                  Deny
                </Button>
                <Button size="sm" variant="primary" onClick={() => onAdmit(entry.ticket, true)}>
                  Admit
                </Button>
              </span>
            </div>
          ))}
        </>
      ) : null}
      <p className={styles.groupLabel}>People · {people.length}</p>
      {people.map((tile) => (
        <div key={tile.key} className={styles.person}>
          <span className={styles.chipFace} style={{ ["--speaker" as string]: colorFor(tile.identity) }}>
            {initials(tile.name)}
          </span>
          <div>
            <strong>
              {tile.name}
              {tile.local ? " (you)" : ""}
            </strong>
            <span className={styles.small}>
              {[tile.host ? "Host" : tile.kind === "guest" ? "Guest" : "", hands.has(tile.identity) ? "Hand raised" : "", tile.micOff ? "Muted" : ""].filter(Boolean).join(" · ")}
            </span>
          </div>
          {isHost && !tile.local ? (
            <span className={styles.personActions}>
              {!tile.micOff ? (
                <Button size="sm" variant="ghost" iconOnly onClick={() => onMute(tile.identity)} aria-label={`Mute ${tile.name}`} title="Mute">
                  <Icon name="micOff" size={15} />
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" iconOnly onClick={() => onRemove(tile.identity)} aria-label={`Remove ${tile.name}`} title="Remove from the meeting">
                <Icon name="close" size={15} />
              </Button>
            </span>
          ) : null}
        </div>
      ))}
      <p className={styles.groupLabel}>Agents · {agents.length}</p>
      {agents.map((tile) => (
        <div key={tile.key} className={styles.person}>
          <span className={styles.personAvatar}>{tile.avatar ? <AgentAvatar avatar={tile.avatar} size={28} /> : <Mark size={22} />}</span>
          <div>
            <strong>{tile.name}</strong>
            <span className={styles.small}>{tile.role === "notetaker" ? "Silent note-taker" : "Speaks when addressed by name"}</span>
          </div>
          {isHost && tile.agentId ? (
            <span className={styles.personActions}>
              <select aria-label={`${tile.name}'s role`} value={tile.role ?? "participant"} onChange={(event) => onRole(tile.agentId!, event.target.value as MeetingAgentRoleView)}>
                <option value="participant">Participant</option>
                <option value="notetaker">Note-taker</option>
              </select>
              {tile.agentId !== "sibyl" ? (
                <Button size="sm" variant="ghost" iconOnly onClick={() => onRole(tile.agentId!, null)} aria-label={`Remove ${tile.name}`} title="Remove from the meeting">
                  <Icon name="close" size={15} />
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

function AddAgent({ agents, onClose, onAdd }: { agents: Array<{ id: string; name: string }>; onClose(): void; onAdd(agentId: string, role: MeetingAgentRoleView): void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [role, setRole] = useState<MeetingAgentRoleView>("participant");
  return (
    <Dialog
      title="Add an agent"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (agentId) onAdd(agentId, role);
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!agentId}>
            Add
          </Button>
        </>
      }
    >
      {agents.length === 0 ? (
        <p className={styles.muted}>All your agents are already here. Create more under Agents.</p>
      ) : (
        <div className={styles.formGrid}>
          <Field label="Agent">
            <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role" hint={role === "notetaker" ? "Listens and keeps the notes; never speaks." : "Speaks when someone says its name (or you hand it the floor)."}>
            <Select value={role} onChange={(event) => setRole(event.target.value as MeetingAgentRoleView)}>
              <option value="participant">Participant</option>
              <option value="notetaker">Silent note-taker</option>
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function tileOf(participant: Participant, local: boolean): TileModel {
  const kind = participantKind(participant);
  const attributes = participant.attributes ?? {};
  let avatar: AgentAvatarView | undefined;
  try {
    avatar = attributes["sibyl.avatar"] ? (normalizeAvatar(JSON.parse(attributes["sibyl.avatar"])) as AgentAvatarView) : undefined;
  } catch {
    avatar = undefined;
  }
  const role = attributes["sibyl.role"] === "notetaker" ? "notetaker" : attributes["sibyl.role"] === "participant" ? "participant" : undefined;
  return {
    key: participant.identity,
    identity: participant.identity,
    name: participant.name || (kind === "phone" ? "Phone" : participant.identity),
    kind,
    local,
    speaking: participant.isSpeaking,
    micOff: kind !== "agent" && !participant.isMicrophoneEnabled,
    screen: false,
    host: attributes["sibyl.host"] === "1",
    ...(attributes["sibyl.agent"] ? { agentId: attributes["sibyl.agent"] } : {}),
    ...(avatar ? { avatar } : {}),
    ...(role ? { role } : kind === "agent" ? { role: "participant" as const } : {})
  };
}
