// Tests for the input editor — pure keystroke → text/cursor state, no terminal.

import { InputEditor, inputView } from "../src/tui/input.ts";
import { char, k } from "./helpers.ts";
import { assertEquals } from "@std/assert";

Deno.test("InputEditor: typing chars appends and advances the cursor", () => {
  const ed = new InputEditor();
  ed.handle(char("a"));
  ed.handle(char("b"));
  ed.handle(char("c"));
  assertEquals(ed.text, "abc");
  assertEquals(ed.cursor, 3);
});

Deno.test("InputEditor: backspace deletes the char before the cursor", () => {
  const ed = new InputEditor();
  for (const c of "abc") ed.handle(char(c));
  ed.handle(k("backspace"));
  assertEquals(ed.text, "ab");
  assertEquals(ed.cursor, 2);
});

Deno.test("InputEditor: backspace at position 0 is a no-op", () => {
  const ed = new InputEditor();
  ed.handle(k("backspace"));
  assertEquals(ed.text, "");
  assertEquals(ed.cursor, 0);
});

Deno.test("InputEditor: arrows move the cursor; typing inserts at the cursor", () => {
  const ed = new InputEditor();
  for (const c of "abc") ed.handle(char(c)); // "abc", cursor 3
  ed.handle(k("arrow", "left")); // cursor 2
  ed.handle(k("arrow", "left")); // cursor 1
  ed.handle(char("X")); // insert at 1 -> "aXbc", cursor 2
  assertEquals(ed.text, "aXbc");
  assertEquals(ed.cursor, 2);
});

Deno.test("InputEditor: home/end jump to the line edges", () => {
  const ed = new InputEditor();
  for (const c of "abc") ed.handle(char(c));
  ed.handle(k("home"));
  assertEquals(ed.cursor, 0);
  ed.handle(k("end"));
  assertEquals(ed.cursor, 3);
});

Deno.test("InputEditor: Ctrl-A / Ctrl-E are home / end (readline bindings)", () => {
  const ed = new InputEditor();
  for (const c of "abc") ed.handle(char(c));
  ed.handle(k("ctrl", "a"));
  assertEquals(ed.cursor, 0);
  ed.handle(k("ctrl", "e"));
  assertEquals(ed.cursor, 3);
});

Deno.test("InputEditor: Ctrl-U clears the line", () => {
  const ed = new InputEditor();
  for (const c of "abc") ed.handle(char(c));
  ed.handle(k("ctrl", "u"));
  assertEquals(ed.text, "");
  assertEquals(ed.cursor, 0);
});

Deno.test("InputEditor: Ctrl-W deletes the previous word", () => {
  const ed = new InputEditor();
  for (const c of "hello world") ed.handle(char(c));
  ed.handle(k("ctrl", "w"));
  assertEquals(ed.text, "hello ");
});

Deno.test("InputEditor: Enter submits the text and clears the buffer", () => {
  const ed = new InputEditor();
  for (const c of "hi") ed.handle(char(c));
  const r1 = ed.handle(k("enter"));
  assertEquals(r1.submitted, "hi");
  assertEquals(ed.text, "");
  assertEquals(ed.cursor, 0);
});

Deno.test("InputEditor: Enter on an empty line submits nothing", () => {
  const ed = new InputEditor();
  const r = ed.handle(k("enter"));
  assertEquals(r.submitted, null);
});

Deno.test("InputEditor: Escape clears the current input", () => {
  const ed = new InputEditor();
  for (const c of "abc") ed.handle(char(c));
  ed.handle(k("escape"));
  assertEquals(ed.text, "");
  assertEquals(ed.cursor, 0);
});

Deno.test("inputView: short text is shown in full with the cursor in place", () => {
  assertEquals(inputView("abc", 1, 10, 5), {
    rows: ["abc"],
    cursorRow: 0,
    cursorCol: 1,
  });
});

Deno.test("inputView: long text wraps across rows; cursor at the end is visible", () => {
  // 10 chars, width 5, maxRows 5 → wraps to ["01234","56789"]; cursor 10 → row 1.
  assertEquals(inputView("0123456789", 10, 5, 5), {
    rows: ["01234", "56789"],
    cursorRow: 1,
    cursorCol: 5,
  });
});

Deno.test("inputView: cursor mid-string stays on its wrapped row", () => {
  assertEquals(inputView("0123456789", 3, 5, 5), {
    rows: ["01234", "56789"],
    cursorRow: 0,
    cursorCol: 3,
  });
});

