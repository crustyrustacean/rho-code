// Tests for ANSI-aware line wrapping — visible-width wrapping that preserves
// styling across the break by re-applying active SGR codes on each segment.

import { wrapLine } from "../src/tui/wrap.ts";
import { assertEquals } from "@std/assert";

Deno.test("wrapLine: a short line is returned as a single segment", () => {
  assertEquals(wrapLine("hello", 80), ["hello"]);
});

Deno.test("wrapLine: an empty line is a single empty segment", () => {
  assertEquals(wrapLine("", 80), [""]);
});

Deno.test("wrapLine: wraps at the column boundary (character wrap)", () => {
  assertEquals(wrapLine("hello world", 5), ["hello", " worl", "d"]);
});

Deno.test("wrapLine: a line exactly cols wide is not split", () => {
  assertEquals(wrapLine("hello", 5), ["hello"]);
});

Deno.test("wrapLine: preserves bold styling across the wrap", () => {
  // "hello " then bold "world", cols 8 → "wo" | "rld", bold re-applied.
  assertEquals(wrapLine("hello \x1b[1mworld", 8), [
    "hello \x1b[1mwo",
    "\x1b[1mrld",
  ]);
});

Deno.test("wrapLine: a reset clears the active style for later segments", () => {
  // bold "ab", reset, then " cd ef", cols 3 → after the reset, wrapped
  // segments carry no styling.
  assertEquals(wrapLine("\x1b[1mab\x1b[0m cd ef", 3), [
    "\x1b[1mab\x1b[0m ",
    "cd ",
    "ef",
  ]);
});

Deno.test("wrapLine: a styled line shorter than cols is unchanged", () => {
  assertEquals(wrapLine("\x1b[1mhi\x1b[0m", 80), ["\x1b[1mhi\x1b[0m"]);
});

Deno.test("wrapLine: cols <= 0 yields a single empty segment", () => {
  assertEquals(wrapLine("hello", 0), [""]);
});
