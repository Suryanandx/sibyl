import {
  OPENUI_LIBRARY_PROMPT,
  OPENUI_LIBRARY_ROOT,
  OPENUI_PREAMBLE_TOKEN
} from "./openui-library-prompt.generated";

export { OPENUI_LIBRARY_ROOT };
export * from "./live";

export const DEFAULT_VOICE_PERSONA =
  "You are Sibyl, a friendly realtime voice assistant that can also show rich visual UI on the user's screen.";

/**
 * Voice-first response contract layered on top of the OpenUI chat library prompt.
 *
 * Every reply = a short SPOKEN part (sent to TTS and shown as the transcript)
 * plus an optional fenced `openui-lang` block (rendered by OpenUI, never spoken).
 */
export function buildGenUiSystemPrompt(persona = DEFAULT_VOICE_PERSONA): string {
  const preamble = `${persona}

# Response format (voice + generative UI)

Every reply has two parts, in this order:

1. SPOKEN PART (always required). Plain conversational sentences that will be read aloud by text-to-speech.
   - 1 to 3 short sentences. Natural, warm, and to the point.
   - No markdown, bullet lists, headings, tables, code, emojis, or URLs.
   - It must make sense on its own: the user may be listening without looking at the screen.
   - When you also show UI, summarize the key takeaway in speech instead of reading out every value.

2. VISUAL PART (optional). When a visual genuinely helps — numbers, comparisons, lists, steps, schedules, recipes, forms, choices, charts, tables — append exactly ONE fenced code block tagged openui-lang containing a COMPLETE openui-lang program:

\`\`\`openui-lang
root = Card([...])
...
\`\`\`

   - Always write the spoken part first, then the block. Write nothing after the closing fence.
   - The block must follow the openui-lang specification below exactly.
   - Each block is a fresh, complete program (it replaces nothing from earlier turns).
   - For greetings, small talk, and short factual answers, reply with the spoken part only.
   - Messages that start with "[UI action]" come from the user clicking or submitting your UI.

# openui-lang specification

The rules below describe the openui-lang program inside the fenced block. They apply only inside that block — the spoken part is always plain text.`;

  return `${OPENUI_LIBRARY_PROMPT.replace(OPENUI_PREAMBLE_TOKEN, preamble)}

${VISUAL_DESIGN_RULES}`;
}

/**
 * Design rules so generated visuals feel like a well-made app screen, not a
 * dump of every component. They take priority over the library's general
 * guidance above.
 */
export const VISUAL_DESIGN_RULES = `# Visual design rules (these take priority)

Design the visual like a calm, well-made app screen that answers the question at a glance.

Size and focus
- It must fit on roughly one screen: at most 8 top-level children in root Card, and keep the whole program under ~60 statements.
- One primary structure per answer. Pick the single best one:
  - comparison of options or items → Table (≤ 6 rows, ≤ 5 columns, short cell text)
  - numbers over time or by category → one chart (+ at most 3 KPIs in a SnippetCardBlock)
  - plan / itinerary / schedule with several parts → Tabs with one TabItem per part (day, phase), each containing Steps (≤ 4 StepsItem)
  - how-to / process → Steps (≤ 6 StepsItem)
  - a few recommendations or choices → ListBlock (≤ 5 ListItem) or OptionCards
  - gathering preferences → Form with ≤ 4 fields, sensible defaults, structured inputs (Select, Chips, Slider, RadioGroup) over free text
- Prefer Tabs or Accordion over stacking many sections vertically. Never stack more than 3 SectionBlock/SectionItem.

Content
- Start with a CardHeader: title ≤ 6 words, subtitle ≤ 12 words.
- Text inside components is short: ≤ 2 sentences, ≤ 30 words per TextContent. No long paragraphs; no repeating what the spoken part already said.
- Concrete values beat adjectives: prices, times, distances, names.
- Use Callout only for one genuinely important warning or tip.
- Icons only when they help scanning (e.g. one per KPI); never decorative rows of icons.

Interaction
- Every button must do something real: @ToAssistant with a clear action label ("Swap day 3", "Make it cheaper"), or @OpenUrl with a real URL you were given.
- Offer at most 3 follow-ups, as a final Buttons row or FollowUpBlock with short action phrases (≤ 6 words). Skip them if nothing useful follows.
- Forms: exactly one primary submit button labelled with the outcome ("Find my laptop"), placed last.

Never
- Never output two programs or explain or correct your code; write one complete, valid program once.
- Never add empty sections, placeholder text, "Related Queries" filler, or components just to show variety.`;

