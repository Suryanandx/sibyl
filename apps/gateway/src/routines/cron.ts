/**
 * Minimal 5-field cron with time zones (no dependency).
 *
 *   minute hour day-of-month month day-of-week
 *
 * Supports `*`, lists (`1,15`), ranges (`1-5`), steps (`*\/15`, `9-17/2`),
 * month and weekday names (`jan`, `mon-fri`), 7 = Sunday, and the macros
 * @hourly @daily @weekly @monthly @yearly. Day-of-month and day-of-week follow
 * Vixie cron: when both are restricted, either one matching is enough.
 *
 * Times are wall-clock times in the routine's IANA time zone. Around DST:
 * - a time that does not exist (spring forward, e.g. 02:30) runs right after
 *   the gap (03:30 wall clock), so a daily job never silently skips a day;
 * - a time that happens twice (fall back, e.g. 01:30) runs once, on its first
 *   occurrence.
 */

export interface CronSchedule {
  source: string;
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Field was `*` (matters for the day-of-month / day-of-week rule). */
  anyDay: boolean;
  anyWeekday: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *"
};
/** Searching further than this means the expression (practically) never fires. */
const MAX_SEARCH_DAYS = 366 * 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export class CronError extends Error {}

export function parseCron(expression: string): CronSchedule {
  const source = expression.trim().replace(/\s+/g, " ");
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const fields = expanded.split(" ");
  if (fields.length !== 5) {
    throw new CronError(`A schedule needs 5 fields (minute hour day month weekday), got ${fields.length}: "${expression}"`);
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = parseField(weekday, 0, 7, WEEKDAYS, "weekday");
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    source,
    minutes: [...parseField(minute, 0, 59, undefined, "minute")].sort((a, b) => a - b),
    hours: [...parseField(hour, 0, 23, undefined, "hour")].sort((a, b) => a - b),
    days: parseField(day, 1, 31, undefined, "day of month"),
    months: parseField(month, 1, 12, MONTHS, "month"),
    weekdays,
    anyDay: day === "*" || day === "?",
    anyWeekday: weekday === "*" || weekday === "?"
  };
}

