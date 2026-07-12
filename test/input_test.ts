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
  assertEquals(inputView("abc", 1, 10), { view: "abc", col: 1 });
});

Deno.test("inputView: long text scrolls to keep the cursor visible at the right", () => {
  // 10 chars, width 5, cursor at end (10) → show last 5, col 5.
  assertEquals(inputView("0123456789", 10, 5), { view: "56789", col: 5 });
});

Deno.test("inputView: cursor mid-string stays within the window", () => {
  // 10 chars, width 5, cursor at 3 → window starts at max(0, 3-4)=0, col 3.
  assertEquals(inputView("0123456789", 3, 5), { view: "01234", col: 3 });
});

Deno.test("inputView: zero width shows nothing", () => {
  assertEquals(inputView("abc", 0, 0), { view: "", col: 0 });
});
