import { describe, expect, it } from "vitest";
import {
  SpeechUiSplitter,
  buildGenUiSystemPrompt,
  toSpeakableText
} from "./index";

function run(chunks: string[]) {
  const splitter = new SpeechUiSplitter();
  let speech = "";
  let ui = "";
  for (const chunk of chunks) {
    const out = splitter.push(chunk);
    speech += out.speech;
    ui += out.ui;
  }
  const end = splitter.finish();
  return { speech: speech + end.speech, ui: ui + end.ui, hasUi: splitter.hasUi };
}

function charChunks(text: string): string[] {
  return [...text];
}

const reply =
  "Here are the top three languages.\n\n```openui-lang\nroot = Card([t])\nt = TextContent(\"Hi\")\n```\n";

describe("SpeechUiSplitter", () => {
  it("splits spoken text from a fenced openui-lang block", () => {
    const result = run([reply]);
    expect(result.speech.trim()).toBe("Here are the top three languages.");
    expect(result.ui).toBe('root = Card([t])\nt = TextContent("Hi")\n');
    expect(result.hasUi).toBe(true);
  });

  it("is chunk-boundary independent", () => {
    expect(run(charChunks(reply))).toEqual(run([reply]));
    expect(run(["Here are", " the top three languages.\n\n``", "`openui", "-lang\nroot = Card([t])\nt = Text", 'Content("Hi")\n`', "``\n"])).toEqual(run([reply]));
  });

  it("treats plain answers as speech only", () => {
    const result = run(charChunks("Sure, it is 4 o'clock.\nAnything else?"));
    expect(result.speech).toBe("Sure, it is 4 o'clock.\nAnything else?");
    expect(result.ui).toBe("");
    expect(result.hasUi).toBe(false);
  });

  it("keeps speech lines that merely start with r", () => {
    const result = run(charChunks("Okay.\nright away, routing now."));
    expect(result.speech).toBe("Okay.\nright away, routing now.");
  });

  it("detects a bare root statement without fences", () => {
    const result = run(charChunks('Showing it now.\nroot = Card([a])\na = TextContent("x")'));
    expect(result.speech).toBe("Showing it now.\n");
    expect(result.ui).toBe('root = Card([a])\na = TextContent("x")');
    expect(result.hasUi).toBe(true);
  });

  it("drops chatter after the visual and keeps a corrected second program", () => {
    const reply =
      "Here is your plan.\n```openui-lang\nroot = Card([a])\na = TextContent(\"v1\")\n```\n\nWait, let me fix that:\n```openui-lang\na = TextContent(\"v2\")\n```\nHope that helps!";
    const result = run(charChunks(reply));
    expect(result.speech.trim()).toBe("Here is your plan.");
    expect(result.ui).toContain('a = TextContent("v1")');
    expect(result.ui).toContain('a = TextContent("v2")');
    expect(result.ui).not.toContain("Wait");
    expect(result.speech).not.toContain("Hope");
  });

  it("handles an unterminated fence at end of stream", () => {
    const result = run(["Look.\n```openui-lang\nroot = Card([a])"]);
    expect(result.speech).toBe("Look.\n");
    expect(result.ui).toBe("root = Card([a])");
  });
});

describe("toSpeakableText", () => {
  it("removes markdown symbols", () => {
    expect(toSpeakableText("**Bold** and _it_ with [a link](https://x.y) `code`")).toBe(
      "Bold and it with a link code"
    );
  });
});

describe("buildGenUiSystemPrompt", () => {
  it("embeds the voice contract and the OpenUI library", () => {
    const prompt = buildGenUiSystemPrompt();
    expect(prompt).toContain("SPOKEN PART");
    expect(prompt).toContain("root = Card(");
    expect(prompt).not.toContain("{{OPEN_GPT_LIVE_PREAMBLE}}");
  });
});