function parseField(field: string, min: number, max: number, names: string[] | undefined, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronError(`Invalid ${label}: "${part}"`);
    const [, range, stepText] = match as unknown as [string, string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Invalid ${label} step: "${part}"`);
    let from: number;
    let to: number;
    if (range === "*" || range === "?") {
      from = min;
      to = max;
    } else {
      const bounds = range.split("-");
      if (bounds.length > 2) throw new CronError(`Invalid ${label} range: "${part}"`);
      from = value(bounds[0]!, names, label, min);
      to = bounds.length === 2 ? value(bounds[1]!, names, label, min) : stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) throw new CronError(`${label} out of range (${min}-${max}): "${part}"`);
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

function value(text: string, names: string[] | undefined, label: string, min: number): number {
  const lower = text.toLowerCase();
  if (names) {
    const index = names.indexOf(lower.slice(0, 3));
    if (index >= 0 && /^[a-z]+$/.test(lower)) return index + (min === 1 ? 1 : 0);
  }
  if (!/^\d+$/.test(text)) throw new CronError(`Invalid ${label}: "${text}"`);
  return Number(text);
}

/** True for an IANA zone the runtime knows ("Europe/Berlin", "UTC"). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Throws a CronError explaining what is wrong; returns the parsed schedule. */
export function validateSchedule(cron: string, timeZone: string, now = Date.now()): CronSchedule {
  if (!isValidTimeZone(timeZone)) throw new CronError(`Unknown time zone: "${timeZone}"`);
  const schedule = parseCron(cron);
  if (nextRun(schedule, timeZone, now) === undefined) {
    throw new CronError(`The schedule "${cron}" never runs`);
  }
  return schedule;
}

/** Next run strictly after `after` (epoch ms), or undefined if none within 5 years. */
export function nextRun(schedule: CronSchedule | string, timeZone: string, after: number): number | undefined {
  const cron = typeof schedule === "string" ? parseCron(schedule) : schedule;
  const zone = zoneFor(timeZone);
  const start = zone.wall(after);
  // Iterate local calendar days (as UTC dates, so no DST in the arithmetic).
  let dayUtc = Date.UTC(start.year, start.month - 1, start.day);
  const startWall = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute);
  for (let i = 0; i < MAX_SEARCH_DAYS; i += 1, dayUtc += DAY_MS) {
    const date = new Date(dayUtc);
    const month = date.getUTCMonth() + 1;
    if (!cron.months.has(month)) continue;
    if (!dayMatches(cron, date.getUTCDate(), date.getUTCDay())) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const wall = dayUtc + hour * HOUR_MS + minute * MINUTE_MS;
        // Skip wall times clearly before `after` (3 h slack covers any DST shift).
        if (wall < startWall - 3 * HOUR_MS) continue;
        const instant = zone.toInstant(wall);
        if (instant > after) return instant;
      }
    }
  }
  return undefined;
}

function dayMatches(cron: CronSchedule, day: number, weekday: number): boolean {
  const domOk = cron.days.has(day);
  const dowOk = cron.weekdays.has(weekday);
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return dowOk;
  if (cron.anyWeekday) return domOk;
  return domOk || dowOk;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface Zone {
  wall(instant: number): Wall;
  /** Wall-clock time (encoded as a UTC timestamp) → real instant. */
  toInstant(wallUtc: number): number;
}

const zones = new Map<string, Zone>();

function zoneFor(timeZone: string): Zone {
  const cached = zones.get(timeZone);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric"
  });
  const parts = (instant: number): Wall & { second: number } => {
    const out: Record<string, number> = {};
    for (const part of format.formatToParts(new Date(instant))) {
      if (part.type !== "literal") out[part.type] = Number(part.value);
    }
    return {
      year: out.year!,
      month: out.month!,
      day: out.day!,
      hour: out.hour === 24 ? 0 : out.hour!,
      minute: out.minute!,
      second: out.second!
    };
  };
  /** Wall clock minus UTC at an instant, in ms. */
  const offset = (instant: number): number => {
    const p = parts(instant);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(instant / 1000) * 1000;
  };
  const sameWall = (instant: number, wallUtc: number): boolean => {
    const p = parts(instant);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wallUtc;
  };
  const zone: Zone = {
    wall: (instant) => parts(instant),
    toInstant(wallUtc) {
      const before = offset(wallUtc - 12 * HOUR_MS);
      const after = offset(wallUtc + 12 * HOUR_MS);
      const candidates = [wallUtc - before, wallUtc - after].filter((instant) => sameWall(instant, wallUtc));
      if (candidates.length > 0) return Math.min(...candidates);
      // Inside a spring-forward gap: the offset before the gap lands just after it.
      return wallUtc - before;
    }
  };
  zones.set(timeZone, zone);
  return zone;
}

/** The schedule in plain words, e.g. "every weekday at 08:00 (Europe/Berlin)". */
export function describeSchedule(cron: string, timeZone: string): string {
  let schedule: CronSchedule;
  try {
    schedule = parseCron(cron);
  } catch {
    return `on the schedule "${cron}" (${timeZone})`;
  }
  return `${describe(schedule)} (${timeZone})`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function describe(cron: CronSchedule): string {
  const allMinutes = cron.minutes.length === 60;
  const allHours = cron.hours.length === 24;
  const allMonths = cron.months.size === 12;
  if (allMinutes && allHours) return withDays(cron, "every minute", allMonths);

  let time: string;
  if (allHours && cron.minutes.length === 1) {
    time = cron.minutes[0] === 0 ? "every hour" : `every hour at :${pad(cron.minutes[0]!)}`;
  } else if (allHours) {
    const step = evenStep(cron.minutes, 60);
    time = step ? `every ${step} minutes` : `every hour at minutes ${cron.minutes.join(", ")}`;
  } else if (cron.minutes.length * cron.hours.length <= 4) {
    const times = cron.hours.flatMap((h) => cron.minutes.map((m) => `${pad(h)}:${pad(m)}`));
    time = `at ${joinWords(times)}`;
  } else {
    const step = evenStep(cron.hours, 24);
    const minutes = cron.minutes.length === 1 ? `minute ${pad(cron.minutes[0]!)}` : `minutes ${cron.minutes.join(", ")}`;
    time = step ? `every ${step} hours at ${minutes}` : `at hours ${cron.hours.join(", ")}, ${minutes}`;
  }
  return withDays(cron, time, allMonths);
}

function withDays(cron: CronSchedule, time: string, allMonths: boolean): string {
  let days = "";
  if (cron.anyDay && cron.anyWeekday) days = "every day";
  else if (cron.anyDay) days = weekdayWords(cron.weekdays);
  else if (cron.anyWeekday) days = `on day ${[...cron.days].sort((a, b) => a - b).join(", ")} of the month`;
  else days = `on day ${[...cron.days].sort((a, b) => a - b).join(", ")} of the month or ${weekdayWords(cron.weekdays).replace(/^every /, "every ")}`;
  const months = allMonths ? "" : ` in ${joinWords([...cron.months].sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1]!))}`;
  if (time.startsWith("every") && days === "every day") return `${time}${months}`;
  return `${days} ${time}${months}`;
}

function weekdayWords(weekdays: Set<number>): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "every weekday";
  if (key === "0,6") return "every weekend day";
  if (sorted.length === 7) return "every day";
  return `every ${joinWords(sorted.map((d) => DAY_NAMES[d]!))}`;
}

function evenStep(values: number[], size: number): number | undefined {
  if (values.length < 2 || values[0] !== 0) return undefined;
  const step = values[1]! - values[0]!;
  if (size % step !== 0 || values.length !== size / step) return undefined;
  return values.every((v, i) => v === i * step) ? step : undefined;
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
