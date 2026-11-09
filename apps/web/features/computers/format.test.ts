import { describe, expect, it } from "vitest";
import { isComputerTool, shortUrl, stateLabel, usageLabel } from "./format";

describe("computer view formatting", () => {
  it("labels states and usage", () => {
    expect(stateLabel({ state: "running" })).toBe("Running");
    expect(stateLabel(null)).toBe("Connecting…");
    expect(usageLabel({ usedSecondsToday: 750, dailyMinutes: 60 })).toBe("12 of 60 min used today");
  });
  it("shortens URLs and spots computer tools", () => {
    expect(shortUrl("https://example.com/")).toBe("example.com");
    expect(shortUrl("https://example.com/a/b?q=1")).toBe("example.com/a/b");
    expect(shortUrl("about:blank")).toBe("");
    expect(isComputerTool("computer_open")).toBe(true);
    expect(isComputerTool("web_search")).toBe(false);
  });
});
