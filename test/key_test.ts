// Tests for the raw-input key parser — pure bytes → Key, including ANSI
// escape sequences (arrows, home/end, delete, pgup/pgdn) and UTF-8.

import { parseKey } from "../src/tui/key.ts";
import { assertEquals } from "@std/assert";

/** Helper: parse a full byte sequence and assert the resulting Key. */
function expectKey(bytes: number[], expected: ReturnType<typeof parseKey>) {
  assertEquals(parseKey(new Uint8Array(bytes)), expected);
}

Deno.test("parseKey: printable ASCII decodes as a char", () => {
  expectKey([0x61], { key: { kind: "char", char: "a" }, consumed: 1 });
  expectKey([0x41], { key: { kind: "char", char: "A" }, consumed: 1 });
  expectKey([0x20], { key: { kind: "char", char: " " }, consumed: 1 });
});

Deno.test("parseKey: multi-byte UTF-8 decodes as one char", () => {
  // é = U+00E9 = 0xC3 0xA9
  expectKey([0xc3, 0xa9], { key: { kind: "char", char: "é" }, consumed: 2 });
  // ✨ = U+2728 = 0xE2 0x9C 0xA8
  expectKey([0xe2, 0x9c, 0xa8], {
    key: { kind: "char", char: "✨" },
    consumed: 3,
  });
});

Deno.test("parseKey: Enter is CR or LF", () => {
  expectKey([0x0d], { key: { kind: "enter" }, consumed: 1 });
  expectKey([0x0a], { key: { kind: "enter" }, consumed: 1 });
});

Deno.test("parseKey: Backspace is DEL (0x7f) or BS (0x08)", () => {
  expectKey([0x7f], { key: { kind: "backspace" }, consumed: 1 });
  expectKey([0x08], { key: { kind: "backspace" }, consumed: 1 });
});

Deno.test("parseKey: Tab, Escape", () => {
  expectKey([0x09], { key: { kind: "tab" }, consumed: 1 });
  expectKey([0x1b], { key: { kind: "escape" }, consumed: 1 });
});

Deno.test("parseKey: control chars map to ctrl+letter", () => {
  expectKey([0x03], { key: { kind: "ctrl", char: "c" }, consumed: 1 }); // Ctrl-C
  expectKey([0x01], { key: { kind: "ctrl", char: "a" }, consumed: 1 }); // Ctrl-A
  expectKey([0x05], { key: { kind: "ctrl", char: "e" }, consumed: 1 }); // Ctrl-E
});

Deno.test("parseKey: arrow keys (CSI A/B/C/D)", () => {
  expectKey([0x1b, 0x5b, 0x41], {
    key: { kind: "arrow", dir: "up" },
    consumed: 3,
  });
  expectKey([0x1b, 0x5b, 0x42], {
    key: { kind: "arrow", dir: "down" },
    consumed: 3,
  });
  expectKey([0x1b, 0x5b, 0x43], {
    key: { kind: "arrow", dir: "right" },
    consumed: 3,
  });
  expectKey([0x1b, 0x5b, 0x44], {
    key: { kind: "arrow", dir: "left" },
    consumed: 3,
  });
});

Deno.test("parseKey: Home/End (CSI H/F)", () => {
  expectKey([0x1b, 0x5b, 0x48], { key: { kind: "home" }, consumed: 3 });
  expectKey([0x1b, 0x5b, 0x46], { key: { kind: "end" }, consumed: 3 });
});

Deno.test("parseKey: Delete / PgUp / PgDn (CSI X~)", () => {
  expectKey([0x1b, 0x5b, 0x33, 0x7e], { key: { kind: "delete" }, consumed: 4 });
  expectKey([0x1b, 0x5b, 0x35, 0x7e], {
    key: { kind: "page", dir: "up" },
    consumed: 4,
  });
  expectKey([0x1b, 0x5b, 0x36, 0x7e], {
    key: { kind: "page", dir: "down" },
    consumed: 4,
  });
});

Deno.test("parseKey: incomplete escape sequence returns null (needs more bytes)", () => {
  assertEquals(parseKey(new Uint8Array([0x1b, 0x5b])), null); // CSI with no final byte
});

Deno.test("parseKey: incomplete multi-byte UTF-8 returns null", () => {
  assertEquals(parseKey(new Uint8Array([0xc3])), null); // lead byte of é, no continuation
});

Deno.test("parseKey: empty buffer returns null", () => {
  assertEquals(parseKey(new Uint8Array([])), null);
});
