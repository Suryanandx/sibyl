import { describe, expect, test } from "vitest";
import { CronError, describeSchedule, isValidTimeZone, nextRun, parseCron, validateSchedule } from "./cron.js";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe("parseCron", () => {
  test("fields, ranges, steps, lists and names", () => {
    const cron = parseCron("*/15 9-17/4 1,15 jan-mar mon-fri");
    expect(cron.minutes).toEqual([0, 15, 30, 45]);
    expect(cron.hours).toEqual([9, 13, 17]);
    expect([...cron.days].sort((a, b) => a - b)).toEqual([1, 15]);
    expect([...cron.months].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...cron.weekdays].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("7 means Sunday; macros expand", () => {
    expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]);
    expect(parseCron("@daily").hours).toEqual([0]);
    expect(parseCron("@hourly").hours).toHaveLength(24);
  });

  test("rejects malformed expressions", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "a b c d e", "* * * * 8"]) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
  });
});

describe("nextRun", () => {
  test("every weekday at 8 in Berlin (CET, UTC+1)", () => {
    // Monday 9 Nov 2026, 13:00 Berlin → next is Tuesday 08:00 Berlin = 07:00Z.
    expect(iso(nextRun("0 8 * * 1-5", "Europe/Berlin", at("2026-11-09T12:00:00Z")))).toBe("2026-11-10T07:00:00.000Z");
    // Friday evening → Monday.
    expect(iso(nextRun("0 8 * * 1-5", "Europe/Berlin", at("2026-11-13T18:00:00Z")))).toBe("2026-11-16T07:00:00.000Z");
  });

  test("strictly after the given instant", () => {
    expect(iso(nextRun("*/15 * * * *", "UTC", at("2026-11-09T12:15:00Z")))).toBe("2026-11-09T12:30:00.000Z");
    expect(iso(nextRun("*/15 * * * *", "UTC", at("2026-11-09T12:07:30Z")))).toBe("2026-11-09T12:15:00.000Z");
  });

  test("time zones far from UTC cross the date line", () => {
    // 07:00 in Tokyo (UTC+9) is 22:00Z the previous day.
    expect(iso(nextRun("0 7 * * *", "Asia/Tokyo", at("2026-11-09T12:00:00Z")))).toBe("2026-11-09T22:00:00.000Z");
    // 21:00 in Los Angeles (UTC-8 in November) is 05:00Z next day.
    expect(iso(nextRun("0 21 * * *", "America/Los_Angeles", at("2026-11-09T12:00:00Z")))).toBe("2026-11-10T05:00:00.000Z");
  });

  test("day-of-month OR day-of-week when both are restricted (Vixie)", () => {
    // 13th of the month or any Friday: from Mon 9 Nov 2026 the next is Fri 13 Nov.
    expect(iso(nextRun("0 12 13 * 5", "UTC", at("2026-11-09T00:00:00Z")))).toBe("2026-11-13T12:00:00.000Z");
    // 1st or Wednesday: Wed 11 Nov comes first.
    expect(iso(nextRun("0 12 1 * 3", "UTC", at("2026-11-09T00:00:00Z")))).toBe("2026-11-11T12:00:00.000Z");
  });

  test("leap day", () => {
    expect(iso(nextRun("0 0 29 2 *", "UTC", at("2026-11-09T00:00:00Z")))).toBe("2028-02-29T00:00:00.000Z");
  });

  test("never-matching expression returns undefined", () => {
    expect(nextRun("0 0 31 2 *", "UTC", at("2026-01-01T00:00:00Z"))).toBeUndefined();
    expect(() => validateSchedule("0 0 31 2 *", "UTC")).toThrow(/never runs/);
  });

  describe("DST", () => {
    test("spring forward: a time in the gap runs right after it", () => {
      // US DST starts Sun 8 Mar 2026 at 02:00 → 03:00 (EST -5 → EDT -4).
      expect(iso(nextRun("30 2 * * *", "America/New_York", at("2026-03-08T05:00:00Z")))).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
      // The next day it is 02:30 EDT again.
      expect(iso(nextRun("30 2 * * *", "America/New_York", at("2026-03-08T07:30:00Z")))).toBe("2026-03-09T06:30:00.000Z");
      // A daily job at 08:00 keeps its wall time across the change.
      expect(iso(nextRun("0 8 * * *", "America/New_York", at("2026-03-07T14:00:00Z")))).toBe("2026-03-08T12:00:00.000Z");
    });

    test("fall back: a repeated time runs once, on its first occurrence", () => {
      // US DST ends Sun 1 Nov 2026 at 02:00 → 01:00 (EDT -4 → EST -5).
      const first = nextRun("30 1 * * *", "America/New_York", at("2026-11-01T04:00:00Z"));
      expect(iso(first)).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
      // Not again at 01:30 EST (06:30Z): the next run is the following day.
      expect(iso(nextRun("30 1 * * *", "America/New_York", first!))).toBe("2026-11-02T06:30:00.000Z");
    });

    test("Europe: spring forward and fall back", () => {
      // EU DST starts Sun 29 Mar 2026 at 02:00 CET → 03:00 CEST.
      expect(iso(nextRun("30 2 * * *", "Europe/Berlin", at("2026-03-28T23:00:00Z")))).toBe("2026-03-29T01:30:00.000Z"); // 03:30 CEST
      // EU DST ends Sun 25 Oct 2026 at 03:00 CEST → 02:00 CET; 02:30 happens twice.
      const first = nextRun("30 2 * * *", "Europe/Berlin", at("2026-10-24T23:00:00Z"));
      expect(iso(first)).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST
      expect(iso(nextRun("30 2 * * *", "Europe/Berlin", first!))).toBe("2026-10-26T01:30:00.000Z");
    });

    test("hourly jobs keep firing through the transition", () => {
      const runs: string[] = [];
      let cursor = at("2026-03-08T05:30:00Z"); // 00:30 EST
      for (let i = 0; i < 4; i += 1) {
        cursor = nextRun("0 * * * *", "America/New_York", cursor)!;
        runs.push(new Date(cursor).toISOString());
      }
      // 01:00 EST, (02:00 does not exist → 03:00 EDT), 04:00 EDT … each one hour of real time apart.
      expect(runs).toEqual([
        "2026-03-08T06:00:00.000Z",
        "2026-03-08T07:00:00.000Z",
        "2026-03-08T08:00:00.000Z",
        "2026-03-08T09:00:00.000Z"
      ]);
    });
  });
});

describe("validation and descriptions", () => {
  test("time zones", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(() => validateSchedule("0 8 * * *", "Mars/Olympus")).toThrow(/time zone/);
  });

  test("plain words", () => {
    expect(describeSchedule("0 8 * * 1-5", "Europe/Berlin")).toBe("every weekday at 08:00 (Europe/Berlin)");
    expect(describeSchedule("*/15 * * * *", "UTC")).toBe("every 15 minutes (UTC)");
    expect(describeSchedule("0 9 1 * *", "UTC")).toBe("on day 1 of the month at 09:00 (UTC)");
    expect(describeSchedule("30 7,19 * * sat,sun", "UTC")).toBe("every weekend day at 07:30 and 19:30 (UTC)");
    expect(describeSchedule("0 9 * * 1", "UTC")).toBe("every Monday at 09:00 (UTC)");
    expect(describeSchedule("0 * * * *", "UTC")).toBe("every hour (UTC)");
    expect(describeSchedule("nonsense", "UTC")).toContain("nonsense");
  });
});