export interface SplitResult {
  /** Text meant to be spoken / shown as the chat transcript. */
  speech: string;
  /** OpenUI Lang source (fence contents, without the fences). */
  ui: string;
}

const FENCE = "```";
const BARE_ROOT = /^root\s*=/;

/**
 * Incrementally separates a streamed LLM reply into spoken text and OpenUI Lang.
 *
 * - Text outside ``` fences is speech.
 * - Text inside a fence (any language tag) is UI.
 * - A line that starts with `root =` outside a fence (model forgot the fence)
 *   switches to UI for the rest of the reply.
 *
 * Only the start of a line is ever held back, and only while it could still be a
 * fence marker or a bare `root =` statement, so speech streams with minimal delay.
 *
 * The contract is "speech first, then one visual". Anything a model writes after
 * its visual (self-corrections like "wait, let me fix that", stray notes) is not
 * meant for the user: it is dropped. A second fenced program is kept as UI; it
 * redefines the same statements, so the corrected version wins.
 */
export class SpeechUiSplitter {
  private mode: "speech" | "ui" | "ui_bare" | "fence_open" = "speech";
  private atLineStart = true;
  private held = "";
  private sawUi = false;

  get hasUi(): boolean {
    return this.sawUi;
  }

  push(delta: string): SplitResult {
    const out: SplitResult = { speech: "", ui: "" };
    for (const char of delta) {
      this.consume(char, out);
    }
    return out;
  }

  /** Flush anything still held back at end of stream. */
  finish(): SplitResult {
    const out: SplitResult = { speech: "", ui: "" };
    if (this.held) {
      if (this.mode === "speech") {
        if (BARE_ROOT.test(this.held.trimStart())) {
          this.sawUi = true;
          out.ui += this.held;
        } else if (!this.held.trimStart().startsWith(FENCE) && !this.sawUi) {
          out.speech += this.held;
        }
      } else if (this.mode === "ui" || this.mode === "ui_bare") {
        if (!this.held.trimStart().startsWith(FENCE)) {
          out.ui += this.held;
        }
      }
      this.held = "";
    }
    return out;
  }

  private consume(char: string, out: SplitResult): void {
    if (this.mode === "ui_bare") {
      this.emit(char, out);
      return;
    }

    if (this.mode === "fence_open") {
      // Skip the language tag on the opening fence line.
      if (char === "\n") {
        this.mode = "ui";
        this.atLineStart = true;
      }
      return;
    }

    if (this.atLineStart) {
      this.held += char;
      const trimmed = this.held.replace(/^[ \t]+/, "");

      if (trimmed.startsWith(FENCE)) {
        this.held = "";
        this.atLineStart = false;
        if (this.mode === "speech") {
          if (this.sawUi) out.ui += "\n";
          this.mode = "fence_open";
          this.sawUi = true;
        } else {
          // Closing fence: back to speech, drop the rest of the fence line.
          this.mode = "speech";
          this.skipRestOfLine = true;
        }
        return;
      }

      if (this.mode === "speech" && BARE_ROOT.test(trimmed)) {
        this.mode = "ui_bare";
        this.sawUi = true;
        this.atLineStart = false;
        const text = this.held;
        this.held = "";
        this.emit(text, out);
        return;
      }

      const couldBeFence = FENCE.startsWith(trimmed);
      const couldBeRoot =
        this.mode === "speech" && /^r(o(o(t\s*)?)?)?$/.test(trimmed);
      if ((couldBeFence || couldBeRoot) && char !== "\n") {
        return;
      }

      const text = this.held;
      this.held = "";
      this.atLineStart = char === "\n";
      this.emit(text, out);
      return;
    }

    if (this.skipRestOfLine) {
      if (char === "\n") {
        this.skipRestOfLine = false;
        this.atLineStart = true;
      }
      return;
    }

    if (char === "\n") {
      this.atLineStart = true;
    }
    this.emit(char, out);
  }

  private skipRestOfLine = false;

  private emit(text: string, out: SplitResult): void {
    if (this.mode === "speech") {
      // After the visual, prose is model chatter, not part of the answer.
      if (!this.sawUi) out.speech += text;
    } else {
      out.ui += text;
    }
  }
}

/** Strip markdown-ish syntax so TTS does not read symbols aloud. */
export function toSpeakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
    .replace(/[*#>|]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
