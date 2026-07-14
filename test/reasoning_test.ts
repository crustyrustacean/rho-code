// Tests for the reasoning-block tail renderer.

import {
  fullReasoningLines,
  reasoningTailLines,
} from "../src/tui/reasoning.ts";
import { dim, italic, reset } from "../src/ansi.ts";
import { assertEquals } from "@std/assert";

/** Strip ANSI escapes for visible-text assertions. */
function plain(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

Deno.test("reasoningTailLines: empty buffer yields no rows", () => {
  assertEquals(reasoningTailLines("", 40, 6), []);
});

Deno.test("reasoningTailLines: a single line is styled dim + italic", () => {
  assertEquals(reasoningTailLines("hello", 40, 6), [
    `${dim}${italic}hello${reset}`,
  ]);
});

Deno.test("reasoningTailLines: newlines split into one styled row each", () => {
  const rows = reasoningTailLines("a\nb\nc", 40, 6);
  assertEquals(rows.length, 3);
  assertEquals(plain(rows[0]!), "a");
  assertEquals(plain(rows[2]!), "c");
});

Deno.test("reasoningTailLines: only the last maxRows visual rows are kept", () => {
  const rows = reasoningTailLines("l0\nl1\nl2\nl3", 40, 2);
  assertEquals(rows.length, 2);
  assertEquals(plain(rows[0]!), "l2");
  assertEquals(plain(rows[1]!), "l3");
});

Deno.test("reasoningTailLines: a long line wraps to the column width", () => {
  const rows = reasoningTailLines("abcdef", 3, 6);
  assertEquals(rows.map(plain), ["abc", "def"]);
});

Deno.test("reasoningTailLines: the tail cap counts wrapped visual rows, not logical lines", () => {
  // Two logical lines, each wrapping to 2 rows at cols 3 → 4 visual rows; cap 2.
  const rows = reasoningTailLines("abcdef\nghijkl", 3, 2);
  assertEquals(rows.map(plain), ["ghi", "jkl"]);
});

Deno.test("reasoningTailLines: maxRows <= 0 yields no rows", () => {
  assertEquals(reasoningTailLines("hello", 40, 0), []);
});

// ── fullReasoningLines: the expanded-block renderer ────────────────────────

Deno.test("fullReasoningLines: empty buffer yields no rows", () => {
  assertEquals(fullReasoningLines("", 40, 6), []);
});

Deno.test("fullReasoningLines: all lines returned when under the cap", () => {
  const rows = fullReasoningLines("a\nb\nc", 40, 6);
  assertEquals(rows.length, 3);
  assertEquals(plain(rows[0]!), "a");
  assertEquals(plain(rows[2]!), "c");
});

Deno.test("fullReasoningLines: caps at maxRows with a more-lines marker", () => {
  const rows = fullReasoningLines("a\nb\nc\nd\ne", 40, 2);
  assertEquals(rows.length, 3); // 2 kept + 1 marker
  assertEquals(plain(rows[0]!), "a");
  assertEquals(plain(rows[1]!), "b");
  assertEquals(plain(rows[2]!).includes("3 more lines"), true);
});

Deno.test("fullReasoningLines: wraps long lines to cols", () => {
  const rows = fullReasoningLines("abcdef", 3, 6);
  assertEquals(rows.map(plain), ["abc", "def"]);
});
