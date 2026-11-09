/**
 * Reads an async stream eagerly in the background and replays it, in order, to
 * one later reader. Used for speech segments synthesized in parallel but played
 * in order, and for preemptive voice-brain replies started before the turn is
 * final (their tokens are kept until the turn commits).
 */
export class Prefetched<T> {
  private readonly items: T[] = [];
  private done = false;
  private error: unknown;
  private wake: (() => void) | undefined;

  constructor(source: AsyncIterable<T>, isStopped: () => boolean = () => false) {
    void (async () => {
      try {
        for await (const item of source) {
          if (isStopped()) break;
          this.items.push(item);
          this.notify();
        }
      } catch (error) {
        this.error = error;
      } finally {
        this.done = true;
        this.notify();
      }
    })();
  }

  /** Items so far (for tests and diagnostics). */
  get size(): number {
    return this.items.length;
  }

  get finished(): boolean {
    return this.done;
  }

  async *read(): AsyncIterable<T> {
    let index = 0;
    for (;;) {
      while (index < this.items.length) yield this.items[index++]!;
      if (this.done) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
