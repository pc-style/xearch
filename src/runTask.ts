/**
 * Runs an async unit of work from an event handler and reports the outcome
 * through plain callbacks. Implemented with the two-argument `.then` form so
 * callers never need `try`/`finally` inside components (the React Compiler
 * build in use cannot compile `finally` clauses).
 */
export function runTask<T>(
  work: () => Promise<T>,
  handlers: {
    readonly onSuccess?: () => void;
    readonly onError?: (cause: unknown) => void;
    readonly onSettled?: () => void;
  },
): void {
  const reportError = (cause: unknown) => {
    try {
      handlers.onError?.(cause);
    } catch {
      // The chain is detached. A throw here must not become an unhandled rejection.
    }
  };

  const finish = () => {
    try {
      handlers.onSettled?.();
    } catch {
      // Same as reportError: cleanup runs, and its failure stays on this chain.
    }
  };

  // `Promise.resolve().then(work)` puts a synchronous throw from `work`
  // on the same chain as a rejected promise, so onError and onSettled still run.
  void Promise.resolve()
    .then(work)
    .then(
      () => {
        try {
          handlers.onSuccess?.();
        } catch (error) {
          reportError(error);
        }

        finish();
      },
      (cause: unknown) => {
        reportError(cause);
        finish();
      },
    )
    .catch(() => {
      // Terminal handler for the detached chain.
    });
}
