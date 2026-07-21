// ANSI-aware line wrapping for the TUI output region. Wraps a (possibly
// styled) line into segments each no wider than `cols` visible columns,
// re-applying active SGR styling at the start of each wrapped segment so bold /
// code / color spans survive the break. Trailing resets are intentionally NOT
// emitted here — the renderer resets each row after painting it.
//
// Each code point counts as one column (double-width/CJK accounting is a known
// v1 limitation). Wrapping is character-based, not word-based.

import { consumeAnsiEscape, ESC } from "../ansi.ts";

/** Wrap `line` into segments each ≤ `cols` visible columns. */
export function wrapLine(line: string, cols: number): string[] {
  if (cols <= 0) return [""];
  const chars = [...line];
  const segments: string[] = [];
  let out = "";
  let style = ""; // active SGR escapes to re-apply after a wrap
  let width = 0;
  let i = 0;

  while (i < chars.length) {
    const c = chars[i]!;

    if (c === ESC) {
      const seq = consumeAnsiEscape(chars, i);
      if (!seq) {
        i += 1;
        continue;
      } // incomplete — skip
      i = seq.end;

      // Track SGR state: a reset (empty params or 0) clears; anything else
      // accumulates into the active style to re-apply across wraps.
      const finalByte = seq.esc[seq.esc.length - 1]!;
      if (finalByte === "m" && seq.esc.startsWith(`${ESC}[`)) {
        const params = seq.esc.slice(2, seq.esc.length - 1);
        if (params === "" || params === "0") style = "";
        else style += seq.esc;
      }
      out += seq.esc; // escapes are zero-width; keep them inline where they occur
      continue;
    }

    // Visible character (width 1 for v1).
    if (width + 1 > cols && out !== "") {
      segments.push(out);
      out = style + c;
      width = 1;
    } else {
      out += c;
      width += 1;
    }
    i++;
  }
  segments.push(out);
  return segments;
}
