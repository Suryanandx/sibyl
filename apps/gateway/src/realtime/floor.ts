/**
 * Group-call etiquette (docs/plans/livekit.md, decision 6): agents listen as
 * note-takers and speak only when
 *
 * - addressed by name ("Sibyl, …", "… what do you think, Nova?", "@Nova"),
 * - the host handed them the floor, or
 * - the same person follows up within a few seconds of the agent's reply.
 *
 * Pure logic: the room agent asks `decide()` with the transcript of each
 * finished utterance.
 */

/** An agent that may be addressed: "sibyl" or an agent id. */
export interface FloorCandidate {
  id: string;
  name: string;
}

export interface FloorState {
  /** Handed the floor by the host (until taken back or given to someone else). */
  holder?: string;
  /** The last reply: who it answered, which agent spoke, and when. */
  lastReply?: { speaker: string; agent: string; at: number };
}

/** A follow-up without a name within this window goes to the agent that just replied. */
export const FOLLOW_UP_WINDOW_MS = 8_000;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9@\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How a word sounds, roughly: speech-to-text writes "Sybil", "Cybil" or "Sibel" for "Sibyl". */
function soundKey(word: string): string {
  return word
    .replace(/^@/, "")
    .replace(/c(?=[iey])/g, "s")
    .replace(/ph/g, "f")
    .replace(/ck|c|q/g, "k")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
}

/** Same length, one vowel heard differently ("sibel" for "sibil"). */
function oneVowelOff(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const differences = [...a].map((char, index) => [char, b[index]!] as const).filter(([x, y]) => x !== y);
  return differences.length === 1 && /[aeiou]/.test(differences[0]![0]) && /[aeiou]/.test(differences[0]![1]);
}

/** The same name as heard: equal, sounds the same, or (5+ letters) one vowel off. */
function sameName(heard: string, name: string): boolean {
  if (heard.replace(/^@/, "") === name) return true;
  const a = soundKey(heard);
  const b = soundKey(name);
  return a === b || (b.length >= 5 && oneVowelOff(a, b));
}

/** The candidate called by name: "@name" anywhere, or the name among the first four or last three words. */
export function addressedCandidate(text: string, candidates: readonly FloorCandidate[]): FloorCandidate | undefined {
  const words = normalize(text).split(" ").filter(Boolean);
  if (words.length === 0) return undefined;
  let best: { candidate: FloorCandidate; at: number } | undefined;
  for (const candidate of candidates) {
    const name = normalize(candidate.name).split(" ").filter(Boolean);
    if (name.length === 0) continue;
    for (let index = 0; index + name.length <= words.length; index += 1) {
      const mention = words[index]!.startsWith("@");
      if (!name.every((part, offset) => sameName(words[index + offset]!, part))) continue;
      const end = index + name.length;
      if (mention || index < 4 || end > words.length - 3) {
        if (!best || index < best.at) best = { candidate, at: index };
        break;
      }
    }
  }
  return best?.candidate;
}

/** Who answers this utterance (a candidate id), or undefined: it is only a note. */
export function decide(input: {
  text: string;
  speaker: string;
  now: number;
  state: FloorState;
  candidates: readonly FloorCandidate[];
}): string | undefined {
  const named = addressedCandidate(input.text, input.candidates);
  if (named) return named.id;
  if (input.state.holder && input.candidates.some((candidate) => candidate.id === input.state.holder)) return input.state.holder;
  const last = input.state.lastReply;
  if (last && last.speaker === input.speaker && input.now - last.at <= FOLLOW_UP_WINDOW_MS) return last.agent;
  return undefined;
}
