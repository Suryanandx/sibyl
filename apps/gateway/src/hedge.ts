/**
 * Hedged streaming requests: tame tail latency on shared model providers.
 *
 * Starts one attempt. If it hasn't produced its first item within
 * `hedgeAfterMs` (or it fails before producing anything), a second attempt is
 * started. Whichever produces the first item wins; the other is aborted and
 * the stream continues from the winner only.
 */
export interface HedgeOptions {
  hedgeAfterMs: number;
  /** Aborting this aborts every attempt. */
  signal?: AbortSignal;
  /** Called when the backup attempt is started (for logging). */
  onHedge?: (reason: "slow" | "error") => void;
  /** Called with the index of the attempt that won (0 = primary). */
  onWinner?: (index: number) => void;
}

type First<T> =
  | { index: number; result: IteratorResult<T> }
  | { index: number; error: unknown };

export async function* hedgedStream<T>(
  makeAttempt: (signal: AbortSignal, index: number) => AsyncIterable<T>,
  options: HedgeOptions
): AsyncIterable<T> {
  const controllers: AbortController[] = [];
  const iterators: AsyncIterator<T>[] = [];
  const pending = new Map<number, Promise<First<T>>>();
  const onOuterAbort = (): void => controllers.forEach((c) => c.abort(options.signal?.reason));
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const start = (index: number): void => {
    const controller = new AbortController();
    controllers[index] = controller;
    const iterator = makeAttempt(controller.signal, index)[Symbol.asyncIterator]();
    iterators[index] = iterator;
    pending.set(
      index,
      iterator.next().then(
        (result) => ({ index, result }),
        (error: unknown) => ({ index, error })
      )
    );
  };

  let winner: { index: number; result: IteratorResult<T> } | undefined;
  let firstError: unknown;
  try {
    start(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hedgeTimer = new Promise<"hedge">((resolve) => {
      timer = setTimeout(() => resolve("hedge"), options.hedgeAfterMs);
    });
    let hedged = false;

    while (!winner) {
      const contenders: Array<Promise<First<T> | "hedge">> = [...pending.values()];
      if (!hedged) contenders.push(hedgeTimer);
      if (contenders.length === 0) break;
      const next = await Promise.race(contenders);

      if (next === "hedge") {
        hedged = true;
        if (!options.signal?.aborted) {
          options.onHedge?.("slow");
          start(1);
        }
        continue;
      }
      pending.delete(next.index);
      if ("error" in next) {
        firstError ??= next.error;
        if (!hedged && !options.signal?.aborted) {
          hedged = true;
          options.onHedge?.("error");
          start(1);
        }
        continue;
      }
      if (next.result.done && pending.size > 0) {
        // Empty stream; let the other attempt answer.
        continue;
      }
      winner = next;
    }
    clearTimeout(timer);

    if (!winner) throw firstError ?? new Error("All hedged attempts failed");
    // Stop the losers.
    for (const [index] of pending) {
      controllers[index]?.abort("hedge lost");
      void iterators[index]?.return?.(undefined).catch(() => undefined);
    }
    pending.clear();
    options.onWinner?.(winner.index);

    if (winner.result.done) return;
    yield winner.result.value;
    const iterator = iterators[winner.index]!;
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) return;
      yield value;
    }
  } finally {
    options.signal?.removeEventListener("abort", onOuterAbort);
    for (const [index] of pending) controllers[index]?.abort("hedge finished");
  }
}
