/**
 * The guest lobby: people without an account open the guest link
 * (/join/<id>?k=…), give a name and knock; the host admits or denies them.
 * A room token is minted only after admission.
 *
 * Knocks are kept on the meeting record (MeetingRecord.lobby), so a gateway
 * restart doesn't drop the people waiting or the ones already admitted. A
 * knock lives 15 minutes. These helpers are pure: the meeting service stores
 * what they return. Only the flood limit is in memory.
 */
import { randomBytes } from "node:crypto";
import type { MeetingKnock } from "@open-gpt-live/core";

export const LOBBY_WAIT_MS = 15 * 60 * 1000;
/** People waiting at once per meeting (more get "the lobby is full"). */
export const LOBBY_MAX_WAITING = 20;
/** Knocks per meeting per minute (a guest link pasted somewhere public can't flood the host). */
export const LOBBY_KNOCKS_PER_MINUTE = 12;

export type Knock = MeetingKnock;

export class LobbyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Knocks still current (younger than LOBBY_WAIT_MS). */
export function currentKnocks(knocks: readonly Knock[] | undefined, now: number): Knock[] {
  return (knocks ?? []).filter((knock) => now - knock.at <= LOBBY_WAIT_MS);
}

/** A new knock added to the (pruned) list. */
export function addKnock(knocks: readonly Knock[] | undefined, rawName: string, now: number): { knocks: Knock[]; knock: Knock } {
  const name = cleanName(rawName);
  if (!name) throw new LobbyError("Enter your name to ask to join.");
  const current = currentKnocks(knocks, now);
  if (current.filter((knock) => knock.status === "waiting").length >= LOBBY_MAX_WAITING) {
    throw new LobbyError("The lobby is full. Try again in a few minutes.", 429);
  }
  const knock: Knock = { ticket: randomBytes(18).toString("base64url"), guestId: randomBytes(9).toString("base64url"), name, at: now, status: "waiting" };
  return { knocks: [...current, knock], knock };
}

/** The host's decision on a waiting knock (undefined: no such waiting knock). */
export function decideKnock(knocks: readonly Knock[] | undefined, ticket: string, admit: boolean, now: number): { knocks: Knock[]; knock: Knock } | undefined {
  const current = currentKnocks(knocks, now);
  const found = current.find((knock) => knock.ticket === ticket && knock.status === "waiting");
  if (!found) return undefined;
  const knock: Knock = { ...found, status: admit ? "admitted" : "denied" };
  return { knocks: current.map((item) => (item === found ? knock : item)), knock };
}

/** Flood limit per meeting (in memory: a restart only resets the count). */
export class KnockLimiter {
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  check(meetingId: string): void {
    const now = this.now();
    const hits = (this.recent.get(meetingId) ?? []).filter((at) => now - at < 60_000);
    if (hits.length >= LOBBY_KNOCKS_PER_MINUTE) throw new LobbyError("Too many people are asking to join right now. Try again in a minute.", 429);
    hits.push(now);
    this.recent.set(meetingId, hits);
  }

  forget(meetingId: string): void {
    this.recent.delete(meetingId);
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
