import assert from "node:assert/strict";
import { test } from "vitest";
import { hedgedStream } from "./hedge.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });

async function* stream(label: string, delayMs: number, signal: AbortSignal, fail = false) {
  await sleep(delayMs, signal);
  if (fail) throw new Error(`${label} failed`);
  yield `${label}:1`;
  yield `${label}:2`;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("a fast primary is used without hedging", async () => {
  let hedges = 0;
  const out = await collect(
    hedgedStream((signal, i) => stream(i === 0 ? "a" : "b", 5, signal), {
      hedgeAfterMs: 100,
      onHedge: () => (hedges += 1)
    })
  );
  assert.deepEqual(out, ["a:1", "a:2"]);
  assert.equal(hedges, 0);
});

test("a slow primary is hedged and the faster backup wins", async () => {
  const aborted: number[] = [];
  let winner = -1;
  const out = await collect(
    hedgedStream(
      (signal, i) => {
        signal.addEventListener("abort", () => aborted.push(i));
        return stream(i === 0 ? "slow" : "fast", i === 0 ? 300 : 10, signal);
      },
      { hedgeAfterMs: 30, onWinner: (i) => (winner = i) }
    )
  );
  assert.deepEqual(out, ["fast:1", "fast:2"]);
  assert.equal(winner, 1);
  assert.ok(aborted.includes(0)); // the slow one was cancelled
});

test("a failing primary fails over to the backup", async () => {
  let reason = "";
  const out = await collect(
    hedgedStream((signal, i) => stream(i === 0 ? "a" : "b", 5, signal, i === 0), {
      hedgeAfterMs: 1000,
      onHedge: (r) => (reason = r)
    })
  );
  assert.deepEqual(out, ["b:1", "b:2"]);
  assert.equal(reason, "error");
});

test("when both attempts fail the first error is thrown", async () => {
  await assert.rejects(
    collect(hedgedStream((signal, i) => stream(String(i), 5, signal, true), { hedgeAfterMs: 1000 })),
    /0 failed/
  );
});
