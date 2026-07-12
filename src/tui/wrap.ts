// ANSI-aware line wrapping for the TUI output region. Wraps a (possibly
// styled) line into segments each no wider than `cols` visible columns,
// re-applying active SGR styling at the start of each wrapped segment so bold /
// code / color spans survive the break. Trailing resets are intentionally NOT
// emitted here — the renderer resets each row after painting it.
//
// Each code point counts as one column (double-width/CJK accounting is a known
// v1 limitation). Wrapping is character-based, not word-based.

const ESC = "\x1b";

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
      // Consume an escape: ESC, any intermediates, then a final letter.
      let j = i + 1;
      let finalByte = "";
      while (j < chars.length) {
        const f = chars[j]!;
        if (/[A-Za-z]/.test(f)) {
          finalByte = f;
          j++;
          break;
        }
        j++;
      }
      if (finalByte === "") j = i + 1; // malformed escape; consume ESC only
      const esc = chars.slice(i, j).join("");
      i = j;

      // Track SGR state: a reset (empty params or 0) clears; anything else
      // accumulates into the active style to re-apply across wraps.
      if (finalByte === "m" && esc.startsWith(`${ESC}[`)) {
        const params = esc.slice(2, esc.length - 1);
        if (params === "" || params === "0") style = "";
        else style += esc;
      }
      out += esc; // escapes are zero-width; keep them inline where they occur
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
