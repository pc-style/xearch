import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import type { Tone } from "./format";
import { ops } from "../styles/ops.stylex";

const tones = {
  neutral: null,
  positive: ops.badgePositive,
  info: ops.badgeInfo,
  warning: ops.badgeWarning,
  danger: ops.badgeDanger,
} as const;

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span {...stylex.props(ops.badge, tones[tone])}>{children}</span>;
}
