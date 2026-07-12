// Tests for the output scrollback — pure buffer + scroll-offset logic.

import { Scrollback } from "../src/tui/scrollback.ts";
import { assertEquals } from "@std/assert";

function filled(n: number): Scrollback {
  const sb = new Scrollback();
  for (let i = 1; i <= n; i++) sb.push(`line ${i}`);
  return sb;
}

Deno.test("Scrollback: visible() returns the last N lines when pinned to bottom", () => {
  const sb = filled(5);
  assertEquals(sb.visible(3, 80), ["line 3", "line 4", "line 5"]);
});

Deno.test("Scrollback: visible() pads when fewer lines than the window", () => {
  const sb = filled(2);
  assertEquals(sb.visible(5, 80), ["line 1", "line 2"]);
});

Deno.test("Scrollback: scrollUp moves the view up; atBottom becomes false", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(2);
  assertEquals(sb.visible(2, 80), ["line 2", "line 3"]);
  assertEquals(sb.atBottom, false);
});

Deno.test("Scrollback: scrollDown moves back toward the bottom", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(3); // clamps to the top → [line 1, line 2]
  sb.scrollDown(1); // one down → [line 2, line 3]
  assertEquals(sb.visible(2, 80), ["line 2", "line 3"]);
});

Deno.test("Scrollback: scrollDown clamps at the bottom (never overscrolls)", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(2);
  sb.scrollDown(10);
  assertEquals(sb.atBottom, true);
  assertEquals(sb.visible(2, 80), ["line 4", "line 5"]);
});

Deno.test("Scrollback: scrollUp clamps at the top", () => {
  const sb = filled(3);
  sb.viewportHeight = 2;
  sb.scrollUp(100);
  assertEquals(sb.visible(2, 80), ["line 1", "line 2"]);
});

Deno.test("Scrollback: pushing a new line re-pins to the bottom when already at bottom", () => {
  const sb = filled(3);
  sb.push("line 4");
  assertEquals(sb.atBottom, true);
  assertEquals(sb.visible(2, 80), ["line 3", "line 4"]);
});

Deno.test("Scrollback: pushing while scrolled up keeps the view in place (does not jump)", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(2); // viewing lines 2-3
  sb.push("line 6");
  assertEquals(sb.visible(2, 80), ["line 2", "line 3"]); // unchanged
  assertEquals(sb.atBottom, false);
});

Deno.test("Scrollback: trims the oldest lines past the cap to bound memory", () => {
  const sb = new Scrollback({ maxLines: 3 });
  for (let i = 1; i <= 5; i++) sb.push(`line ${i}`);
  assertEquals(sb.visible(5, 80), ["line 3", "line 4", "line 5"]); // oldest two dropped
});

Deno.test("Scrollback: replaceLast overwrites the newest line", () => {
  const sb = filled(3);
  sb.replaceLast("CHANGED");
  assertEquals(sb.visible(3, 80), ["line 1", "line 2", "CHANGED"]);
});

Deno.test("Scrollback: replaceLast pushes when empty", () => {
  const sb = new Scrollback();
  sb.replaceLast("only");
  assertEquals(sb.visible(5, 80), ["only"]);
});

Deno.test("Scrollback: visible() wraps long lines to the column width", () => {
  const sb = new Scrollback();
  sb.push("hello world");
  // cols 5 → "hello", " worl", "d"; window height 3 shows all three.
  assertEquals(sb.visible(3, 5), ["hello", " worl", "d"]);
});

Deno.test("Scrollback: visible() bottom-anchors when a wrapped line overflows the window", () => {
  const sb = new Scrollback();
  sb.push("hello world"); // wraps to 3 rows at cols 5
  // window height 2 → only the bottom two rows of the wrapped line.
  assertEquals(sb.visible(2, 5), [" worl", "d"]);
});

// ── replaceLastN: live-updating a multi-line block in place ───────────────

Deno.test("Scrollback: replaceLastN swaps the last N lines for the new ones", () => {
  const sb = filled(3); // [line 1, line 2, line 3]
  sb.replaceLastN(1, ["CHANGED"]);
  assertEquals(sb.visible(3, 80), ["line 1", "line 2", "CHANGED"]);
});

Deno.test("Scrollback: replaceLastN can grow or shrink the replaced region", () => {
  const sb = filled(3);
  sb.replaceLastN(2, ["a", "b", "c"]); // 2 → 3 lines (grow)
  assertEquals(sb.visible(5, 80), ["line 1", "a", "b", "c"]);
  sb.replaceLastN(3, ["z"]); // 3 → 1 line (shrink)
  assertEquals(sb.visible(5, 80), ["line 1", "z"]);
});

Deno.test("Scrollback: replaceLastN clamps n to the number of stored lines", () => {
  const sb = filled(2);
  sb.replaceLastN(10, ["only"]);
  assertEquals(sb.visible(5, 80), ["only"]);
});

Deno.test("Scrollback: replaceLastN on an empty buffer just appends", () => {
  const sb = new Scrollback();
  sb.replaceLastN(3, ["first"]);
  assertEquals(sb.visible(5, 80), ["first"]);
});

Deno.test("Scrollback: replaceLastN re-pins to the bottom when already at bottom", () => {
  const sb = filled(3);
  sb.replaceLastN(1, ["new"]); // at bottom → stays at bottom
  assertEquals(sb.atBottom, true);
  assertEquals(sb.visible(2, 80), ["line 2", "new"]);
});

Deno.test("Scrollback: replaceLastN keeps a scrolled-up view over the same content", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(2); // viewing lines 2-3, offset 2
  sb.replaceLastN(1, ["new"]); // replace line 5 (off-screen) → view should not move
  assertEquals(sb.visible(2, 80), ["line 2", "line 3"]);
  assertEquals(sb.atBottom, false);
});
