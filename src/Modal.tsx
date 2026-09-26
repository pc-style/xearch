import { createUniqueId, onCleanup, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "./icons";

/** A native modal `<dialog>`: focus trapping, Escape and the backdrop come free. */
export function Modal(props: {
  title: string;
  close: () => void;
  notice?: string;
  children: JSX.Element;
}) {
  const titleId = createUniqueId();
  let dialog!: HTMLDialogElement;

  onSettled(() => {
    if (!dialog.open) dialog.showModal();
  });

  // Removing an open dialog leaves focus on the page body in Chrome. Close it
  // while its opener still exists so the native dialog restores that focus.
  onCleanup(() => {
    if (dialog.open) dialog.close();
  });

  return (
    <dialog
      ref={(el) => {
        dialog = el;
      }}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        props.close();
      }}
      onClick={(e) => {
        // A click on the dialog element itself (not its contents) is the backdrop.
        if (e.target === dialog) props.close();
      }}
    >
      <div class="modal-inner">
        <header>
          <h2 id={titleId}>{props.title}</h2>
          <button type="button" class="ib" onClick={() => props.close()} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div class="modal-body">
          <Show when={props.notice}>
            <p role="status">{props.notice}</p>
          </Show>
          {props.children}
        </div>
      </div>
    </dialog>
  );
}
