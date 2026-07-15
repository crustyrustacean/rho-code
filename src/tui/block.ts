// Full-width background block renderer, mirroring pi's `Box` component: wraps
// (possibly multi-line, ANSI-styled) content into `cols`-wide lines, each
// painted with a solid `bgCode` background and `padX` columns of inner
// padding. ANSI resets inside the content re-apply the background so a styled
// span can't punch a hole in the block.
//
// Pure — no I/O — so the layout is unit-testable. Width is computed at call
// time from `cols`; the caller passes the current terminal width (resize
// reflow is an accepted v1 limitation, consistent with wrap.ts).

import { consumeAnsiEscape, ESC, reset } from "../ansi.ts";
import { padRight } from "./width.ts";
import { wrapLine } from "./wrap.ts";

/** True if an SGR escape's params include a reset (empty, 0, or "...;0;..."). */
function isSgrReset(esc: string): boolean {
  // esc looks like "\x1b[...m"
  if (!esc.startsWith(`${ESC}[`) && !esc.endsWith("m")) return false;
  const params = esc.slice(2, esc.length - 1);
  if (params === "") return true;
  return params.split(";").some((p) => p === "0");
}

/**
 * Re-apply `bgCode` after every SGR reset inside `line`, so a `${reset}` in
 * the content can't clear the block's background. Does not prefix `bgCode` —
 * the caller paints the leading background itself.
 */
function reapplyBgAfterResets(line: string, bgCode: string): string {
  const chars = [...line];
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === ESC) {
      const seq = consumeAnsiEscape(chars, i);
      if (!seq) { i += 1; continue; }
      out += seq.esc;
      i = seq.end;
      const finalByte = seq.esc[seq.esc.length - 1]!;
      if (finalByte === "m" && isSgrReset(seq.esc)) out += bgCode;
      continue;
    }
    out += chars[i]!;
    i += 1;
  }
  return out;
}

/**
 * Render `content` as one or more full-width background block lines.
 *
 * `content` may contain newlines and ANSI styling. Each visible line is padded
 * to exactly `cols` columns and wrapped in `bgCode` … `reset`. Returns `[]`
 * when `cols` is too narrow for `padX` (inner width would be ≤ 0).
 */
export function blockLines(
  content: string,
  cols: number,
  bgCode: string,
  padX = 1,
): string[] {
  const inner = cols - 2 * padX;
  if (inner <= 0) return [];
  const pad = " ".repeat(padX);
  const out: string[] = [];
  for (const piece of content.split("\n")) {
    for (const seg of wrapLine(piece, inner)) {
      const body = `${pad}${reapplyBgAfterResets(seg, bgCode)}`;
      out.push(`${bgCode}${padRight(body, cols)}${reset}`);
    }
  }
  return out;
}

/** A single blank block line filling the full `cols` with `bgCode`. */
export function blockBlank(cols: number, bgCode: string): string {
  if (cols <= 0) return "";
  return `${bgCode}${padRight("", cols)}${reset}`;
}
