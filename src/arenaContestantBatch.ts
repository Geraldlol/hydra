export interface ArenaContestantBatchControl {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

/**
 * Runs a contestant batch with one controller-owned cancellation signal.
 *
 * The first rejected task aborts every sibling, but the primary error is not
 * rethrown until all tasks have settled. This is intentionally a drain
 * boundary: callers may close monitors or abandon recovery ownership only
 * after every supervised process has either proved termination or returned an
 * explicit unconfirmed result.
 */
export async function runArenaContestantBatch<T, R>(
  items: readonly T[],
  parentSignal: AbortSignal,
  run: (item: T, control: ArenaContestantBatchControl) => Promise<R>,
): Promise<readonly R[]> {
  if (!(parentSignal instanceof AbortSignal)) {
    throw new Error("Arena contestant batch signal must be an AbortSignal.");
  }
  const controller = new AbortController();
  const forwardParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    forwardParentAbort();
  } else {
    parentSignal.addEventListener("abort", forwardParentAbort, { once: true });
  }

  let firstFailure: { readonly error: unknown } | undefined;
  const control: ArenaContestantBatchControl = Object.freeze({
    signal: controller.signal,
    abort(reason?: unknown) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  });
  const tasks = items.map((item) =>
    Promise.resolve()
      .then(() => run(item, control))
      .catch((error: unknown) => {
        firstFailure ??= { error };
        control.abort(error);
        throw error;
      }));

  try {
    const settled = await Promise.allSettled(tasks);
    if (firstFailure) throw firstFailure.error;
    const lateFailure = settled.find(
      (candidate): candidate is PromiseRejectedResult =>
        candidate.status === "rejected",
    );
    if (lateFailure) throw lateFailure.reason;
    return Object.freeze(
      settled.map((candidate) =>
        (candidate as PromiseFulfilledResult<R>).value),
    );
  } finally {
    parentSignal.removeEventListener("abort", forwardParentAbort);
  }
}
