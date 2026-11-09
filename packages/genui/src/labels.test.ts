import { describe, expect, it } from "vitest";
import { SpeechUiSplitter } from "./index";

const speech = (chunks: string[]) => {
  const splitter = new SpeechUiSplitter();
  let out = "";
  for (const chunk of chunks) out += splitter.push(chunk).speech;
  return out + splitter.finish().speech;
};

describe("reply labels", () => {
  it("drops a heading the model puts before its answer", () => {
    expect(speech(["**Speaker", " notes:**\n\nThree moons", " have oceans."])).toBe("Three moons have oceans.");
    expect(speech(["Spoken part: Hello there."])).toBe("Hello there.");
    expect(speech(["**Answer:** 42."])).toBe("42.");
  });

  it("keeps ordinary sentences that start with the same words", () => {
    expect(speech(["Speech is silver, they say."])).toBe("Speech is silver, they say.");
    expect(speech(["Voice", " notes are handy."])).toBe("Voice notes are handy.");
    expect(speech(["Answer"])).toBe("Answer");
    expect(speech(["So", "me ", "text."])).toBe("Some text.");
  });
});
