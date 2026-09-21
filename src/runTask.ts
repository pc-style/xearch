/**
 * Runs an async unit of work from an event handler and reports the outcome
 * through plain callbacks. Implemented with the two-argument `.then` form so
 * callers never need `try`/`finally` inside components (the React Compiler
 * build in use cannot compile `finally` clauses).
 */
export function runTask(
  work: () => Promise<unknown>,
  handlers: {
    readonly onSuccess?: () => void;
    readonly onError?: (error: unknown) => void;
    readonly onSettled?: () => void;
  },
): void {
  const reportError = (error: unknown) => {
    try {
      handlers.onError?.(error);
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
  void work()
    .then(
      () => {
        try {
          handlers.onSuccess?.();
        } catch (error) {
          reportError(error);
        }
        finish();
      },
      (error: unknown) => {
        reportError(error);
        finish();
      },
    )
    .catch(() => {
      // Terminal handler for the detached chain.
    });
}
