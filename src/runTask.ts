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
  work().then(
    () => {
      try {
        handlers.onSuccess?.();
      } catch (error) {
        handlers.onError?.(error);
      } finally {
        handlers.onSettled?.();
      }
    },
    (error: unknown) => {
      handlers.onError?.(error);
      handlers.onSettled?.();
    },
  );
}
