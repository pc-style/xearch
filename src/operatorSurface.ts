import { lazy, type ComponentType } from "react";

/**
 * The operator UI, and whether this bundle has it.
 *
 * Two sites are built from this one source tree:
 *
 *   - the public one, deployed to Convex static hosting, which is the
 *     client-facing search app and nothing else;
 *   - the operator one, built with `VITE_XEARCH_OPERATOR=1`, served by nginx
 *     on this VM behind the exe.dev proxy's login, which is where the
 *     dashboard and the Connections panel live.
 *
 * The public build gets `operatorSurface.public.ts` in this module's place,
 * swapped by a resolve alias in vite.config.ts. That is deliberately a
 * module swap and not an `if (import.meta.env...)` guard: a guard leaves the
 * `import()` calls below in the module graph, and rolldown emits their
 * chunks whether or not any code can reach them — which is how the
 * dashboard ended up on convex.site in the first place. With the swap, the
 * public build's graph contains no edge to Dashboard or Connections at all,
 * so there is nothing to emit.
 *
 * `scripts/check-public-bundle.mjs` asserts that against the emitted files
 * after every public build, because this property lives in the bundler's
 * output rather than in anything TypeScript checks.
 */
export const OPERATOR_BUILD: boolean = true;

export type DashboardProps = {
  ensureSession: () => Promise<unknown>;
  close: () => void;
};

export const Dashboard: ComponentType<DashboardProps> | null = lazy(() => import("./Dashboard"));
export const ConnectionsPanel: ComponentType | null = lazy(
  () => import("./operator/Connections"),
);
