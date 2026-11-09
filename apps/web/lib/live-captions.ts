/**
 * Instant captions while the user speaks, from the browser's built-in speech
 * recognition (Chrome, Edge, Safari). Display-only: the voice brain hears the
 * real audio, and the Gateway replaces the caption with an accurate transcript.
 *
 * Note: in Chrome, Web Speech recognition is processed by the browser vendor's
 * service. Disable with NEXT_PUBLIC_LIVE_CAPTIONS=false.
 */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): RecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
}

export function liveCaptionsSupported(): boolean {
  return (
    process.env.NEXT_PUBLIC_LIVE_CAPTIONS !== "false" &&
    recognitionConstructor() !== undefined
  );
}

/**
 * Continuous recognizer that restarts itself while running. Call markTurnStart()
 * when the VAD detects speech; text() then returns only that turn's words.
 */
export class LiveCaptions {
  private recognition: SpeechRecognitionLike | null = null;
  private running = false;
  private turnStartIndex = 0;
  private resultsLength = 0;
  private results: SpeechRecognitionEventLike["results"] | null = null;
  private restartTimer: number | null = null;

  constructor(private readonly onCaption: (text: string) => void) {}

  start(lang = navigator.language || "en-US"): boolean {
    const Recognition = recognitionConstructor();
    if (!Recognition || this.running) return Boolean(Recognition);
    this.running = true;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    recognition.onresult = (event) => {
      this.results = event.results;
      this.resultsLength = event.results.length;
      this.onCaption(this.text());
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.running = false;
      }
    };
    recognition.onend = () => {
      // Sessions end on their own after a while or on silence; keep going.
      this.results = null;
      this.resultsLength = 0;
      this.turnStartIndex = 0;
      if (this.running) {
        this.restartTimer = window.setTimeout(() => {
          try {
            recognition.start();
          } catch {
            // already started
          }
        }, 150);
      }
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      this.running = false;
    }
    return this.running;
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
    try {
      this.recognition?.abort();
    } catch {
      // ignore
    }
    this.recognition = null;
    this.results = null;
  }

  /** Start collecting a new turn (call on VAD speech start). */
  markTurnStart(): void {
    // Include the result currently in progress: the VAD fires a moment after
    // the user starts talking, often mid-word.
    const last = this.resultsLength - 1;
    const lastIsInterim = last >= 0 && this.results && !this.results[last]?.isFinal;
    this.turnStartIndex = lastIsInterim ? last : this.resultsLength;
  }

  /** Words heard since the last markTurnStart(). */
  text(): string {
    const results = this.results;
    if (!results) return "";
    let out = "";
    for (let index = this.turnStartIndex; index < results.length; index += 1) {
      out += results[index]?.[0]?.transcript ?? "";
    }
    return out.replace(/\s+/g, " ").trim();
  }
}
