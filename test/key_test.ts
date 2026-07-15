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

Deno.test("parseKey: Enter is CR; LF (Ctrl-J) inserts a newline", () => {
  expectKey([0x0d], { key: { kind: "enter" }, consumed: 1 });
  expectKey([0x0a], { key: { kind: "newline" }, consumed: 1 });
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

// ── CSI modifier sequences (Shift/Alt/Ctrl + arrow/home/delete/page) ───────
// macOS keyboards have no dedicated PgUp/PgDn keys, so modifier+arrow must
// parse correctly so the TUI can map them to scrolling.

Deno.test("parseKey: Shift+Up carries a shift mod (CSI 1;2A)", () => {
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41])),
    {
      key: {
        kind: "arrow",
        dir: "up",
        mods: { shift: true, alt: false, ctrl: false },
      },
      consumed: 6,
    },
  );
});

Deno.test("parseKey: Alt+Down carries an alt mod (CSI 1;3B)", () => {
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, 0x33, 0x42])),
    {
      key: {
        kind: "arrow",
        dir: "down",
        mods: { shift: false, alt: true, ctrl: false },
      },
      consumed: 6,
    },
  );
});

Deno.test("parseKey: Ctrl+Up carries a ctrl mod (CSI 1;5A)", () => {
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41])),
    {
      key: {
        kind: "arrow",
        dir: "up",
        mods: { shift: false, alt: false, ctrl: true },
      },
      consumed: 6,
    },
  );
});

Deno.test("parseKey: Shift+Alt+Right combines mods (CSI 1;4C)", () => {
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, 0x34, 0x43])),
    {
      key: {
        kind: "arrow",
        dir: "right",
        mods: { shift: true, alt: true, ctrl: false },
      },
      consumed: 6,
    },
  );
});

Deno.test("parseKey: a plain arrow has no mods field", () => {
  // Unmodified arrows keep the original shape (no `mods`) so existing
  // behavior — and the editor's cursor movement — is unchanged.
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x41])),
    { key: { kind: "arrow", dir: "up" }, consumed: 3 },
  );
});

Deno.test("parseKey: Ctrl+Delete is parsed, not swallowed (CSI 3;5~)", () => {
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x33, 0x3b, 0x35, 0x7e])),
    { key: { kind: "delete" }, consumed: 6 },
  );
});

Deno.test("parseKey: Ctrl+PgUp still reads as page up (CSI 5;5~)", () => {
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x35, 0x3b, 0x35, 0x7e])),
    { key: { kind: "page", dir: "up" }, consumed: 6 },
  );
});

Deno.test("parseKey: SS3 arrows (ESC O A) parse in application-cursor mode", () => {
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x4f, 0x41])),
    { key: { kind: "arrow", dir: "up" }, consumed: 3 },
  );
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x4f, 0x48])),
    { key: { kind: "home" }, consumed: 3 },
  );
});

Deno.test("parseKey: incomplete modifier CSI returns null until the final byte arrives", () => {
  assertEquals(parseKey(new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, 0x32])), null);
});

// ── scrollDir: which keys scroll the output region ─────────────────────────

import { scrollDir } from "../src/tui/key.ts";
import type { Key } from "../src/tui/key.ts";

Deno.test("scrollDir: PageUp/PageDn always scroll", () => {
  assertEquals(scrollDir({ kind: "page", dir: "up" as const }), "up");
  assertEquals(scrollDir({ kind: "page", dir: "down" as const }), "down");
});

Deno.test("scrollDir: Shift/Alt/Ctrl + Up/Down scrolls", () => {
  const shiftUp: Key = {
    kind: "arrow",
    dir: "up",
    mods: { shift: true, alt: false, ctrl: false },
  };
  const altDown: Key = {
    kind: "arrow",
    dir: "down",
    mods: { shift: false, alt: true, ctrl: false },
  };
  const ctrlUp: Key = {
    kind: "arrow",
    dir: "up",
    mods: { shift: false, alt: false, ctrl: true },
  };
  assertEquals(scrollDir(shiftUp), "up");
  assertEquals(scrollDir(altDown), "down");
  assertEquals(scrollDir(ctrlUp), "up");
});

Deno.test("scrollDir: plain arrows do NOT scroll (reserved for the editor)", () => {
  assertEquals(scrollDir({ kind: "arrow", dir: "up" as const }), null);
  assertEquals(scrollDir({ kind: "arrow", dir: "down" as const }), null);
  assertEquals(scrollDir({ kind: "arrow", dir: "left" as const }), null);
});

Deno.test("scrollDir: modifier on left/right is not a scroll key", () => {
  const shiftLeft: Key = {
    kind: "arrow",
    dir: "left",
    mods: { shift: true, alt: false, ctrl: false },
  };
  assertEquals(scrollDir(shiftLeft), null);
});

Deno.test("scrollDir: non-arrow keys never scroll", () => {
  assertEquals(scrollDir({ kind: "char", char: "a" }), null);
  assertEquals(scrollDir({ kind: "enter" }), null);
  assertEquals(scrollDir({ kind: "escape" }), null);
  assertEquals(scrollDir({ kind: "ctrl", char: "c" }), null);
});

// ── CSI sequences with intermediate / non-numeric param bytes ───────

Deno.test("parseKey: CSI with private param byte '?' is consumed without bogus modifiers", () => {
  // ESC [ ? 25 h (DECCKM — show cursor) is a DEC private-mode sequence.
  // '?' (0x3F) is a private param byte; without filtering it produces NaN
  // and corrupts modifier detection. After the fix, params should be [25]
  // and 'h' is not a recognized key, so it falls through to an escape.
  assertEquals(
    parseKey(new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68])),
    { key: { kind: "escape" }, consumed: 6 },
  );
});

Deno.test("parseKey: CSI with intermediate byte (0x20 space) is consumed cleanly", () => {
  // ESC [ 1 0 SPACE A — a hypothetical sequence with an intermediate space.
  // The space (0x20) is stripped from params, leaving [1, 10].
  // 'A' is an arrow-up final byte; params[1]=10 would be a bogus modifier,
  // but the important thing is no NaN and the sequence is consumed.
  const result = parseKey(
    new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, 0x31, 0x30, 0x20, 0x41]),
  );
  assertEquals(result?.consumed, 8);
  assertEquals(result?.key.kind, "arrow");
  if (result && result.key.kind === "arrow") {
    // After stripping the space, params are [1, 10]; mod code 10 → no standard mod.
    // The key should still parse as an arrow, just without useful mods.
    assertEquals(result.key.dir, "up");
  }
});
