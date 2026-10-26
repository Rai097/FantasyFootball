// Row summary + bullet details helpers shared by Trade Finder, bench upgrades and Breakout Targets
// (CLAUDE.md rule: a ≤ 255-char 1–2 sentence summary per row, details as short "label: value" items).
// The limits and makeSummary live in waivers.ts (the first user); this module adds the item builder.
import type { DetailItem } from "./types.js";
import { DETAIL_MAX, SUMMARY_MAX, makeSummary } from "./waivers.js";

export { DETAIL_MAX, SUMMARY_MAX, makeSummary };

/** Cut a value to ≤ 90 chars at a word boundary (never mid-word). */
export function clampItem(v: string): string {
  return v.length <= DETAIL_MAX ? v : `${v.slice(0, DETAIL_MAX - 1).replace(/\s+\S*$/, "")}…`;
}

/** Collects details items; values are clamped, empty values are skipped. */
export function detailBuilder() {
  const items: DetailItem[] = [];
  const add = (label: string, value: string | null | undefined, tone?: DetailItem["tone"]) => {
    if (!value) return;
    const v = clampItem(value.replace(/\.$/, ""));
    items.push(tone ? { label, value: v, tone } : { label, value: v });
  };
  return { items, add };
}

export const toneOf = (x: number, eps = 0.05): DetailItem["tone"] => (x > eps ? "pos" : x < -eps ? "neg" : undefined);
