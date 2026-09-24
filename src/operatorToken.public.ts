/**
 * The public build's stand-in for `operatorToken.ts`, substituted by the
 * resolve alias in vite.config.ts. It never references
 * `VITE_OPERATOR_TOKEN` or the `operatorToken` property at all, so neither
 * the name nor a value can reach the public bundle — read `operatorToken.ts`
 * for why the exclusion is a module swap rather than a build-time flag.
 */
export function operatorArgs() {
  return {};
}
