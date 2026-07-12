// Tests for the pure frame composer — the bordered multi-line input box layout.
// composeFrame returns the ANSI string + cursor position without touching the
// terminal, so the layout math is unit-testable.

import { composeFrame } from "../src/tui/screen.ts";
import { gray, reset } from "../src/ansi.ts";
import { assertEquals } from "@std/assert";

/** Strip ANSI escapes and box-art border chars for legible assertions. */
function plain(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*[mK]`, "g"), "");
}

const base = (rows: number, cols: number, inputRows = [""]) => ({
  rows,
  cols,
  lines: [],
  footerLines: [],
  inputRows,
  inputCursor: { row: 0, col: 0 },
});

Deno.test("composeFrame: a normal frame composes to a non-null result", () => {
  assertEquals(composeFrame(base(10, 20)) !== null, true);
});

Deno.test("composeFrame: renders top/bottom borders and one input row", () => {
  const composed = composeFrame(base(10, 12, ["hi"]))!;
  const text = plain(composed.text);
  // Top border, one content row, bottom border each present.
  assertEquals(text.includes("\u250C"), true); // ┌
  assertEquals(text.includes("\u2510"), true); // ┐
  assertEquals(text.includes("\u2514"), true); // └
  assertEquals(text.includes("\u2518"), true); // ┘
  assertEquals(text.includes("\u2502 hi       \u2502"), true); // │ hi padded │
});

Deno.test("composeFrame: input rows are padded to the inner width", () => {
  const composed = composeFrame(base(8, 10, ["a"]))!;
  // cols 10 → inner width 6; row is `│ ` + padRight("a",6) + ` │`.
  const expected = "\u2502 " + "a" + " ".repeat(5) + " \u2502";
  assertEquals(plain(composed.text).includes(expected), true);
});

Deno.test("composeFrame: multi-line input renders one bordered row per line", () => {
  const composed = composeFrame(base(12, 12, ["foo", "bar"]))!;
  const text = plain(composed.text);
  assertEquals(text.includes("\u2502 foo      \u2502"), true);
  assertEquals(text.includes("\u2502 bar      \u2502"), true);
});

Deno.test("composeFrame: cursor lands inside the box at the right column", () => {
  const composed = composeFrame({
    ...base(10, 20, ["hello"]),
    inputCursor: { row: 0, col: 2 },
  })!;
  // 10 rows, no footer, 1 input row: output=7, top border at row 8, content row 9.
  assertEquals(composed.cursorRow, 9);
  // │(1) + space(1) + col 2 → column 3 (1-based) is first content, so col 2 → 3+2? No:
  // cursorCol = 3 + col = 3 + 2 = 5.
  assertEquals(composed.cursorCol, 5);
});

Deno.test("composeFrame: cursor row tracks the input cursor across lines", () => {
  const composed = composeFrame({
    ...base(14, 20, ["one", "two", "three"]),
    inputCursor: { row: 2, col: 0 },
  })!;
  // 14 rows, no footer, 3 input rows: output = 14-5 = 9, top border row 10,
  // content rows 11,12,13; cursor on row index 2 → row 13.
  assertEquals(composed.cursorRow, 13);
});

Deno.test("composeFrame: output + footer sit above the input box", () => {
  const composed = composeFrame({
    rows: 12,
    cols: 16,
    lines: ["OUT1", "OUT2"],
    footerLines: ["FOOT1", "FOOT2"],
    inputRows: ["in"],
    inputCursor: { row: 0, col: 0 },
  })!;
  const text = plain(composed.text);
  // Order: output lines, then footer, then the bordered box.
  const outIdx = text.indexOf("OUT1");
  const footIdx = text.indexOf("FOOT1");
  const boxIdx = text.indexOf("\u250C");
  assertEquals(outIdx < footIdx, true);
  assertEquals(footIdx < boxIdx, true);
});

Deno.test("composeFrame: borders use the gray accent color", () => {
  const composed = composeFrame(base(10, 12, ["x"]))!;
  assertEquals(composed.text.includes(gray + "\u250C"), true);
  assertEquals(composed.text.includes(reset + "\u2518"), false); // bottom ends with reset after ┘
});

Deno.test("composeFrame: returns null when output would have no rows", () => {
  // footer 0, input box 3 rows → need rows >= 4 for 1 output row.
  assertEquals(composeFrame(base(3, 20)), null);
});

Deno.test("composeFrame: returns null when cols too narrow for a box", () => {
  assertEquals(composeFrame(base(30, 4)), null); // inner width 0
});

// ── composePickerFrame: the session-picker overlay layout ───────────────────

import { composePickerFrame } from "../src/tui/screen.ts";

Deno.test("composePickerFrame: title, list rows, and hint render in order", () => {
  const composed = composePickerFrame({
    rows: 8,
    cols: 20,
    title: "TITLE",
    rows_text: ["row-a", "row-b"],
    hint: "HINT",
  })!;
  const text = plain(composed.text);
  const tIdx = text.indexOf("TITLE");
  const rIdx = text.indexOf("row-a");
  const hIdx = text.indexOf("HINT");
  assertEquals(tIdx < rIdx && rIdx < hIdx, true);
});

Deno.test("composePickerFrame: too-short terminal returns null", () => {
  // rows 4 → list height 0 (need title+blank+1 row+blank+hint = 5).
  assertEquals(
    composePickerFrame({
      rows: 4,
      cols: 20,
      title: "t",
      rows_text: ["a"],
      hint: "h",
    }),
    null,
  );
});

Deno.test("composePickerFrame: hides the hardware cursor", () => {
  const composed = composePickerFrame({
    rows: 8,
    cols: 20,
    title: "t",
    rows_text: ["a"],
    hint: "h",
  })!;
  const esc = String.fromCharCode(27);
  assertEquals(composed.text.startsWith(esc + "[?25l"), true);
  assertEquals(composed.cursorRow, 8); // hint is the last row
});
