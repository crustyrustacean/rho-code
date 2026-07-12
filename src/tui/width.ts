// ANSI-aware width utilities for the TUI. Each code point counts as one column
// (double-width/CJK handling is a known v1 limitation, consistent with wrap.ts
// and input.ts). ANSI escape sequences are zero-width. Kept pure — no I/O — so
// the footer/block layout math is unit-testable.

import { reset } from "../ansi.ts";

const ESC = "\x1b";

/** The visible (printable) width of a string: code-point count minus ANSI escapes. */
export function visibleWidth(str: string): number {
  let width = 0;
  let i = 0;
  const chars = [...str];
  while (i < chars.length) {
    const c = chars[i]!;
    if (c === ESC) {
      // Consume the whole escape: ESC, any intermediates, one final letter.
      i += 1;
      while (i < chars.length) {
        const f = chars[i]!;
        i += 1;
        if (/[A-Za-z]/.test(f)) break;
      }
      continue;
    }
    width += 1;
    i += 1;
  }
  return width;
}

/**
 * Truncate `str` to `width` visible columns. If `ellipsis` is given and the
 * string is too long, it replaces the tail and the result's visible width is
 * exactly `width`. A leading ANSI style prefix is preserved on the kept text.
 */
export function truncateToWidth(
  str: string,
  width: number,
  ellipsis: string = "",
): string {
  const chars = [...str];
  const ellipsisWidth = visibleWidth(ellipsis);
  if (visibleWidth(str) <= width) return str; // fits without truncation
  if (ellipsisWidth > width) {
    // Degenerate: ellipsis alone is wider than the budget — emit it clipped.
    return ellipsis.slice(0, Math.max(0, width));
  }
  const budget = width - ellipsisWidth;

  let out = "";
  let style = ""; // active SGR to re-apply on an appended ellipsis / trailing reset
  let used = 0;
  let i = 0;
  let truncated = false;
  while (i < chars.length) {
    const c = chars[i]!;
    if (c === ESC) {
      // Copy the whole escape into the output (it precedes the cut, zero-width).
      let j = i + 1;
      let finalByte = "";
      while (j < chars.length) {
        const f = chars[j]!;
        j += 1;
        if (/[A-Za-z]/.test(f)) {
          finalByte = f;
          break;
        }
      }
      if (finalByte === "") j = i + 1;
      const esc = chars.slice(i, j).join("");
      i = j;
      if (finalByte === "m" && esc.startsWith(`${ESC}[`)) {
        const params = esc.slice(2, esc.length - 1);
        if (params === "" || params === "0") style = "";
        else style += esc;
      }
      out += esc;
      continue;
    }
    if (used >= budget) {
      truncated = true;
      break;
    }
    out += c;
    used += 1;
    i += 1;
  }
  if (!truncated) return str; // fit without truncation — return verbatim
  // Close any active style after the cut; leave plain text untouched.
  if (ellipsis) {
    return style ? `${out}${ellipsis}${reset}` : `${out}${ellipsis}`;
  }
  return style ? `${out}${reset}` : out;
}

/**
 * Pad `str` on the right with spaces so its visible width equals `width`.
 * Strings already at or past `width` are returned unchanged.
 */
export function padRight(str: string, width: number): string {
  const w = visibleWidth(str);
  if (w >= width) return str;
  return str + " ".repeat(width - w);
}
