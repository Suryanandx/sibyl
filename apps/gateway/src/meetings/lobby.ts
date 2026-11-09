/**
 * The guest lobby: people without an account open the guest link
 * (/join/<id>?k=…), give a name and knock; the host admits or denies them.
 * A room token is minted only after admission.
 *
 * Kept in memory: a knock lives while someone waits in front of the door
 * (15 minutes); a gateway restart empties the lobby and guests knock again.
 */
import { randomBytes } from "node:crypto";

export const LOBBY_WAIT_MS = 15 * 60 * 1000;
/** People waiting at once per meeting (more get "the lobby is full"). */
export const LOBBY_MAX_WAITING = 20;
/** Knocks per meeting per minute (a guest link pasted somewhere public can't flood the host). */
export const LOBBY_KNOCKS_PER_MINUTE = 12;

export type KnockStatus = "waiting" | "admitted" | "denied";

export interface Knock {
  ticket: string;
  /** Guest id (identity guest:<id>). */
  guestId: string;
  name: string;
  at: number;
  status: KnockStatus;
}

export class LobbyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export class Lobby {
  private readonly meetings = new Map<string, Map<string, Knock>>();
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  knock(meetingId: string, rawName: string): Knock {
    const name = cleanName(rawName);
    if (!name) throw new LobbyError("Enter your name to ask to join.");
    const now = this.now();
    const hits = (this.recent.get(meetingId) ?? []).filter((at) => now - at < 60_000);
    if (hits.length >= LOBBY_KNOCKS_PER_MINUTE) throw new LobbyError("Too many people are asking to join right now. Try again in a minute.", 429);
    hits.push(now);
    this.recent.set(meetingId, hits);
    const knocks = this.prune(meetingId);
    if ([...knocks.values()].filter((knock) => knock.status === "waiting").length >= LOBBY_MAX_WAITING) {
      throw new LobbyError("The lobby is full. Try again in a few minutes.", 429);
    }
    const knock: Knock = { ticket: randomBytes(18).toString("base64url"), guestId: randomBytes(9).toString("base64url"), name, at: now, status: "waiting" };
    knocks.set(knock.ticket, knock);
    this.meetings.set(meetingId, knocks);
    return { ...knock };
  }

  get(meetingId: string, ticket: string): Knock | undefined {
    const knock = this.prune(meetingId).get(ticket);
    return knock ? { ...knock } : undefined;
  }

  waiting(meetingId: string): Knock[] {
    return [...this.prune(meetingId).values()].filter((knock) => knock.status === "waiting").map((knock) => ({ ...knock }));
  }

  decide(meetingId: string, ticket: string, admit: boolean): Knock | undefined {
    const knock = this.prune(meetingId).get(ticket);
    if (!knock || knock.status !== "waiting") return undefined;
    knock.status = admit ? "admitted" : "denied";
    return { ...knock };
  }

  /** The meeting ended: nobody else gets in. */
  close(meetingId: string): void {
    this.meetings.delete(meetingId);
    this.recent.delete(meetingId);
  }

  private prune(meetingId: string): Map<string, Knock> {
    const knocks = this.meetings.get(meetingId) ?? new Map<string, Knock>();
    const now = this.now();
    for (const [ticket, knock] of knocks) if (now - knock.at > LOBBY_WAIT_MS) knocks.delete(ticket);
    if (knocks.size === 0) this.meetings.delete(meetingId);
    return knocks;
  }
}

/** A display name: no control characters, no brackets (they'd look like a role), at most 60 characters. */
export function cleanName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f<>[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