Deno.test("inputView: zero width or height shows nothing", () => {
  assertEquals(inputView("abc", 0, 0, 5), {
    rows: [],
    cursorRow: 0,
    cursorCol: 0,
  });
  assertEquals(inputView("abc", 1, 5, 0), {
    rows: [],
    cursorRow: 0,
    cursorCol: 0,
  });
});

// ── multi-line editor behavior ──────────────────────────────────────────────

Deno.test("InputEditor: Ctrl-J inserts a newline", () => {
  const ed = new InputEditor();
  for (const c of "ab") ed.handle(char(c));
  ed.handle(k("newline"));
  ed.handle(char("c"));
  assertEquals(ed.text, "ab\nc");
  assertEquals(ed.cursor, 4);
});

Deno.test("InputEditor: arrow down/up move between lines preserving the column", () => {
  const ed = new InputEditor();
  for (const c of "abcd") ed.handle(char(c)); // "abcd", cursor 4
  ed.handle(k("home")); // cursor 0
  ed.handle(k("newline")); // "\nabcd", cursor 1 (start of 2nd line)
  // layout: line0="" (col0), line1="abcd"; cursor at line1 col0
  ed.handle(k("arrow", "up")); // → line0 col0
  assertEquals(ed.cursor, 0);
  ed.handle(k("arrow", "down")); // → line1 col0
  assertEquals(ed.cursor, 1);
});

Deno.test("InputEditor: down clamps a long column to a shorter line's length", () => {
  const ed = new InputEditor();
  for (const c of "hello") ed.handle(char(c)); // line0 "hello"
  ed.handle(k("newline")); // line1 ""
  ed.handle(k("arrow", "up")); // → line0 end (cursor 5)
  ed.handle(k("arrow", "down")); // line1 is empty → clamp to col 0 → cursor 6
  assertEquals(ed.cursor, 6); // just past the \n
});

Deno.test("InputEditor: up on the first line and down on the last are no-ops", () => {
  const ed = new InputEditor();
  for (const c of "abc") ed.handle(char(c));
  ed.handle(k("arrow", "up")); // first line → no-op
  assertEquals(ed.cursor, 3);
  ed.handle(k("arrow", "down")); // last line → no-op
  assertEquals(ed.cursor, 3);
});

Deno.test("InputEditor: Home/End and Ctrl-A/E are line-local", () => {
  const ed = new InputEditor();
  for (const c of "ab\ncd") ed.handle(char(c)); // "ab\ncd", cursor 5 (end)
  ed.handle(k("home")); // start of line1 → cursor 3
  assertEquals(ed.cursor, 3);
  ed.handle(k("ctrl", "a")); // start of line1 → cursor 3
  assertEquals(ed.cursor, 3);
  ed.handle(k("ctrl", "e")); // end of line1 → cursor 5
  assertEquals(ed.cursor, 5);
});

Deno.test("InputEditor: backspace across a newline joins the lines", () => {
  const ed = new InputEditor();
  for (const c of "ab\ncd") ed.handle(char(c)); // cursor 5
  ed.handle(k("home")); // cursor 3 (start of line1)
  ed.handle(k("backspace")); // delete the \n → "abcd", cursor 2
  assertEquals(ed.text, "abcd");
  assertEquals(ed.cursor, 2);
});

Deno.test("InputEditor: Ctrl-K kills to the end of the current line only", () => {
  const ed = new InputEditor();
  for (const c of "ab\ncd") ed.handle(char(c)); // cursor 5
  ed.handle(k("home")); // cursor 3
  ed.handle(k("ctrl", "k")); // kill line1 "cd" → "ab\n", cursor 3
  assertEquals(ed.text, "ab\n");
  assertEquals(ed.cursor, 3);
});

Deno.test("inputView: multi-line text renders one row per line", () => {
  assertEquals(inputView("ab\ncd", 5, 10, 5), {
    rows: ["ab", "cd"],
    cursorRow: 1,
    cursorCol: 2,
  });
});

Deno.test("inputView: windows to maxRows keeping the cursor visible", () => {
  // 3 lines, maxRows 2, cursor at end of line 2 (row index 2) → show rows 1-2.
  assertEquals(inputView("l0\nl1\nl2", 8, 10, 2), {
    rows: ["l1", "l2"],
    cursorRow: 1,
    cursorCol: 2, // "l2" is 2 chars; cursor at 8 → col 8-6 = 2
  });
});
