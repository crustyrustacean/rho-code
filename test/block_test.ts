// Tests for the full-width background block renderer (pi-style Box). Each
// returned line is exactly `cols` visible columns wide, painted with a solid
// `bgCode` background, with `padX` columns of inner padding. ANSI resets
// inside the content must not punch a hole in the background.

import { blockLines, blockBlank } from "../src/tui/block.ts";
import { bgUser, bold, reset } from "../src/ansi.ts";
import { visibleWidth } from "../src/tui/width.ts";
import { assertEquals } from "@std/assert";

Deno.test("blockLines: a short line fills the full width with the background", () => {
  const [line] = blockLines("hi", 10, bgUser, 1);
  if (!line) throw new Error("expected one line");
  assertEquals(visibleWidth(line), 10);
  assertEquals(line.startsWith(bgUser), true);
  assertEquals(line.endsWith(reset), true);
  // One column of left padding, then the content.
  assertEquals(line, `${bgUser} hi       ${reset}`);
});

Deno.test("blockLines: a newline in the content splits into two block lines", () => {
  const lines = blockLines("ab\ncd", 10, bgUser, 1);
  assertEquals(lines.length, 2);
  assertEquals(visibleWidth(lines[0]!), 10);
  assertEquals(visibleWidth(lines[1]!), 10);
  assertEquals(lines[0], `${bgUser} ab       ${reset}`);
  assertEquals(lines[1], `${bgUser} cd       ${reset}`);
});

Deno.test("blockLines: content longer than the inner width wraps across lines", () => {
  // cols 6, padX 1 → inner width 4. "abcdef" wraps to "abcd" | "ef".
  const lines = blockLines("abcdef", 6, bgUser, 1);
  assertEquals(lines.length, 2);
  assertEquals(lines[0], `${bgUser} abcd ${reset}`);
  assertEquals(lines[1], `${bgUser} ef   ${reset}`);
});

Deno.test("blockLines: a reset inside the content does not break the background", () => {
  // bold "x" reset " y" → the reset would normally clear bg; the block must
  // re-apply bg so the trailing fill stays colored.
  const [line] = blockLines(`${bold}x${reset} y`, 8, bgUser, 1);
  if (!line) throw new Error("expected one line");
  assertEquals(visibleWidth(line), 8);
  // Background code appears again right after the reset.
  assertEquals(line.includes(`${reset}${bgUser}`), true);
});

Deno.test("blockLines: padX 0 still paints edge-to-edge", () => {
  const [line] = blockLines("hi", 5, bgUser, 0);
  assertEquals(line, `${bgUser}hi   ${reset}`);
});

Deno.test("blockLines: cols too small for any inner content yields []", () => {
  // padX 1 needs cols >= 3 for a 1-column inner area; cols 2 is too small.
  assertEquals(blockLines("hi", 2, bgUser, 1), []);
});

Deno.test("blockBlank: a blank background line fills the full width", () => {
  const line = blockBlank(6, bgUser);
  assertEquals(visibleWidth(line), 6);
  assertEquals(line, `${bgUser}      ${reset}`);
});
