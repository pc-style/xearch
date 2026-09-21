import type { ReactNode } from "react";
import type { Tone } from "./format";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`library-badge tone-${tone}`}>{children}</span>;
}
