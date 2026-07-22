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
  headerLines: [],
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

Deno.test("composeFrame: cursor lands inside the box even with header+footer chrome", () => {
  // Regression: the footer sits BELOW the input box now, so the cursor row
  // must NOT add footerH. With header(1) + footer(1) + 1 input row on a 12-row
  // frame, output = 12-1-1-2-1 = 7; top border at row 1+7+1 = 9 (header then
  // 7 output rows → row 8 is the last output; row 9 is the top border), input
  // content on row 10. If footerH were wrongly added, the cursor would land on
  // the bottom border (row 11) — one row too low.
  const composed = composeFrame({
    rows: 12,
    cols: 20,
    headerLines: ["HEAD"],
    lines: Array(7).fill("OUT"),
    footerLines: ["FOOT"],
    inputRows: ["in"],
    inputCursor: { row: 0, col: 0 },
  })!;
  assertEquals(composed.cursorRow, 10); // the single input row, inside the box
});

Deno.test("composeFrame: output sits above the box, footer below it", () => {
  const composed = composeFrame({
    rows: 12,
    cols: 16,
    headerLines: [],
    lines: ["OUT1", "OUT2"],
    footerLines: ["FOOT1", "FOOT2"],
    inputRows: ["in"],
    inputCursor: { row: 0, col: 0 },
  })!;
  const text = plain(composed.text);
  // Order: output lines, then the bordered box, then the footer.
  const outIdx = text.indexOf("OUT1");
  const footIdx = text.indexOf("FOOT1");
  const boxIdx = text.indexOf("\u250C");
  assertEquals(outIdx < boxIdx, true);
  assertEquals(boxIdx < footIdx, true);
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

// ── frameRows: the row-array form used by the diff renderer ─────────────────

import {
  clearLineFor,
  frameRows,
  paintIsNoop,
  paintPlan,
  pickerRows,
} from "../src/tui/screen.ts";

Deno.test("frameRows: returns null when output would have no rows", () => {
  assertEquals(frameRows(base(3, 20)), null);
});

Deno.test("frameRows: returns null when cols too narrow for a box", () => {
  assertEquals(frameRows(base(30, 4)), null);
});

Deno.test("frameRows: row count equals the terminal height", () => {
  const fr = frameRows(base(12, 16, ["a"]))!;
  assertEquals(fr.rows.length, 12);
});

Deno.test("frameRows: cursor position matches composeFrame", () => {
  const f = {
    ...base(14, 20, ["one", "two", "three"]),
    inputCursor: { row: 2, col: 0 },
  };
  const composed = composeFrame(f)!;
  const fr = frameRows(f)!;
  assertEquals(fr.cursorRow, composed.cursorRow);
  assertEquals(fr.cursorCol, composed.cursorCol);
});

Deno.test("frameRows: rows joined with CLEAR_LINE+newline reproduce composeFrame", () => {
  // The string composer is a thin joiner over frameRows — keep them in lockstep.
  const f = {
    rows: 12,
    cols: 16,
    headerLines: [],
    lines: ["OUT1", "OUT2"],
    footerLines: ["FOOT1", "FOOT2"],
    inputRows: ["in"],
    inputCursor: { row: 0, col: 0 },
  };
  const composed = composeFrame(f)!;
  const fr = frameRows(f)!;
  const esc = String.fromCharCode(27);
  const joined = fr.rows
    .map((r, i) => r + esc + "[K" + (i < fr.rows.length - 1 ? "\n" : ""))
    .join("");
  assertEquals(composed.text, esc + "[?25h" + esc + "[H" + joined);
});

Deno.test("frameRows: a header sits above the output region", () => {
  const fr = frameRows({
    rows: 12,
    cols: 16,
    headerLines: ["HEAD"],
    lines: ["OUT1"],
    footerLines: ["FOOT"],
    inputRows: ["in"],
    inputCursor: { row: 0, col: 0 },
  })!;
  const text = fr.rows.map((r) => plain(r));
  assertEquals(text.indexOf("HEAD") < text.indexOf("OUT1"), true);
  assertEquals(text.indexOf("OUT1") < text.indexOf("FOOT"), true);
});

Deno.test("frameRows: a working line sits between output and the input box", () => {
  const fr = frameRows({
    rows: 10,
    cols: 16,
    headerLines: [],
    lines: ["OUT1", "OUT2"],
    footerLines: ["FOOT"],
    workingLine: "WORK",
    inputRows: ["in"],
    inputCursor: { row: 0, col: 0 },
  })!;
  assertEquals(fr.rows.length, 10);
  const text = fr.rows.map((r) => plain(r));
  // Order: output lines, working line, bordered input box, footer.
  assertEquals(text.indexOf("OUT1") < text.indexOf("WORK"), true);
  assertEquals(text.indexOf("WORK") < text.indexOf("FOOT"), true);
  const borderIdx = text.findIndex((r) => r.includes("\u250C"));
  assertEquals(text.indexOf("WORK") < borderIdx, true); // working above the box
  assertEquals(borderIdx < text.indexOf("FOOT"), true); // box above the footer
});

Deno.test("frameRows: a working line takes a row from output, not the input box", () => {
  const base2 = (workingLine?: string) => ({
    rows: 12,
    cols: 20,
    headerLines: [],
    lines: [],
    footerLines: [],
    inputRows: [""],
    inputCursor: { row: 0, col: 0 },
    workingLine,
  });
  const without = frameRows(base2())!;
  const withLine = frameRows(base2("WORK"))!;
  // Input box stays anchored to the bottom; the working line eats an output row.
  assertEquals(withLine.cursorRow, without.cursorRow);
  assertEquals(withLine.rows.length, without.rows.length);
});

// ── pickerRows ─────────────────────────────────────────────────────────────

Deno.test("pickerRows: returns null when too short", () => {
  assertEquals(
    pickerRows({ rows: 4, cols: 20, title: "t", rows_text: ["a"], hint: "h" }),
    null,
  );
});

Deno.test("pickerRows: row count equals the terminal height", () => {
  const rows = pickerRows({
    rows: 8,
    cols: 20,
    title: "t",
    rows_text: ["a", "b"],
    hint: "h",
  })!;
  assertEquals(rows.length, 8); // title + blank + 4 list + blank + hint
});

// ── paintPlan: the diff decision ───────────────────────────────────────────

Deno.test("paintPlan: null prev forces a full repaint", () => {
  const plan = paintPlan(null, null, ["a", "b"], "chat");
  assertEquals(plan.full, true);
  assertEquals(plan.rows, [{ index: 0, text: "a" }, { index: 1, text: "b" }]);
});

Deno.test("paintPlan: a mode change forces a full repaint", () => {
  const plan = paintPlan(["a", "b"], "chat", ["a", "b"], "picker");
  assertEquals(plan.full, true);
  assertEquals(plan.rows.length, 2);
});

Deno.test("paintPlan: a row-count change forces a full repaint", () => {
  const plan = paintPlan(["a", "b"], "chat", ["a"], "chat");
  assertEquals(plan.full, true);
});

Deno.test("paintPlan: unchanged content yields no rows to paint", () => {
  const plan = paintPlan(["a", "b"], "chat", ["a", "b"], "chat");
  assertEquals(plan.full, false);
  assertEquals(plan.rows, []);
});

Deno.test("paintPlan: only changed rows are listed", () => {
  const plan = paintPlan(["a", "b", "c"], "chat", ["a", "X", "c"], "chat");
  assertEquals(plan.full, false);
  assertEquals(plan.rows, [{ index: 1, text: "X" }]);
});

Deno.test("paintPlan: multiple changed rows are listed in order", () => {
  const plan = paintPlan(["a", "b", "c"], "chat", ["x", "b", "z"], "chat");
  assertEquals(plan.rows, [{ index: 0, text: "x" }, { index: 2, text: "z" }]);
});

// ── clearLineFor: the per-row ESC[K decision ──────────────────────────────

Deno.test("clearLineFor: a short row gets a clear-to-end suffix", () => {
  assertEquals(clearLineFor("hi", 120), "\x1b[K");
});

Deno.test("clearLineFor: a full-width row gets no suffix (last cell preserved)", () => {
  assertEquals(clearLineFor("a".repeat(120), 120), "");
});

Deno.test("clearLineFor: an over-wide row gets no suffix", () => {
  assertEquals(clearLineFor("a".repeat(121), 120), "");
});

Deno.test("clearLineFor: width is ANSI-aware (escapes are zero-width)", () => {
  const esc = String.fromCharCode(27);
  // visible width 2 ("hi"), escapes zero-width → still short → clear.
  assertEquals(clearLineFor(esc + "[2m" + "hi" + esc + "[0m", 120), "\x1b[K");
  // visible width 120 (styled) → full → no clear.
  const full = esc + "[2m" + "a".repeat(120) + esc + "[0m";
  assertEquals(clearLineFor(full, 120), "");
});

// ── paintIsNoop: the idle-tick skip decision ───────────────────────────────

/** A PaintPlan with no rows to write (an unchanged frame). */
const emptyPlan = paintPlan(["a", "b"], "chat", ["a", "b"], "chat");

Deno.test("paintIsNoop: content changed → never a no-op (even if cursor same)", () => {
  const changed = paintPlan(["a", "b"], "chat", ["a", "X"], "chat");
  assertEquals(
    paintIsNoop(changed, { row: 1, col: 1 }, { row: 1, col: 1 }),
    false,
  );
});

Deno.test("paintIsNoop: no content change, same cursor → no-op", () => {
  assertEquals(
    paintIsNoop(emptyPlan, { row: 5, col: 9 }, { row: 5, col: 9 }),
    true,
  );
});

Deno.test("paintIsNoop: no content change, cursor moved → must paint", () => {
  assertEquals(
    paintIsNoop(emptyPlan, { row: 5, col: 10 }, { row: 5, col: 9 }),
    false,
  );
});

Deno.test("paintIsNoop: picker→picker (cursor null both) → no-op", () => {
  assertEquals(paintIsNoop(emptyPlan, null, null), true);
});

Deno.test("paintIsNoop: chat→picker cursor change (null vs object) → must paint", () => {
  // Cursor disappearing (chat → picker) is a real change: the hardware cursor
  // must be hidden. Not a no-op even though content is identical.
  assertEquals(paintIsNoop(emptyPlan, null, { row: 5, col: 9 }), false);
  assertEquals(paintIsNoop(emptyPlan, { row: 5, col: 9 }, null), false);
});

Deno.test("paintIsNoop: a full-repaint plan is never a no-op", () => {
  // First paint / mode switch / row-count change → full plan with all rows.
  const full = paintPlan(null, null, ["a", "b"], "chat");
  assertEquals(
    paintIsNoop(full, { row: 1, col: 1 }, { row: 1, col: 1 }),
    false,
  );
});
