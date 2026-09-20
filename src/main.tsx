import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { Component, StrictMode, type ReactNode } from "react";
import App from "./App";
import "./style.css";
class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  override state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  override render() {
    return this.state.error ? (
      <main className="setup">
        <h1>Couldn't connect to Xearch.</h1>
        <p>Check that the backend is running, then reload.</p>
        <button onClick={() => location.reload()}>Reload</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
const url = import.meta.env.VITE_CONVEX_URL;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {url ? (
      <Boundary>
        <ConvexAuthProvider client={new ConvexReactClient(url)}>
          <App />
        </ConvexAuthProvider>
      </Boundary>
    ) : (
      <main className="setup">
        <h1>Xearch</h1>
        <p>
          Start the backend with <code>bun run backend</code>, then restart the frontend. The local
          setup creates VITE_CONVEX_URL automatically.
        </p>
      </main>
    )}
  </StrictMode>,
);
