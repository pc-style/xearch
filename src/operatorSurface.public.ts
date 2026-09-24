import type { ComponentType } from "react";
import type { DashboardProps } from "./operatorSurface";

/**
 * The public build's stand-in for `operatorSurface.ts`, substituted by the
 * resolve alias in vite.config.ts whenever `VITE_XEARCH_OPERATOR` is not
 * "1". It imports nothing, so the dashboard and the Connections panel are
 * not in the public module graph and no chunk for them is emitted.
 *
 * Read `operatorSurface.ts` for why the exclusion is a module swap rather
 * than a build-time flag.
 */
export const OPERATOR_BUILD: boolean = false;

export type { DashboardProps };

export const Dashboard: ComponentType<DashboardProps> | null = null;

export const ConnectionsPanel: ComponentType | null = null;
