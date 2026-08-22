import assert from "node:assert/strict";
import { test } from "node:test";
import { runArenaContestantBatch } from "../src/arenaContestantBatch";

test(
  "aborts siblings on the first rejection and drains them before rethrowing it",
  { timeout: 5_000 },
  async () => {
    const parent = new AbortController();
    const hangingStarted = deferred<void>();
    const hangingObservedAbort = deferred<void>();
    const releaseDrain = deferred<void>();
    const primaryFailure = new Error("primary contestant failure");
    const secondaryFailure = new Error("secondary drained failure");
    const invocations = new Map<string, number>();
    let sharedBatchSignal: AbortSignal | undefined;
    let settled = false;

    const running = runArenaContestantBatch(
      ["hanging", "failing"] as const,
      parent.signal,
      async (item, control): Promise<never> => {
        invocations.set(item, (invocations.get(item) ?? 0) + 1);
        if (sharedBatchSignal === undefined) {
          sharedBatchSignal = control.signal;
        } else {
          assert.strictEqual(control.signal, sharedBatchSignal);
        }
        if (item === "failing") {
          await hangingStarted.promise;
          throw primaryFailure;
        }

        hangingStarted.resolve();
        if (control.signal.aborted) {
          hangingObservedAbort.resolve();
        } else {
          control.signal.addEventListener(
            "abort",
            () => hangingObservedAbort.resolve(),
            { once: true },
          );
        }
        await hangingObservedAbort.promise;
        await releaseDrain.promise;
        throw secondaryFailure;
      },
    );
    const observed = running.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ).finally(() => {
      settled = true;
    });

    try {
      await withTimeout(
        hangingObservedAbort.promise,
        1_000,
        "batch did not abort its hanging sibling",
      );
      assert.equal(sharedBatchSignal?.aborted, true);
      assert.equal(parent.signal.aborted, false);
      assert.equal(settled, false);
      assert.deepEqual([...invocations.entries()].sort(), [
        ["failing", 1],
        ["hanging", 1],
      ]);

      releaseDrain.resolve();
      const outcome = await observed;
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") {
        assert.strictEqual(outcome.error, primaryFailure);
      }
      assert.equal(settled, true);
      assert.equal(parent.signal.aborted, false);
    } finally {
      releaseDrain.resolve();
      parent.abort(new Error("test teardown"));
      await observed;
    }
  },
);

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T extends void ? never : T): void;
  resolve(): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise(value as T);
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
