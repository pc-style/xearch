import { useCallback, useState } from "react";
import { ConvexError } from "convex/values";

/** Read a Convex mutation/action error the way the app wants to show it.
 * ConvexError carries the intended message in `.data`; anything else is a
 * plain thrown Error, whose `.message` Convex wraps as
 * "[CONVEX M(fn)] [Request ID: ...] Server Error ... Uncaught Error: <text>"
 * to avoid leaking internals. Strip that wrapper down to the original text. */
export const describeError = (e: unknown) =>
  e instanceof ConvexError
    ? String(e.data)
    : e instanceof Error
      ? e.message.replace(/\[CONVEX[^]*?Uncaught (?:Error|ConvexError):\s*/, "").split("\n")[0]
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
export async function runTask(
  fn: () => Promise<unknown>,
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
  run: (fn: () => Promise<unknown>, options?: string | TaskOptions) => Promise<void>;
};

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
  const run = useCallback((fn: () => Promise<unknown>, options: string | TaskOptions = {}) => {
    const settings: TaskOptions = typeof options === "string" ? { success: options } : options;
    const listening = settings.alive;
    return runTask(
      fn,
      {
        setBusy: (value) => {
          if (!listening || listening()) setBusy(value);
        },
        setMessage: (value) => {
          if (!listening || listening()) setMessage(value);
        },
      },
      settings,
    );
  }, []);
  return { busy, message, setMessage, run };
}
