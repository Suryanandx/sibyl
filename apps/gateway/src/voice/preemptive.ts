/**
 * Preemptive generation (like LiveKit Agents' `preemptive_generation`): when
 * the speech detector reports a pause (vad.speech_pause), the voice brain
 * starts on the audio heard so far, before the turn is final. Its tokens are
 * kept, not shown or spoken. If the turn then ends without more speech, the
 * reply is adopted and the time the detector spent waiting is saved; if the
 * person carries on (vad.speech_resume), or anything the reply depends on
 * changed, it is cancelled.
 *
 * A cancelled attempt still costs its prompt (the audio so far). At most
 * `maxAttempts` run per turn, and an attempt that is never adopted is
 * cancelled after `timeoutMs`.
 */
import { Prefetched } from "./prefetch.js";

export interface PreemptiveSnapshot {
  /** History length when the attempt started (a change means the reply is stale). */
  historyLength: number;
  /** The voice model the turn would use. */
  model: string | undefined;
}

export interface PreemptiveReply {
  stream: AsyncIterable<{ delta: string }>;
  startedAt: number;
  /** The model that produced the reply (a hedge may have won). */
  winner: () => string | undefined;
  /** Cancel the reply (the run that adopted it was interrupted). */
  abort: (reason: string) => void;
}

interface Attempt extends PreemptiveSnapshot {
  requestId: string;
  controller: AbortController;
  reply: Prefetched<{ delta: string }>;
  startedAt: number;
  winner: () => string | undefined;
  timer: ReturnType<typeof setTimeout>;
}

export class PreemptiveGeneration {
  private attempt: Attempt | undefined;
  private readonly tries = new Map<string, number>();

  constructor(
    private readonly options: { now: () => number; maxAttempts?: number; timeoutMs?: number; log?: (event: string, fields: Record<string, unknown>) => void }
  ) {}

  /** Whether another attempt may start for this turn. */
  canStart(requestId: string): boolean {
    return this.attempt?.requestId !== requestId && (this.tries.get(requestId) ?? 0) < (this.options.maxAttempts ?? 3);
  }

  start(
    requestId: string,
    snapshot: PreemptiveSnapshot,
    begin: (signal: AbortSignal) => { stream: AsyncIterable<{ delta: string }>; winner: () => string | undefined }
  ): void {
    this.cancel(undefined, "replaced");
    this.tries.set(requestId, (this.tries.get(requestId) ?? 0) + 1);
    while (this.tries.size > 20) this.tries.delete(this.tries.keys().next().value!);
    const controller = new AbortController();
    const { stream, winner } = begin(controller.signal);
    this.attempt = {
      requestId,
      ...snapshot,
      controller,
      reply: new Prefetched(stream, () => controller.signal.aborted),
      startedAt: this.options.now(),
      winner,
      timer: setTimeout(() => this.cancel(requestId, "not adopted in time"), this.options.timeoutMs ?? 10_000)
    };
    this.options.log?.("preemptive.started", { requestId, model: snapshot.model });
  }

  /** Drop the attempt (for this turn only, when given). */
  cancel(requestId: string | undefined, reason: string): void {
    const attempt = this.attempt;
    if (!attempt || (requestId !== undefined && attempt.requestId !== requestId)) return;
    this.attempt = undefined;
    clearTimeout(attempt.timer);
    attempt.controller.abort(reason);
    this.options.log?.("preemptive.cancelled", { requestId: attempt.requestId, reason });
  }

  /** The turn is final: hand over the reply if it is still valid for it. */
  take(requestId: string, snapshot: PreemptiveSnapshot): PreemptiveReply | undefined {
    const attempt = this.attempt;
    if (!attempt || attempt.requestId !== requestId) return undefined;
    if (attempt.historyLength !== snapshot.historyLength || attempt.model !== snapshot.model) {
      this.cancel(requestId, "context changed");
      return undefined;
    }
    this.attempt = undefined;
    clearTimeout(attempt.timer);
    this.tries.delete(requestId);
    this.options.log?.("preemptive.adopted", { requestId, model: attempt.model });
    return {
      stream: attempt.reply.read(),
      startedAt: attempt.startedAt,
      winner: attempt.winner,
      abort: (reason) => attempt.controller.abort(reason)
    };
  }
}
