import { OPERATOR_BUILD } from "./operatorBuild";

/**
 * Build-time operator proof, threaded into every `requireOperator`-gated
 * Convex call (convex/access.ts) so the operator site needs no sign-in of
 * its own. The operator build is only ever served on :8080 behind the
 * exe.dev proxy's own login (docs/production.md) — being on that site
 * already IS the operator proof, so this carries a token baked in at build
 * time (`VITE_OPERATOR_TOKEN`, set from `scripts/deploy-operator-site.sh`)
 * rather than asking anyone to sign in.
 *
 * This file is swapped for `operatorToken.public.ts` in the public build's
 * module graph (vite.config.ts, same technique as operatorSurface.ts), so
 * the public bundle never contains this source at all — not merely a
 * branch that evaluates false at runtime. `scripts/check-public-bundle.mjs`
 * asserts neither "VITE_OPERATOR_TOKEN" nor "operatorToken" reaches the
 * public output. The `OPERATOR_BUILD` check below is a second, redundant
 * guard for anything that imports this module directly (e.g. a test)
 * without going through the alias — it must never be the only thing
 * standing between the token and the public bundle.
 */
export function operatorArgs() {
  if (!OPERATOR_BUILD) return {};

  const token = import.meta.env.VITE_OPERATOR_TOKEN;

  return token ? { operatorToken: token } : {};
}
