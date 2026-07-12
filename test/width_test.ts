// Tests for ANSI-aware width utilities — visible width, truncation, and
// right-padding. Each code point counts as one column (matching wrap.ts and
// input.ts; double-width/CJK is a known v1 limitation). ANSI escape sequences
// are zero-width.

import { visibleWidth, truncateToWidth, padRight } from "../src/tui/width.ts";
import { bold, reset, red } from "../src/ansi.ts";
import { assertEquals } from "@std/assert";

Deno.test("visibleWidth: plain text counts one column per code point", () => {
  assertEquals(visibleWidth("hello"), 5);
  assertEquals(visibleWidth(""), 0);
});

Deno.test("visibleWidth: ANSI escapes are zero-width", () => {
  assertEquals(visibleWidth(`${bold}hi${reset}`), 2);
  assertEquals(visibleWidth(`${red}✗${reset}`), 1);
});

Deno.test("visibleWidth: multi-byte chars count as one column each", () => {
  assertEquals(visibleWidth("é✨"), 2);
});

Deno.test("truncateToWidth: shorter than width is unchanged", () => {
  assertEquals(truncateToWidth("abc", 10), "abc");
});

Deno.test("truncateToWidth: exactly width is unchanged", () => {
  assertEquals(truncateToWidth("abc", 3), "abc");
});

Deno.test("truncateToWidth: longer is cut to width with no ellipsis by default", () => {
  assertEquals(truncateToWidth("abcdef", 3), "abc");
});

Deno.test("truncateToWidth: ellipsis is appended and fits within the width", () => {
  assertEquals(truncateToWidth("abcdef", 5, "..."), "ab...");
  assertEquals(truncateToWidth("abcdef", 6, "..."), "abcdef"); // no truncation needed
});

Deno.test("truncateToWidth: empty ellipsis cuts cleanly with no marker", () => {
  assertEquals(truncateToWidth("abcdef", 3, ""), "abc");
});

Deno.test("truncateToWidth: preserves a leading style prefix on the kept text", () => {
  // bold + "hello" + reset, truncated to 3 → keeps 3 visible chars with bold.
  const out = truncateToWidth(`${bold}hello${reset}`, 3);
  assertEquals(out, `${bold}hel${reset}`);
});

Deno.test("truncateToWidth: ellipsis with styled text stays within width", () => {
  const out = truncateToWidth(`${bold}hello${reset}`, 4, "…");
  assertEquals(visibleWidth(out), 4);
  assertEquals(out, `${bold}hel…${reset}`);
});

Deno.test("padRight: pads plain text with spaces to the width", () => {
  assertEquals(padRight("hi", 5), "hi   ");
});

Deno.test("padRight: already-wide text is returned unchanged", () => {
  assertEquals(padRight("hello", 3), "hello");
});

Deno.test("padRight: pads based on visible width, ignoring ANSI escapes", () => {
  // bold + "hi" is 2 visible cols; pad to 5 → 3 trailing spaces.
  assertEquals(padRight(`${bold}hi${reset}`, 5), `${bold}hi${reset}   `);
});
