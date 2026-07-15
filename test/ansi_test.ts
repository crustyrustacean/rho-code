// Unit tests for the shared ANSI escape-sequence parser.

import { assertEquals } from "@std/assert";
import { consumeAnsiEscape, ESC } from "../src/ansi.ts";

Deno.test("consumeAnsiEscape: returns null for a non-escape character", () => {
  const chars = [..."hello"];
  assertEquals(consumeAnsiEscape(chars, 0), null);
  assertEquals(consumeAnsiEscape(chars, 2), null);
});

Deno.test("consumeAnsiEscape: returns null for a lone ESC (no final byte)", () => {
  const chars = [ESC];
  assertEquals(consumeAnsiEscape(chars, 0), null);
});

Deno.test("consumeAnsiEscape: parses a simple SGR reset", () => {
  const chars = [..."\x1b[0m"];
  const seq = consumeAnsiEscape(chars, 0)!;
  assertEquals(seq.esc, "\x1b[0m");
  assertEquals(seq.end, 4);
});

Deno.test("consumeAnsiEscape: parses an SGR with multiple params", () => {
  const chars = [..."\x1b[1;2;3m"];
  const seq = consumeAnsiEscape(chars, 0)!;
  assertEquals(seq.esc, "\x1b[1;2;3m");
  assertEquals(seq.end, 8);
});

Deno.test("consumeAnsiEscape: parses a CSI sequence with intermediate bytes", () => {
  const chars = [..."\x1b[ ? 25 h"];
  const seq = consumeAnsiEscape(chars, 0)!;
  assertEquals(seq.esc, "\x1b[ ? 25 h");
  assertEquals(seq.end, 9);
});

Deno.test("consumeAnsiEscape: parses a 2-byte escape (ESC O)", () => {
  // ESC O is itself a valid 2-byte escape (final byte O); A is a separate char.
  const chars = [..."\x1bOA"];
  const seq = consumeAnsiEscape(chars, 0)!;
  assertEquals(seq.esc, "\x1bO");
  assertEquals(seq.end, 2);
});

Deno.test("consumeAnsiEscape: parses escape surrounded by text", () => {
  const chars = [..."ab\x1b[1mcd"];
  const seq = consumeAnsiEscape(chars, 2)!;
  assertEquals(seq.esc, "\x1b[1m");
  assertEquals(seq.end, 6);
});

Deno.test("consumeAnsiEscape: returns null at a position past ESC in text", () => {
  const chars = [..."abc"];
  assertEquals(consumeAnsiEscape(chars, 1), null);
  assertEquals(consumeAnsiEscape(chars, 3), null);
});

Deno.test("consumeAnsiEscape: incomplete sequence returns null", () => {
  const chars = [..."\x1b[1"];
  assertEquals(consumeAnsiEscape(chars, 0), null);
  const chars2 = [..."\x1b["];
  assertEquals(consumeAnsiEscape(chars2, 0), null);
});
