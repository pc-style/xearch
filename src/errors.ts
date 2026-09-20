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

/** The setters `runTask` drives while it runs one piece of async work. */
export type TaskStatus = {
  /** True while the work runs, false once it settles — success or failure. */
  setBusy: (busy: boolean) => void;
  /** Cleared before the work starts, then set to `success` or the failure text. */
  setMessage: (message: string) => void;
  /** Shown when the work resolves. Omit when the work speaks for itself. */
  success?: string;
};

/** Run one piece of async work and report it the same way everywhere: clear
 * the last message, raise the busy flag, and on the way out either show
 * `success` or `describeError`'s text — always lowering the busy flag, including
 * when the work throws.
 *
 * This lives at module scope on purpose. React Compiler cannot lower a
 * `try`/`finally` written inside a component or hook body ("Handle
 * TryStatement with a finalizer"), and a `finally` is exactly what guarantees
 * the busy flag comes back down. Out here the compiler never looks at it, and
 * the guarantee is kept in one place instead of being retyped per component. */
export const runTask = async (fn: () => Promise<unknown>, status: TaskStatus) => {
  status.setMessage("");
  status.setBusy(true);
  try {
    await fn();
    if (status.success) status.setMessage(status.success);
  } catch (e) {
    status.setMessage(describeError(e));
  } finally {
    status.setBusy(false);
  }
};

/** The busy flag plus the one message slot every async control in this app
 * needs, and `run` to drive them. Four components used to declare both states
 * and retype the same try/catch/finally around every mutation; they now share
 * this. Rename on destructuring to keep each screen's own vocabulary, e.g.
 * `const { message: error, setMessage: setError, run } = useTask()`. */
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const run = useCallback(
    (fn: () => Promise<unknown>, success?: string) => runTask(fn, { setBusy, setMessage, success }),
    [],
  );
  return { busy, setBusy, message, setMessage, run };
}
