import { describe, expect, it } from "vitest";
import { VoiceReplyParser, buildBrainSystemPrompt, buildVoicePrompt, stripEmotionTags } from "./live";

function run(chunks: string[]) {
  const parser = new VoiceReplyParser();
  let speech = "";
  for (const chunk of chunks) speech += parser.push(chunk).speech;
  speech += parser.finish().speech;
  return { speech, brain: parser.brainTask, silent: parser.isSilence };
}
const chars = (text: string) => [...text];

describe("VoiceReplyParser", () => {
  const reply = "[warmly] Ooh, let me pull that up for you.\n@brain Compare the top 3 laptops under $1500 for coding, show a table.";

  it("separates speech from the @brain handoff, independent of chunking", () => {
    const whole = run([reply]);
    expect(whole.speech).toBe("[warmly] Ooh, let me pull that up for you.\n");
    expect(whole.brain).toBe("Compare the top 3 laptops under $1500 for coding, show a table.");
    expect(run(chars(reply))).toEqual(whole);
  });

  it("passes ordinary speech through, including lines starting with @ or b", () => {
    const result = run(chars("Sure!\n@ home I usually relax.\nbrainy stuff"));
    expect(result.speech).toBe("Sure!\n@ home I usually relax.\nbrainy stuff");
    expect(result.brain).toBeUndefined();
  });

  it("catches an inline @brain marker mid-sentence", () => {
    const inline = "[excited] Ooh, Lisbon! Give me a second. @brain Create a 3-day Lisbon itinerary\nwith food.";
    const result = run(chars(inline));
    expect(result.speech.trim()).toBe("[excited] Ooh, Lisbon! Give me a second.");
    expect(result.brain).toBe("Create a 3-day Lisbon itinerary with food.");
    expect(run([inline]).brain).toEqual(result.brain);
  });

  it("detects @silence and speaks nothing", () => {
    expect(run(chars("@silence"))).toEqual({ speech: "", brain: undefined, silent: true });
    expect(run(["@sil", "ence\n"])).toEqual({ speech: "", brain: undefined, silent: true });
  });

  it("handles a brain line with no preceding speech", () => {
    expect(run(["@brain plan a trip"])).toEqual({ speech: "", brain: "plan a trip", silent: false });
  });
});

describe("prompts and tags", () => {
  it("strips emotion cues but keeps normal brackets-free text", () => {
    expect(stripEmotionTags("[warmly] Hi there! [laughs softly] That's funny.")).toBe("Hi there! That's funny.");
  });
  it("builds voice and brain prompts", () => {
    expect(buildVoicePrompt()).toContain("@brain");
    expect(buildBrainSystemPrompt(true)).toContain("openui-lang");
    expect(buildBrainSystemPrompt(false)).not.toContain("openui-lang");
  });
});
