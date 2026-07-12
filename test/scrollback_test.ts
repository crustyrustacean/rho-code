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

// ── tracked blocks: in-place expand/collapse by id (Ctrl-O support) ─────────

Deno.test("Scrollback: pushBlock appends a tracked block; visible shows it", () => {
  const sb = new Scrollback();
  sb.push("before");
  sb.pushBlock(1, ["b1", "b2"]);
  assertEquals(sb.visible(10, 80), ["before", "b1", "b2"]);
  assertEquals(sb.atBottom, true);
});

Deno.test("Scrollback: replaceBlock swaps a block's lines in place by id, even when buried", () => {
  const sb = new Scrollback();
  sb.push("x");
  sb.pushBlock(1, ["old1", "old2"]);
  sb.push("after"); // block 1 is no longer the tail
  assertEquals(sb.replaceBlock(1, ["NEW"]), true);
  assertEquals(sb.visible(10, 80), ["x", "NEW", "after"]);
});

Deno.test("Scrollback: replaceBlock on an unknown id is a no-op (returns false)", () => {
  const sb = new Scrollback();
  sb.pushBlock(1, ["a"]);
  assertEquals(sb.replaceBlock(99, ["b"]), false);
  assertEquals(sb.visible(10, 80), ["a"]);
});

Deno.test("Scrollback: replaceBlock grows/shrinks the block (expand then collapse)", () => {
  const sb = new Scrollback();
  sb.push("head");
  sb.pushBlock(1, ["c1"]); // collapsed
  sb.push("tail");
  sb.replaceBlock(1, ["e1", "e2", "e3"]); // expand
  assertEquals(sb.visible(10, 80), ["head", "e1", "e2", "e3", "tail"]);
  sb.replaceBlock(1, ["c1"]); // collapse back
  assertEquals(sb.visible(10, 80), ["head", "c1", "tail"]);
});

Deno.test("Scrollback: replacing an earlier block doesn't disturb a later block", () => {
  const sb = new Scrollback();
  sb.pushBlock(1, ["a1", "a2"]);
  sb.pushBlock(2, ["b1"]);
  sb.replaceBlock(1, ["A1", "A2", "A3", "A4"]); // grow block 1
  assertEquals(sb.visible(10, 80), ["A1", "A2", "A3", "A4", "b1"]);
  sb.replaceBlock(2, ["B1", "B2"]); // grow block 2 too
  assertEquals(sb.visible(10, 80), ["A1", "A2", "A3", "A4", "B1", "B2"]);
});

Deno.test("Scrollback: trimming old lines drops a block's tracking", () => {
  const sb = new Scrollback({ maxLines: 3 });
  sb.pushBlock(1, ["b1", "b2"]); // [b1,b2]
  sb.push("c"); // [b1,b2,c] — full
  sb.push("d"); // trim b1 → [b2,c,d]; block 1 partially trimmed → untracked
  assertEquals(sb.replaceBlock(1, ["x"]), false);
  assertEquals(sb.visible(5, 80), ["b2", "c", "d"]);
});

Deno.test("Scrollback: replaceBlock keeps a bottomed view pinned to the bottom", () => {
  const sb = new Scrollback();
  sb.pushBlock(1, ["a", "b", "c"]);
  sb.replaceBlock(1, ["a", "b", "c", "d", "e"]); // expand at bottom
  assertEquals(sb.atBottom, true);
  assertEquals(sb.visible(10, 80), ["a", "b", "c", "d", "e"]);
});
