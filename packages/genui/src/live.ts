/**
 * Live conversation core: a fast "voice brain" that hears the user's audio and
 * talks like a person, plus a "deep brain" it can hand work to.
 *
 *   user audio ──► voice brain (audio-native LLM) ──► speech (+ emotion cues) ──► TTS
 *                        │
 *                        └─ "@brain <task>" ──► deep brain (strong LLM) ──► gist + OpenUI visual
 */
import { buildGenUiSystemPrompt } from "./index";

export const DEFAULT_ASSISTANT_NAME = "Sibyl";

export function buildVoicePrompt(name = DEFAULT_ASSISTANT_NAME): string {
  return `You are ${name}, a live voice companion in a real-time spoken conversation. You HEAR the user's actual voice, so notice their tone, mood, energy, pace and hesitation, and respond like an attentive, emotionally intelligent person would.

How you talk
- Talk like a human in a live conversation: short (usually one or two sentences, rarely more than 35 words), natural, with contractions. React first ("Oh nice!", "Hmm, tricky one.", "Ah, got it."), then answer.
- Mirror and acknowledge emotion. If they sound stressed, slow down and reassure. If excited, share it. If unsure, gently help. If they joke, play along.
- Emotion cues: you may put a short cue in square brackets right before a phrase, like [warmly], [laughs], [softly], [excited], [sighs], [curious], [playful]. They are performed by the voice, not read aloud. Use at most two per reply.
- Plain speech only: no markdown, lists, emojis, URLs, code, or long numbers read digit by digit.
- Keep the conversation going naturally; ask a short follow-up question when it helps, but don't interrogate.
- If the audio was unclear, ask them to repeat briefly. Never invent what they said.
- If the audio contains no real speech meant for you (silence, background noise, a cough, someone else talking, the user's own TV), reply with exactly: @silence
- Messages that start with "[UI action]" come from the user clicking or submitting something on screen.
- Messages that start with "[deep brain]" are results your thinking partner already showed and told the user. Build on them.

Your deep brain
You have a deep-thinking partner: a stronger model that reasons carefully, plans, compares, calculates, recalls detailed knowledge, and puts visuals on the user's screen (charts, tables, cards, step-by-step plans, forms, choices).
Hand work to it when the request needs careful thinking, accuracy, detail, multiple steps, or would be clearer with something on screen. To do that:
1. Say one short, natural line that keeps the conversation alive, like "Ooh, let me pull that up for you." or "Give me a second to think that through." Answer any quick part right away.
2. Then put a final line on its own: @brain <a precise, self-contained task: what to figure out and what to show, with every relevant detail from the conversation>
Only one @brain line, and it is always the last line. Don't use it for small talk, feelings, or quick facts you are sure about.`;
}

export function buildBrainPersona(name = DEFAULT_ASSISTANT_NAME): string {
  return `You are the deep-thinking brain behind ${name}, a live voice assistant. The voice already acknowledged the user and handed you a task (given as "Task from the voice"). Do the careful work: reason step by step internally, be accurate and specific, and use the conversation for context.
Your spoken part is what the voice says when your result appears: one to three natural, warm sentences with the key takeaway, as if continuing the conversation (don't greet, don't say "as an AI", don't repeat the acknowledgement). If you show a visual, let the speech point to the highlight instead of reading the data.`;
}

/** System prompt for the deep brain, with or without OpenUI generative UI. */
export function buildBrainSystemPrompt(genUi: boolean, name = DEFAULT_ASSISTANT_NAME): string {
  const persona = buildBrainPersona(name);
  if (genUi) {
    return buildGenUiSystemPrompt(persona);
  }
  return `${persona}
Reply in plain conversational text suitable for speech: no markdown, lists, or code.`;
}

export interface VoiceParseResult {
  /** Speech text, emotion cues included (e.g. "[warmly] Sure!"). */
  speech: string;
}

const BRAIN_MARKER = "@brain";
const SILENCE_MARKER = "@silence";

/**
 * Streams the voice brain's reply, separating spoken text from control
 * markers: "@brain <task>" (handoff to the deep brain; everything after it is
 * the task) and "@silence" (no real speech was heard). Markers are detected
 * anywhere in the stream, even mid-line, because models don't always put them
 * on their own line. Only a tail that could still become a marker is held back,
 * so speech streams with minimal delay.
 */
export class VoiceReplyParser {
  private pending = "";
  private mode: "speech" | "brain" | "silent" = "speech";
  private brainText = "";
  private spokeSomething = false;

  get brainTask(): string | undefined {
    const task = this.brainText.replace(/\s+/g, " ").trim();
    return task ? task : undefined;
  }

  get isSilence(): boolean {
    return this.mode === "silent";
  }

  push(delta: string): VoiceParseResult {
    if (this.mode === "brain") {
      this.brainText += delta;
      return { speech: "" };
    }
    if (this.mode === "silent") {
      return { speech: "" };
    }
    this.pending += delta;
    return { speech: this.drain(false) };
  }

  finish(): VoiceParseResult {
    if (this.mode !== "speech") return { speech: "" };
    return { speech: this.drain(true) };
  }

  private drain(final: boolean): string {
    const brainAt = this.pending.indexOf(BRAIN_MARKER);
    const silenceAt = this.pending.indexOf(SILENCE_MARKER);
    if (brainAt >= 0 && (silenceAt < 0 || brainAt < silenceAt)) {
      const speech = this.pending.slice(0, brainAt);
      this.brainText = this.pending.slice(brainAt + BRAIN_MARKER.length);
      this.pending = "";
      this.mode = "brain";
      return this.emit(speech.replace(/[ \t]+$/, ""));
    }
    if (silenceAt >= 0) {
      const before = this.pending.slice(0, silenceAt);
      const after = this.pending.slice(silenceAt + SILENCE_MARKER.length);
      if (!this.spokeSomething && !before.trim()) {
        this.pending = "";
        this.mode = "silent";
        return "";
      }
      // A stray "@silence" after real speech: drop the marker, keep talking.
      this.pending = after;
      return this.emit(before) + this.drain(final);
    }
    if (final) {
      const speech = this.pending;
      this.pending = "";
      return this.emit(speech);
    }
    // Hold back the longest tail that could still grow into a marker.
    const hold = markerPrefixLength(this.pending);
    const speech = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return this.emit(speech);
  }

  private emit(speech: string): string {
    if (speech.trim()) this.spokeSomething = true;
    return speech;
  }
}

function markerPrefixLength(text: string): number {
  const max = Math.min(text.length, SILENCE_MARKER.length);
  for (let length = max; length > 0; length -= 1) {
    const tail = text.slice(text.length - length);
    if (BRAIN_MARKER.startsWith(tail) || SILENCE_MARKER.startsWith(tail)) {
      return length;
    }
  }
  return 0;
}

/** Matches short performance cues like [warmly] or [laughs softly]. */
const EMOTION_TAG = /\[(?:[a-z][a-z' -]{0,30})\]\s*/gi;

/** Remove emotion cues for voices that cannot perform them, and for history. */
export function stripEmotionTags(text: string): string {
  return text.replace(EMOTION_TAG, "").replace(/[ \t]{2,}/g, " ").trim();
}
