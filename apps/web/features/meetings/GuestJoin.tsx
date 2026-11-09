"use client";

/**
 * The guest link (/join/<id>?k=…): for people without an account. They check
 * their camera and microphone, give a name and ask to join; the host admits
 * or denies them from the room. The room token arrives only after admission.
 * People signed in to the meeting's workspace are sent to the room itself.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "../../components/ui";
import { useAuthState } from "../../lib/app-session";
import { errorText } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import { meetingsApi } from "./api";
import { MeetingRoom, type GuestGrant } from "./MeetingRoom";
import { PreJoin, type JoinChoice } from "./PreJoin";
import styles from "./meetings.module.css";

type Step = { kind: "loading" } | { kind: "prejoin" } | { kind: "waiting"; ticket: string } | { kind: "denied" } | { kind: "ended" } | { kind: "room"; grant: GuestGrant } | { kind: "invalid"; message: string };

export function GuestJoin({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const auth = useAuthState();
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("Meeting");
  const [host, setHost] = useState("");
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choice = useRef<JoinChoice | null>(null);

  // A member of the workspace who can open the meeting goes straight to the room.
  useEffect(() => {
    if (auth.status !== "ready" || !auth.me?.authenticated) return;
    meetingsApi
      .get(meetingId)
      .then(() => router.replace(paths.call(meetingId)))
      .catch(() => undefined);
  }, [auth.status, auth.me?.authenticated, meetingId, router]);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("k") ?? "";
    setKey(value);
    meetingsApi
      .preview(meetingId, value)
      .then((preview) => {
        setTitle(preview.title);
        setHost(preview.hostName);
        setStep(preview.status === "ended" ? { kind: "ended" } : { kind: "prejoin" });
      })
      .catch((reason) => setStep({ kind: "invalid", message: errorText(reason) }));
  }, [meetingId]);

  // Waiting in the lobby: ask every 2 seconds.
  useEffect(() => {
    if (step.kind !== "waiting") return;
    let stopped = false;
    const poll = async () => {
      try {
        const status = await meetingsApi.lobbyStatus(meetingId, step.ticket);
        if (stopped) return;
        if (status.status === "admitted" && status.grant) setStep({ kind: "room", grant: status.grant });
        else if (status.status === "denied") setStep({ kind: "denied" });
        else if (status.status === "ended") setStep({ kind: "ended" });
        else window.setTimeout(() => void poll(), 2_000);
      } catch (reason) {
        if (!stopped) setStep({ kind: "invalid", message: errorText(reason) });
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [step, meetingId]);

  async function knock(next: JoinChoice): Promise<void> {
    choice.current = next;
    setBusy(true);
    setError(null);
    try {
      const { ticket } = await meetingsApi.knock(meetingId, key, next.name);
      setStep({ kind: "waiting", ticket });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === "room" && choice.current) {
    return <MeetingRoom meetingId={meetingId} guest={{ grant: step.grant, title, choice: choice.current }} />;
  }
  if (step.kind === "prejoin") {
    return (
      <PreJoin
        title={title}
        lead={host ? `Hosted by ${host}. The host lets you in.` : "The host lets you in."}
        askName
        joinLabel="Ask to join"
        busy={busy}
        error={error}
        onJoin={(next) => void knock(next)}
      />
    );
  }
  const message =
    step.kind === "loading"
      ? { title: "Opening the meeting…", text: "" }
      : step.kind === "waiting"
        ? { title: "Asking to join…", text: "You'll join as soon as the host lets you in." }
        : step.kind === "denied"
          ? { title: "The host didn't let you in", text: "You can close this page." }
          : step.kind === "ended"
            ? { title: "This meeting has ended", text: "" }
            : { title: "This link doesn't work", text: step.kind === "invalid" ? step.message : "" };
  return (
    <div className={styles.prejoin}>
      <EmptyState title={message.title}>{message.text ? <p>{message.text}</p> : null}</EmptyState>
    </div>
  );
}
