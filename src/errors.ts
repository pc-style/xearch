import { useState } from "react";
import { ConvexError } from "convex/values";

/** Read a Convex mutation/action error the way the app wants to show it.
 * ConvexError carries the intended message in `.data`; anything else is a
 * plain thrown Error, whose `.message` Convex wraps as
 * "[CONVEX M(fn)] [Request ID: ...] Server Error ... Uncaught Error: <text>"
 * to avoid leaking internals. Strip that wrapper down to the original text. */
export const describeError = (cause: unknown) =>
  cause instanceof ConvexError
    ? String(cause.data)
    : cause instanceof Error
      ? cause.message.replace(/\[CONVEX[^]*?Uncaught (?:Error|ConvexError):\s*/, "").split("\n")[0]
      : "Something went wrong. Try again.";

/** Where one task reports: a busy flag and the single line of text the
 * person sees. Components supply these; `runTask` only calls them. */
export type TaskReport = {
  setBusy: (busy: boolean) => void;
  setMessage: (message: string) => void;
};

export type TaskOptions = {
  /** Said when the work resolves. Omitted means success says nothing. */
  success?: string;
  /** Returns false once this caller has been superseded — a stale effect
   * whose cleanup already ran, say. Its updates then stop landing, so it can
   * never clear a newer run's busy flag or overwrite a newer message.
   * Defaults to "always listening". */
  alive?: () => boolean;
};

/**
 * Run one guarded piece of async work: clear the last message, raise the busy
 * flag, then either say `success` or say what went wrong — and always lower
 * the flag again, including when `fn` throws.
 *
 * This is a plain module-level function on purpose. The `finally` is the only
 * thing that guarantees the flag is cleared on every path, and React Compiler
 * cannot lower a `try`/`finally` written inside a component or hook. Keeping
 * the control flow here, and the state in the components, lets both be true.
 */
export async function runTask<T>(
  fn: () => Promise<T>,
  report: TaskReport,
  options: TaskOptions = {},
) {
  report.setMessage("");
  report.setBusy(true);

  try {
    await fn();

    if (options.success) report.setMessage(options.success);
  } catch (e) {
    report.setMessage(describeError(e));
  } finally {
    report.setBusy(false);
  }
}

export type Task = {
  /** True while `run`'s work is in flight. */
  busy: boolean;
  /** The success notice or error text from the last run, or "". */
  message: string;
  setMessage: (message: string) => void;
  /** A bare string is shorthand for `{ success }`. */
  run: <T>(fn: () => Promise<T>, options?: string | TaskOptions) => Promise<void>;
};

export type TaskRunner = <T>(
  fn: () => Promise<T>,
  options?: string | TaskOptions,
) => Promise<void>;

/**
 * The bookkeeping `useTask` needs when runs overlap, as a plain function so
 * it can be reasoned about and tested without a renderer.
 *
 * Nothing stops two runs overlapping — several buttons call `run` without
 * disabling themselves first — and one shared busy/message pair gets two
 * things wrong when they do. Both were true of every hand-rolled copy of
 * this pattern before it was consolidated; fixing them here fixes them
 * everywhere, which is the point of having one copy.
 *
 *   The first run to finish used to clear `busy` while a second was still
 *   working, so a spinner vanished mid-request. `busy` now stays raised
 *   until every run has finished.
 *
 *   An earlier run's error could land after a later run had already
 *   reported, leaving stale text on screen. Only the most recent invocation
 *   publishes a message.
 */
export function createTaskRunner(
  setBusy: (value: boolean) => void,
  setMessage: (value: string) => void,
): TaskRunner {
  let inFlight = 0;
  let latest = 0;

  return <T>(fn: () => Promise<T>, options: string | TaskOptions = {}) => {
    const settings: TaskOptions = options instanceof Object ? options : { success: options };
    const listening = settings.alive;
    latest += 1;
    const token = latest;
    // `alive` is the caller's own staleness test (an effect that has been
    // cleaned up); `token` is this runner's. Both must hold to say anything.
    const publishes = () => token === latest && (!listening || listening());
    inFlight += 1;

    return runTask(
      fn,
      {
        setBusy: (value) => {
          if (value) {
            if (!listening || listening()) setBusy(true);

            return;
          }

          // Counted down even when this run has gone stale, or the count
          // would leak and the spinner would never clear.
          inFlight = Math.max(0, inFlight - 1);

          if (inFlight === 0) setBusy(false);
        },
        setMessage: (value) => {
          if (publishes()) setMessage(value);
        },
      },
      settings,
    );
  };
}

/**
 * The busy flag and message line `runTask` reports to, owned as component
 * state. Components reach the runner through this hook rather than calling it
 * directly: a handler that closed over its own setters and passed them along
 * would read as a state updater with side effects in it, which is exactly the
 * tangle this replaces.
 */
export function useTask(): Task {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // Built once, lazily. The two setters are stable for the life of the
  // component, so the runner captured here stays correct, and its in-flight
  // bookkeeping survives re-renders — which is the whole point of it living
  // outside the render body.
  const [run] = useState(() => createTaskRunner(setBusy, setMessage));

  return { busy, message, setMessage, run };
}
