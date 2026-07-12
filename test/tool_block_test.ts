// Integration test for the tool-block lifecycle the TUI drives: a pending
// block is pushed (blank line + blockLines), then repainted in place via
// Scrollback.replaceLastN when the result arrives. This exercises the exact
// composition run.ts uses, without a terminal.

import { Scrollback } from "../src/tui/scrollback.ts";
import { blockLines } from "../src/tui/block.ts";
import {
  bgToolError,
  bgToolPending,
  bgToolSuccess,
  bold,
  dim,
  gray,
  green,
  red,
  reset,
  yellow,
} from "../src/ansi.ts";
import { assertEquals } from "@std/assert";

/** Strip ANSI escapes so the lifecycle can be asserted on visible text. */
function plain(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

/** Mirror run.ts's renderToolBlock: a leading blank line + a bg-painted block. */
function toolBlock(
  bg: string,
  name: string,
  args: string,
  status: string,
  output: string | undefined,
  cols: number,
): string[] {
  const head = `${bold}${name}${reset}` +
    (args ? ` ${gray}${args}${reset}` : "") + `  ${status}`;
  const content = output ? `${head}\n${output}` : head;
  return ["", ...blockLines(content, cols, bg, 1)];
}

Deno.test("tool block lifecycle: pending block is repainted as success with output", () => {
  const sb = new Scrollback();
  const cols = 60;
  sb.push("earlier message");

  // tool/call → push the pending block, remember its line count.
  const pending = toolBlock(
    bgToolPending,
    "read",
    "src/main.ts",
    `${yellow}●${reset} ${dim}running${reset}`,
    undefined,
    cols,
  );
  for (const line of pending) sb.push(line);
  const blockLines_ = pending.length;

  // tool/result → replaceLastN with the success block + output.
  const output = `${dim}1  fn main() {}${reset}`;
  const done = toolBlock(
    bgToolSuccess,
    "read",
    "src/main.ts",
    `${green}✓ done${reset}`,
    output,
    cols,
  );
  sb.replaceLastN(blockLines_, done);

  const view = sb.visible(20, cols).map(plain);
  assertEquals(view[0], "earlier message");
  assertEquals(view[1], ""); // leading blank line of the block
  // The head line shows the tool name, args, and the success status.
  assertEquals(view[2]!.includes("read"), true);
  assertEquals(view[2]!.includes("src/main.ts"), true);
  assertEquals(view[2]!.includes("✓ done"), true);
  // The output line survived the repaint.
  assertEquals(view[3]!.includes("fn main() {}"), true);
  // No stale "running" marker remains.
  assertEquals(view.some((l) => l.includes("running")), false);
  // The pending background is gone; the success background is present.
  const raw = sb.visible(20, cols);
  assertEquals(raw.some((l) => l.includes(bgToolPending)), false);
  assertEquals(raw.some((l) => l.includes(bgToolSuccess)), true);
});

Deno.test("tool block lifecycle: error result repaints with the error background", () => {
  const sb = new Scrollback();
  const cols = 50;
  const pending = toolBlock(
    bgToolPending,
    "bash",
    "rm -rf /tmp/x",
    `${yellow}●${reset} ${dim}running${reset}`,
    undefined,
    cols,
  );
  for (const line of pending) sb.push(line);
  const n = pending.length;

  const failed = toolBlock(
    bgToolError,
    "bash",
    "rm -rf /tmp/x",
    `${red}✗ failed${reset}`,
    `${dim}Permission denied${reset}`,
    cols,
  );
  sb.replaceLastN(n, failed);

  const raw = sb.visible(20, cols);
  assertEquals(raw.some((l) => l.includes(bgToolPending)), false);
  assertEquals(raw.some((l) => l.includes(bgToolError)), true);
  assertEquals(plain(raw[raw.length - 1]!).includes("Permission denied"), true);
});

Deno.test("tool block lifecycle: a scrolled-up view is not disturbed by the repaint", () => {
  const sb = new Scrollback();
  const cols = 40;
  for (let i = 1; i <= 3; i++) sb.push(`msg ${i}`);
  const pending = toolBlock(
    bgToolPending,
    "read",
    "a",
    `${dim}running${reset}`,
    undefined,
    cols,
  );
  for (const line of pending) sb.push(line);
  const n = pending.length;

  // Scroll up so the tool block is off-screen.
  sb.viewportHeight = 2;
  sb.scrollUp(n + 1);
  const before = sb.visible(2, cols).map(plain);

  const done = toolBlock(
    bgToolSuccess,
    "read",
    "a",
    `${green}✓ done${reset}`,
    `${dim}ok${reset}`,
    cols,
  );
  sb.replaceLastN(n, done);

  assertEquals(sb.visible(2, cols).map(plain), before); // unchanged
  assertEquals(sb.atBottom, false);
});
