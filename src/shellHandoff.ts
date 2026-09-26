import { flush } from "solid-js";

/** What someone did in index.html's static search box before the app ran. */
export type ShellState = {
  typed: string;
  focused: boolean;
  submitted: boolean;
  /** The sort and "Stats for nerds" choices, which a replayed search uses. */
  sort: string;
  stats: boolean;
};

/**
 * Read the static shell's search box before it is cleared. index.html marks
 * its form `data-submitted` on an early Enter, so that is not lost either.
 */
export function captureShell(root: ParentNode): ShellState {
  const query = root.querySelector<HTMLInputElement>("#query");
  const form = root.querySelector<HTMLFormElement>("#form");

  return {
    typed: query?.value ?? "",
    focused: query !== null && query.ownerDocument.activeElement === query,
    submitted: form?.dataset.submitted === "1",
    sort: form?.querySelector<HTMLSelectElement>("select.sort")?.value ?? "",
    stats: form?.querySelector<HTMLInputElement>(".opts input[type=checkbox]")?.checked ?? false,
  };
}

/** Carry the shell's box into the live app, submitting if it was submitted. */
export function replayShell(state: ShellState, root: ParentNode): void {
  const query = root.querySelector<HTMLInputElement>("#query");

  if (!query) return;

  // The controls first: with the box still empty, a sort change only sets
  // the sort rather than searching.
  const sort = query.form?.querySelector<HTMLSelectElement>("select.sort");

  if (sort && state.sort && sort.value !== state.sort) {
    sort.value = state.sort;
    sort.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const stats = query.form?.querySelector<HTMLInputElement>(".opts input[type=checkbox]");

  if (stats && stats.checked !== state.stats) stats.click();

  if (state.typed) {
    query.value = state.typed;
    query.dispatchEvent(new Event("input", { bubbles: true }));
  }

  if (state.focused) query.focus();

  if (state.submitted && state.typed.trim()) {
    // The input handler's draft update must land before the submit reads it.
    flush();
    query.form?.requestSubmit();
  }
}
