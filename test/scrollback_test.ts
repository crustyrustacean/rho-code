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
  assertEquals(sb.visible(3), ["line 3", "line 4", "line 5"]);
});

Deno.test("Scrollback: visible() pads when fewer lines than the window", () => {
  const sb = filled(2);
  assertEquals(sb.visible(5), ["line 1", "line 2"]);
});

Deno.test("Scrollback: scrollUp moves the view up; atBottom becomes false", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(2);
  assertEquals(sb.visible(2), ["line 2", "line 3"]);
  assertEquals(sb.atBottom, false);
});

Deno.test("Scrollback: scrollDown moves back toward the bottom", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(3); // clamps to the top → [line 1, line 2]
  sb.scrollDown(1); // one down → [line 2, line 3]
  assertEquals(sb.visible(2), ["line 2", "line 3"]);
});

Deno.test("Scrollback: scrollDown clamps at the bottom (never overscrolls)", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(2);
  sb.scrollDown(10);
  assertEquals(sb.atBottom, true);
  assertEquals(sb.visible(2), ["line 4", "line 5"]);
});

Deno.test("Scrollback: scrollUp clamps at the top", () => {
  const sb = filled(3);
  sb.viewportHeight = 2;
  sb.scrollUp(100);
  assertEquals(sb.visible(2), ["line 1", "line 2"]);
});

Deno.test("Scrollback: pushing a new line re-pins to the bottom when already at bottom", () => {
  const sb = filled(3);
  sb.push("line 4");
  assertEquals(sb.atBottom, true);
  assertEquals(sb.visible(2), ["line 3", "line 4"]);
});

Deno.test("Scrollback: pushing while scrolled up keeps the view in place (does not jump)", () => {
  const sb = filled(5);
  sb.viewportHeight = 2;
  sb.scrollUp(2); // viewing lines 2-3
  sb.push("line 6");
  assertEquals(sb.visible(2), ["line 2", "line 3"]); // unchanged
  assertEquals(sb.atBottom, false);
});

Deno.test("Scrollback: trims the oldest lines past the cap to bound memory", () => {
  const sb = new Scrollback({ maxLines: 3 });
  for (let i = 1; i <= 5; i++) sb.push(`line ${i}`);
  assertEquals(sb.visible(5), ["line 3", "line 4", "line 5"]); // oldest two dropped
});

Deno.test("Scrollback: replaceLast overwrites the newest line", () => {
  const sb = filled(3);
  sb.replaceLast("CHANGED");
  assertEquals(sb.visible(3), ["line 1", "line 2", "CHANGED"]);
});

Deno.test("Scrollback: replaceLast pushes when empty", () => {
  const sb = new Scrollback();
  sb.replaceLast("only");
  assertEquals(sb.visible(5), ["only"]);
});
