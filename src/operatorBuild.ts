/**
 * Whether this bundle is the operator build (`VITE_XEARCH_OPERATOR=1`).
 *
 * Split out of operatorSurface.ts into its own module so
 * src/operatorToken.ts can read the flag without importing the operator UI
 * (Dashboard, Connections) at all. Swapped to `operatorBuild.public.ts` in
 * the public build's module graph (vite.config.ts) — the same module-swap
 * technique operatorSurface.ts uses and explains: a plain
 * `if (import.meta.env...)` guard leaves both branches in the module graph
 * for the bundler to reason about, where a swap makes the other branch's
 * source simply not exist in this build.
 */
export const OPERATOR_BUILD: boolean = true;
