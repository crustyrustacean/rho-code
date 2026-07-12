// Integration test for the tool-block lifecycle the TUI drives, using the
// scrollback's tracked-block primitives (pushBlock/replaceBlock) exactly as
// run.ts does: a pending block is pushed under an id, then repainted in place
// as success/error when the result arrives, and toggled expanded/collapsed.

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

/** Mirror run.ts's buildToolBlockLines: a leading blank + a bg-painted block. */
function toolBlock(
  bg: string,
  name: string,
  args: string,
  status: string,
  output: string | undefined,
  cols: number,
): string[] {
  const head = `${bold}${name}${reset}` +
    (args ? ` ${gray}${args}${reset}` : "") +
    `  ${status}`;
  const content = output ? `${head}\n${output}` : head;
  return ["", ...blockLines(content, cols, bg, 1)];
}

Deno.test("tool block lifecycle: pending block is repainted as success with output", () => {
  const sb = new Scrollback();
  const cols = 60;
  sb.push("earlier message");

  // tool/call → push the pending block under id 1.
  const pending = toolBlock(
    bgToolPending,
    "read",
    "src/main.ts",
    `${yellow}●${reset} ${dim}running${reset}`,
    undefined,
    cols,
  );
  sb.pushBlock(1, pending);

  // tool/result → replaceBlock with the success block + output.
  const output = `${dim}1  fn main() {}${reset}`;
  const done = toolBlock(
    bgToolSuccess,
    "read",
    "src/main.ts",
    `${green}✓ done${reset}`,
    output,
    cols,
  );
  assertEquals(sb.replaceBlock(1, done), true);

  const view = sb.visible(20, cols).map(plain);
  assertEquals(view[0], "earlier message");
  assertEquals(view[1], ""); // leading blank line of the block
  assertEquals(view[2]!.includes("read"), true);
  assertEquals(view[2]!.includes("src/main.ts"), true);
  assertEquals(view[2]!.includes("✓ done"), true);
  assertEquals(view[3]!.includes("fn main() {}"), true);
  assertEquals(view.some((l) => l.includes("running")), false);

  // The pending background is gone; the success background is present.
  const raw = sb.visible(20, cols);
  assertEquals(raw.some((l) => l.includes(bgToolPending)), false);
  assertEquals(raw.some((l) => l.includes(bgToolSuccess)), true);
});

Deno.test("tool block lifecycle: error result repaints with the error background", () => {
  const sb = new Scrollback();
  const cols = 50;
  sb.pushBlock(
    1,
    toolBlock(
      bgToolPending,
      "bash",
      "rm -rf /tmp/x",
      `${yellow}●${reset} ${dim}running${reset}`,
      undefined,
      cols,
    ),
  );
  assertEquals(
    sb.replaceBlock(
      1,
      toolBlock(
        bgToolError,
        "bash",
        "rm -rf /tmp/x",
        `${red}✗ failed${reset}`,
        `${dim}Permission denied${reset}`,
        cols,
      ),
    ),
    true,
  );

  const raw = sb.visible(20, cols);
  assertEquals(raw.some((l) => l.includes(bgToolPending)), false);
  assertEquals(raw.some((l) => l.includes(bgToolError)), true);
  assertEquals(plain(raw[raw.length - 1]!).includes("Permission denied"), true);
});

Deno.test("tool block lifecycle: a result can be repainted even after content is pushed past it", () => {
  const sb = new Scrollback();
  const cols = 40;
  sb.pushBlock(
    1,
    toolBlock(
      bgToolPending,
      "read",
      "a",
      `${dim}running${reset}`,
      undefined,
      cols,
    ),
  );
  // The assistant streams a message after the tool — block 1 is now buried.
  sb.push("assistant text after the tool");
  sb.push("more text");

  // Ctrl-O style expand still targets block 1 by id.
  assertEquals(
    sb.replaceBlock(
      1,
      toolBlock(
        bgToolSuccess,
        "read",
        "a",
        `${green}✓ done${reset}`,
        `${dim}full output line 1${reset}\n${dim}line 2${reset}`,
        cols,
      ),
    ),
    true,
  );
  const view = sb.visible(20, cols).map(plain);
  assertEquals(view.some((l) => l.includes("full output line 1")), true);
  assertEquals(
    view.some((l) => l.includes("assistant text after the tool")),
    true,
  );
});

Deno.test("tool block lifecycle: expand/collapse toggles the output row count in place", () => {
  const sb = new Scrollback();
  const cols = 40;
  const full = Array.from({ length: 20 }, (_, i) => `${dim}line ${i}${reset}`)
    .join("\n");
  sb.pushBlock(
    1,
    toolBlock(
      bgToolSuccess,
      "read",
      "big.txt",
      `${green}✓ done${reset}`,
      full,
      cols,
    ),
  );
  const collapsedRows = sb.visible(50, cols).length;
  // Expand: re-push the same block with more output rows (simulate larger cap).
  const big = Array.from({ length: 40 }, (_, i) => `${dim}line ${i}${reset}`)
    .join("\n");
  sb.replaceBlock(
    1,
    toolBlock(
      bgToolSuccess,
      "read",
      "big.txt",
      `${green}✓ done${reset}`,
      big,
      cols,
    ),
  );
  const expandedRows = sb.visible(80, cols).length;
  assertEquals(expandedRows > collapsedRows, true);
});
