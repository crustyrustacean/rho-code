// Unit tests for the streaming markdown formatter, including resetMarkdown()
// which clears internal state between sessions.

import { assertEquals } from "@std/assert";
import {
  flushMarkdownBuffer,
  resetMarkdown,
  setMarkdownSink,
  writeMarkdownChunk,
} from "../src/markdown.ts";
import { codeBg, codeFg, reset as ansiReset } from "../src/ansi.ts";

Deno.test("writeMarkdownChunk: plain text is emitted verbatim", () => {
  const lines: string[] = [];
  setMarkdownSink((l) => lines.push(l));
  writeMarkdownChunk("hello world\n");
  assertEquals(lines, ["hello world"]);
});

Deno.test("writeMarkdownChunk: partial line is buffered until newline arrives", () => {
  const lines: string[] = [];
  setMarkdownSink((l) => lines.push(l));
  writeMarkdownChunk("partial");
  assertEquals(lines, []);
  writeMarkdownChunk(" line\n");
  assertEquals(lines, ["partial line"]);
});

Deno.test("resetMarkdown: clears a partial line buffer", () => {
  const lines: string[] = [];
  setMarkdownSink((l) => lines.push(l));
  writeMarkdownChunk("partial"); // buffered, not flushed
  resetMarkdown();
  // After reset, a new chunk starts fresh — the old partial is gone.
  writeMarkdownChunk("fresh\n");
  assertEquals(lines, ["fresh"]);
});

Deno.test("resetMarkdown: exits a mid-stream code block", () => {
  const lines: string[] = [];
  setMarkdownSink((l) => lines.push(l));
  // Enter a code block.
  writeMarkdownChunk("```\n");
  writeMarkdownChunk("line one\n");
  // line one was rendered as code:
  assertEquals(lines, [`${codeBg}${codeFg}line one${ansiReset}`]);

  // Reset mid-block.
  lines.length = 0;
  resetMarkdown();

  // A new non-code chunk should render as plain text, not code.
  writeMarkdownChunk("normal text\n");
  assertEquals(lines, ["normal text"]);
});

Deno.test("resetMarkdown: followed by a new code block works correctly", () => {
  const lines: string[] = [];
  setMarkdownSink((l) => lines.push(l));

  // Start and abandon a code block.
  writeMarkdownChunk("```\nabandoned\n");
  resetMarkdown();

  // Start a new code block.
  lines.length = 0;
  writeMarkdownChunk("```\nnew code\n```\n");
  assertEquals(lines, [
    `${codeBg}${codeFg}new code${ansiReset}`,
    ansiReset, // closing ``` emits reset
  ]);
});

Deno.test("flushMarkdownBuffer: closes an open code block", () => {
  const lines: string[] = [];
  setMarkdownSink((l) => lines.push(l));
  writeMarkdownChunk("```\ncode\n");
  assertEquals(lines, [`${codeBg}${codeFg}code${ansiReset}`]);
  flushMarkdownBuffer();
  assertEquals(lines[1], ansiReset);
});
