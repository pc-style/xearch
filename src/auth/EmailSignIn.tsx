import { createSignal, createUniqueId, Show } from "solid-js";
import { useConvex } from "../data/convex";
import { useTask } from "../errors";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailSignInProps = {
  /** Applied to the root element; the integrator owns the visual styling. */
  class?: string;
  /** Called once `signIn("email", { email, code })` resolves. */
  onSignedIn?: () => void;
};

/**
 * Two-step, durable email sign-in on top of @convex-dev/auth's stock Email
 * provider (convex/auth.ts): request a one-time code, then verify it. Codes
 * are delivered through AgentMail (see convex/auth.ts's
 * sendVerificationRequest) - this component only drives the two `signIn`
 * calls and never talks to AgentMail directly.
 *
 * Wired into the app in src/App.tsx: it renders inside the "Email these
 * results" modal, gating Send until the caller has a verified email.
 */
export function EmailSignIn(props: EmailSignInProps) {
  const { actions } = useConvex();
  const [step, setStep] = createSignal<"request" | "verify">("request");
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const { busy: pending, message: error, setMessage: setError, run } = useTask();
  const emailFieldId = createUniqueId();
  const codeFieldId = createUniqueId();

  const requestCode = async (e: SubmitEvent) => {
    e.preventDefault();
    const trimmed = email().trim().toLowerCase();

    if (!EMAIL_PATTERN.test(trimmed)) {
      setError("Enter a valid email address.");

      return;
    }

    await run(async () => {
      await actions.signIn("email", { email: trimmed });
      setEmail(trimmed);
      setCode("");
      setStep("verify");
    });
  };

  const verifyCode = async (e: SubmitEvent) => {
    e.preventDefault();
    const trimmedCode = code().trim();

    if (!trimmedCode) {
      setError("Enter the code from your email.");

      return;
    }

    await run(async () => {
      await actions.signIn("email", { email: email(), code: trimmedCode });
      setCode("");
      props.onSignedIn?.();
    });
  };

  const useDifferentEmail = () => {
    setStep("request");
    setCode("");
    setError("");
  };

  return (
    <div class={props.class}>
      <Show
        when={step() === "verify"}
        fallback={
          <form onSubmit={requestCode}>
            <label for={emailFieldId}>Email address</label>
            <input
              id={emailFieldId}
              type="email"
              inputmode="email"
              autocomplete="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              placeholder="you@example.com"
              disabled={pending()}
              required
            />
            <button type="submit" class="go" disabled={pending()}>
              {pending() ? "Sending…" : "Send sign-in code"}
            </button>
          </form>
        }
      >
        <form onSubmit={verifyCode}>
          <p role="status">Enter the code sent to {email()}.</p>
          <label for={codeFieldId}>Sign-in code</label>
          <input
            id={codeFieldId}
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value)}
            placeholder="Code from email"
            disabled={pending()}
            required
          />
          <button type="submit" class="go" disabled={pending()}>
            {pending() ? "Verifying…" : "Verify and sign in"}
          </button>
          <button
            type="button"
            class="text-button"
            onClick={useDifferentEmail}
            disabled={pending()}
          >
            Use a different email
          </button>
        </form>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </div>
  );
}

export default EmailSignIn;
