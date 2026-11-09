/**
 * `world_time`: current (or a given) time across time zones, computed locally
 * with Intl — no network.
 */
import type { ToolDefinition } from "@open-gpt-live/core";

/** Common place names → IANA zones (lower-case keys). Unlisted cities fall back to IANA city matching. */
const CITY_ZONES: Record<string, string> = {
  utc: "UTC", gmt: "UTC", zulu: "UTC",
  // North America
  "new york": "America/New_York", nyc: "America/New_York", "new york city": "America/New_York", boston: "America/New_York",
  washington: "America/New_York", "washington dc": "America/New_York", miami: "America/New_York", atlanta: "America/New_York",
  philadelphia: "America/New_York", toronto: "America/Toronto", montreal: "America/Toronto", ottawa: "America/Toronto",
  chicago: "America/Chicago", dallas: "America/Chicago", houston: "America/Chicago", austin: "America/Chicago",
  "mexico city": "America/Mexico_City", denver: "America/Denver", phoenix: "America/Phoenix", "salt lake city": "America/Denver",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles", "san francisco": "America/Los_Angeles", sf: "America/Los_Angeles",
  seattle: "America/Los_Angeles", "san diego": "America/Los_Angeles", "las vegas": "America/Los_Angeles", portland: "America/Los_Angeles",
  vancouver: "America/Vancouver", calgary: "America/Edmonton", anchorage: "America/Anchorage", honolulu: "Pacific/Honolulu", hawaii: "Pacific/Honolulu",
  // South America
  "sao paulo": "America/Sao_Paulo", "são paulo": "America/Sao_Paulo", rio: "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires", santiago: "America/Santiago", lima: "America/Lima", bogota: "America/Bogota",
  "bogotá": "America/Bogota", caracas: "America/Caracas",
  // Europe
  london: "Europe/London", uk: "Europe/London", edinburgh: "Europe/London", dublin: "Europe/Dublin", lisbon: "Europe/Lisbon",
  paris: "Europe/Paris", berlin: "Europe/Berlin", munich: "Europe/Berlin", frankfurt: "Europe/Berlin", hamburg: "Europe/Berlin",
  madrid: "Europe/Madrid", barcelona: "Europe/Madrid", rome: "Europe/Rome", milan: "Europe/Rome", amsterdam: "Europe/Amsterdam",
  brussels: "Europe/Brussels", zurich: "Europe/Zurich", geneva: "Europe/Zurich", vienna: "Europe/Vienna", prague: "Europe/Prague",
  warsaw: "Europe/Warsaw", stockholm: "Europe/Stockholm", oslo: "Europe/Oslo", copenhagen: "Europe/Copenhagen", helsinki: "Europe/Helsinki",
  athens: "Europe/Athens", istanbul: "Europe/Istanbul", kyiv: "Europe/Kyiv", kiev: "Europe/Kyiv", moscow: "Europe/Moscow",
  "st petersburg": "Europe/Moscow", budapest: "Europe/Budapest", bucharest: "Europe/Bucharest",
  // Africa & Middle East
  cairo: "Africa/Cairo", lagos: "Africa/Lagos", nairobi: "Africa/Nairobi", johannesburg: "Africa/Johannesburg", "cape town": "Africa/Johannesburg",
  casablanca: "Africa/Casablanca", dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai", doha: "Asia/Qatar", riyadh: "Asia/Riyadh",
  "tel aviv": "Asia/Jerusalem", jerusalem: "Asia/Jerusalem", tehran: "Asia/Tehran",
  // Asia & Oceania
  karachi: "Asia/Karachi", delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", mumbai: "Asia/Kolkata", bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata", kolkata: "Asia/Kolkata", chennai: "Asia/Kolkata", india: "Asia/Kolkata", kathmandu: "Asia/Kathmandu",
  dhaka: "Asia/Dhaka", bangkok: "Asia/Bangkok", jakarta: "Asia/Jakarta", "ho chi minh city": "Asia/Ho_Chi_Minh", hanoi: "Asia/Ho_Chi_Minh",
  singapore: "Asia/Singapore", "kuala lumpur": "Asia/Kuala_Lumpur", manila: "Asia/Manila", "hong kong": "Asia/Hong_Kong",
  beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai", shenzhen: "Asia/Shanghai", guangzhou: "Asia/Shanghai", china: "Asia/Shanghai",
  taipei: "Asia/Taipei", seoul: "Asia/Seoul", tokyo: "Asia/Tokyo", osaka: "Asia/Tokyo", japan: "Asia/Tokyo",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", brisbane: "Australia/Brisbane", perth: "Australia/Perth",
  adelaide: "Australia/Adelaide", auckland: "Pacific/Auckland", wellington: "Pacific/Auckland",
  // Abbreviations (representative zones; DST is applied by the zone)
  est: "America/New_York", edt: "America/New_York", et: "America/New_York", eastern: "America/New_York",
  cst: "America/Chicago", cdt: "America/Chicago", ct: "America/Chicago", central: "America/Chicago",
  mst: "America/Denver", mdt: "America/Denver", mt: "America/Denver", mountain: "America/Denver",
  pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  bst: "Europe/London", cet: "Europe/Paris", cest: "Europe/Paris", eet: "Europe/Athens", ist: "Asia/Kolkata",
  jst: "Asia/Tokyo", kst: "Asia/Seoul", aest: "Australia/Sydney", aedt: "Australia/Sydney", sgt: "Asia/Singapore", hkt: "Asia/Hong_Kong"
};

let ianaIndex: Map<string, string> | undefined;

function supportedZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? [];
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a city, abbreviation or IANA name to an IANA zone. */
export function resolveTimeZone(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  const key = raw.toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ");
  if (CITY_ZONES[key]) return CITY_ZONES[key];
  // "Paris, France" → "paris"
  const head = key.split(",")[0]!.trim();
  if (CITY_ZONES[head]) return CITY_ZONES[head];
  if (raw.includes("/") || /^(utc|gmt|etc)/i.test(raw)) {
    const fixed = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(raw);
    if (fixed) {
      const [, sign, hours, minutes] = fixed;
      const zone = `${sign}${hours!.padStart(2, "0")}:${minutes ?? "00"}`;
      if (isValidZone(zone)) return zone;
    }
    if (isValidZone(raw)) return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  }
  if (!ianaIndex) {
    ianaIndex = new Map();
    for (const zone of supportedZones()) {
      const city = zone.split("/").pop()!.replace(/_/g, " ").toLowerCase();
      if (!ianaIndex.has(city)) ianaIndex.set(city, zone);
    }
  }
  return ianaIndex.get(head);
}

/** Offset of `zone` at `instant`, in minutes east of UTC. */
export function zoneOffsetMinutes(zone: string, instant: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** The instant when the wall clock in `zone` shows the given local date/time. */
export function zonedTimeToInstant(
  zone: string,
  parts: { year: number; month: number; day: number; hour: number; minute: number }
): Date {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = asUtc - zoneOffsetMinutes(zone, new Date(asUtc)) * 60_000;
  // Second pass settles DST transitions.
  guess = asUtc - zoneOffsetMinutes(zone, new Date(guess)) * 60_000;
  return new Date(guess);
}

function localParts(zone: string, instant: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function formatDiff(minutes: number): string {
  if (minutes === 0) return "same time";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  const amount = `${hours ? `${hours}h` : ""}${rest ? `${rest}m` : ""}`;
  return `${amount} ${minutes > 0 ? "ahead" : "behind"}`;
}

export interface WorldTimeEntry {
  input: string;
  timeZone: string;
  local: string;
  iso: string;
  utcOffset: string;
  /** Minutes ahead of the first location. */
  diffMinutes: number;
}

export interface WorldTimeInput {
  locations: string[];
  time?: string;
  date?: string;
}

export function createWorldTimeTool(now: () => Date = () => new Date()): ToolDefinition<WorldTimeInput, { instant: string; entries: WorldTimeEntry[] }> {
  return {
    name: "world_time",
    title: "World time",
    description:
      "Get the current local time in one or more places, or convert a specific time between zones. " +
      "Pass city names (\"Tokyo\", \"New York\"), abbreviations (\"PST\") or IANA zones (\"Europe/Lisbon\"). " +
      "With `time` (and optional `date`), that wall-clock time in the FIRST location is converted to the others. " +
      "Also reports each zone's UTC offset and how far ahead/behind it is of the first location. Prefer IANA names for less common cities.",
    inputSchema: {
      type: "object",
      properties: {
        locations: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 12,
          description: "Places or IANA time zones. The first is the reference for differences and `time`."
        },
        time: { type: "string", description: "Optional 24h local time in the first location, \"HH:MM\" (e.g. \"15:30\")." },
        date: { type: "string", description: "Optional date for `time`, \"YYYY-MM-DD\" (default: today in the first location)." }
      },
      required: ["locations"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    async run(input) {
      const locations = Array.isArray(input?.locations)
        ? input.locations.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 12)
        : typeof (input as { location?: unknown })?.location === "string"
          ? [(input as unknown as { location: string }).location]
          : [];
      if (locations.length === 0) return { content: "World time failed: give at least one location.", isError: true };

      const zones: string[] = [];
      const unknown: string[] = [];
      for (const location of locations) {
        const zone = resolveTimeZone(location);
        if (zone) zones.push(zone);
        else unknown.push(location);
      }
      if (unknown.length > 0) {
        return {
          content: `World time failed: unknown place or time zone: ${unknown.join(", ")}. Use an IANA zone like "America/New_York" or "Asia/Kolkata".`,
          isError: true
        };
      }

      let instant = now();
      if (input.time !== undefined) {
        const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(input.time).trim());
        if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) {
          return { content: "World time failed: `time` must be HH:MM in 24h format.", isError: true };
        }
        let day = localParts(zones[0]!, instant);
        if (input.date !== undefined) {
          const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input.date).trim());
          if (!dateMatch) return { content: "World time failed: `date` must be YYYY-MM-DD.", isError: true };
          day = { year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]) };
        }
        instant = zonedTimeToInstant(zones[0]!, { ...day, hour: Number(timeMatch[1]), minute: Number(timeMatch[2]) });
      }

      const baseOffset = zoneOffsetMinutes(zones[0]!, instant);
      const entries: WorldTimeEntry[] = zones.map((zone, i) => {
        const offset = zoneOffsetMinutes(zone, instant);
        const local = new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZoneName: "short"
        }).format(instant);
        const shifted = new Date(instant.getTime() + offset * 60_000).toISOString().slice(0, 19);
        return {
          input: locations[i]!,
          timeZone: zone,
          local,
          iso: `${shifted}${formatOffset(offset).slice(3)}`,
          utcOffset: formatOffset(offset),
          diffMinutes: offset - baseOffset
        };
      });

      const lines = entries.map((entry, i) =>
        `${entry.input} (${entry.timeZone}): ${entry.local}, ${entry.utcOffset}${i === 0 ? "" : `, ${formatDiff(entry.diffMinutes)} of ${entries[0]!.input}`}`
      );
      const header = input.time !== undefined ? `${input.time} in ${entries[0]!.input} is:` : "Current time:";
      return { content: `${header}\n${lines.join("\n")}`, data: { instant: instant.toISOString(), entries } };
    }
  };
}
