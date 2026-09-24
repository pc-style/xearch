import { render } from "@solidjs/web";
import { Errored } from "solid-js";
import { BaseConvexClient } from "convex/browser";
import App from "./App";
import { ConvexContext, createConvexApp } from "./data/convex";
import { createAuthClient } from "./data/auth";
import { describeError } from "./errors";
import { captureError, initPostHog } from "./posthog";
import "./style.css";

function Connected(props: { url: string }) {
  const sync = new BaseConvexClient(props.url, () => {});
  const auth = createAuthClient({ address: props.url, sync });

  return (
    <ConvexContext value={createConvexApp(sync, auth, auth)}>
      <App />
    </ConvexContext>
  );
}

initPostHog();

const url = import.meta.env.VITE_CONVEX_URL;

render(
  () =>
    url ? (
      <Errored
        fallback={(error) => {
          const cause = error();
          captureError(
            cause instanceof Error ? cause : new Error(describeError(cause)),
            "boundary",
          );

          // Not a connectivity message: this boundary also catches a query
          // the backend answered with an error, and App's own banner already
          // reports a lost connection.
          return (
            <main class="setup">
              <h1>Something went wrong.</h1>
              <p>{describeError(cause)}</p>
              <button type="button" class="imp" onClick={() => location.reload()}>
                Reload
              </button>
            </main>
          );
        }}
      >
        <Connected url={url} />
      </Errored>
    ) : (
      <main class="setup">
        <h1>Xearch</h1>
        <p>
          Start the backend with <code>bun run backend</code>, then restart the frontend. The local
          setup creates VITE_CONVEX_URL automatically.
        </p>
      </main>
    ),
  document.getElementById("root")!,
);
