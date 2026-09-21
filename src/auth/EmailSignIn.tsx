import { useId, useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { useAuthActions } from "@convex-dev/auth/react";
import { useTask } from "../errors";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const styles = stylex.create({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  label: {
    fontSize: 12,
  },
  submit: {
    marginTop: 8,
  },
  error: {
    fontSize: 12,
    color: "#e3a99e",
  },
});

export type EmailSignInProps = {
  /** StyleX styles applied to the root element; the integrator owns the visual styling. */
  xstyle?: stylex.StyleXStyles;
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
 * Unstyled by design: mount it wherever a "sign in with email" affordance is
 * needed (e.g. the Connections panel or a settings page) and style it via
 * xstyle to match.
 *
 * Wired into the app in src/App.tsx: it renders inside the "Email these
 * results" modal (gating Send until the caller has a verified email) and in
 * the Connections panel, alongside AccountBadge. src/App.tsx also threads
 * api.email.preview into that same send modal.
 */
export function EmailSignIn({ xstyle, onSignedIn }: EmailSignInProps) {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const { busy: pending, message: error, setMessage: setError, run } = useTask();
  const emailFieldId = useId();
  const codeFieldId = useId();

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    await run(async () => {
      await signIn("email", { email: trimmed });
      setEmail(trimmed);
      setCode("");
      setStep("verify");
    });
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setError("Enter the code from your email.");
      return;
    }
    await run(async () => {
      await signIn("email", { email, code: trimmedCode });
      setCode("");
      onSignedIn?.();
    });
  };

  const useDifferentEmail = () => {
    setStep("request");
    setCode("");
    setError("");
  };

  return (
    <div {...stylex.props(xstyle)}>
      {step === "request" ? (
        <form onSubmit={requestCode} {...stylex.props(styles.form)}>
          <label htmlFor={emailFieldId} {...stylex.props(styles.label)}>
            Email address
          </label>
          <input
            id={emailFieldId}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={pending}
            required
          />
          <button type="submit" disabled={pending} {...stylex.props(styles.submit)}>
            {pending ? "Sending…" : "Send sign-in code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode} {...stylex.props(styles.form)}>
          <p role="status">Enter the code sent to {email}.</p>
          <label htmlFor={codeFieldId} {...stylex.props(styles.label)}>
            Sign-in code
          </label>
          <input
            id={codeFieldId}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Code from email"
            disabled={pending}
            required
          />
          <button type="submit" disabled={pending} {...stylex.props(styles.submit)}>
            {pending ? "Verifying…" : "Verify and sign in"}
          </button>
          <button type="button" onClick={useDifferentEmail} disabled={pending}>
            Use a different email
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default EmailSignIn;
