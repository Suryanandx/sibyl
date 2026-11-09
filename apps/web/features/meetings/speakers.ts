/**
 * Speaker colours: slot n → the `--speaker-<n+1>` design token (globals.css,
 * light and dark). The gateway assigns each participant a slot as they join.
 */
export const MEETING_SPEAKER_SLOTS = 6;

export function speakerColor(slot: number): string {
  return `var(--speaker-${(((slot % MEETING_SPEAKER_SLOTS) + MEETING_SPEAKER_SLOTS) % MEETING_SPEAKER_SLOTS) + 1})`;
}

/** "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const parts = name.replace(/^(user|guest):/, "").split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** 0:00 / 12:34 / 1:02:03 */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(hours > 0 ? 2 : 1, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

/** Words worth searching for in a transcript: the most frequent non-trivial words. */
export function keywordsOf(texts: readonly string[], limit = 12): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const raw of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'-]{3,}/gu) ?? []) {
      const word = raw.replace(/'s$/, "");
      if (STOP.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

const STOP = new Set(
  "about above after again also always another because been before being below between both could does doing down during each even every from further have having here into just like make many more most much must need only other over really right same should some such than that their them then there these they thing things think this those through very want were what when where which while will with would your yeah okay sure going know just well also still maybe something actually basically gonna kind sort mean said says lets let's that's it's we're you're they're i'm don't can't won't didn't".split(
    " "
  )
);
