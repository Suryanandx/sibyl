import { describe, expect, it } from "vitest";
import type { OnboardingStepId } from "@open-gpt-live/protocol";
import { isOptional, isStep, nextStep, previousStep, resumeStep, ringDash, stepPosition, suggestedPrompts } from "./flow";

const all: OnboardingStepId[] = ["profile", "model", "style", "tools", "agent", "knowledge", "team", "start"];
const member: OnboardingStepId[] = ["profile", "style", "tools", "start"];

describe("step navigation", () => {
  it("moves forward and back within the person's steps", () => {
    expect(nextStep(all, "profile")).toBe("model");
    expect(nextStep(member, "style")).toBe("tools");
    expect(nextStep(member, "start")).toBeUndefined();
    expect(previousStep(member, "tools")).toBe("style");
    expect(previousStep(member, "profile")).toBeUndefined();
  });

  it("starts at the first step when the current one isn't theirs", () => {
    expect(nextStep(member, "team")).toBe("profile");
  });

  it("resumes at the current step, else the first not done", () => {
    expect(resumeStep(all, "agent", ["profile"])).toBe("agent");
    expect(resumeStep(member, "team", ["profile"])).toBe("style");
    expect(resumeStep(member, undefined, ["profile", "style", "tools", "start"])).toBe("start");
  });

  it("knows positions, optional steps and valid ids", () => {
    expect(stepPosition(all, "style")).toEqual({ index: 3, total: 8 });
    expect(isOptional("tools")).toBe(true);
    expect(isOptional("profile")).toBe(false);
    expect(isOptional("start")).toBe(false);
    expect(isStep("knowledge")).toBe(true);
    expect(isStep("nope")).toBe(false);
  });
});

describe("suggested prompts", () => {
  it("uses what was connected first, then general ones, at most four", () => {
    const prompts = suggestedPrompts({ connected: ["google", "slack"], knowledge: ["Team knowledge"], agentName: "Research Dot" });
    expect(prompts).toHaveLength(4);
    expect(prompts[0]!.uses).toBe("Google");
    expect(prompts.map((p) => p.uses)).toContain("Slack");
  });

  it("falls back to general prompts", () => {
    const prompts = suggestedPrompts({ connected: [], knowledge: [] });
    expect(prompts).toHaveLength(3);
    expect(prompts.every((p) => !p.uses)).toBe(true);
  });

  it("mentions knowledge and the agent by name", () => {
    const texts = suggestedPrompts({ connected: [], knowledge: ["Handbook"], agentName: "Inbox helper" }).map((p) => p.text);
    expect(texts[0]).toContain("Handbook");
    expect(texts[1]).toContain("Inbox helper");
  });
});

describe("progress ring", () => {
  it("fills in proportion and clamps", () => {
    const r = 10;
    const full = 2 * Math.PI * r;
    expect(ringDash(0, 7, r).filled).toBe(0);
    expect(ringDash(7, 7, r).filled).toBeCloseTo(full);
    expect(ringDash(3, 6, r).filled).toBeCloseTo(full / 2);
    expect(ringDash(9, 6, r).filled).toBeCloseTo(full);
    expect(ringDash(1, 0, r).filled).toBe(0);
  });
});
