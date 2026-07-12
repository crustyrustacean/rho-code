// Decoding raw terminal input (bytes) into a `Key`. Kept pure — no I/O — so the
// full surface (printable chars, UTF-8, control keys, ANSI escape sequences,
// and partial-input handling) is unit-testable without a terminal.
//
// The read loop feeds accumulated bytes to `parseKey`; when it returns `null`
// the buffer holds an incomplete escape sequence and needs more bytes.

/** A single decoded keystroke. */
export type Key =
  | { kind: "char"; char: string }
  | { kind: "enter" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "tab" }
  | { kind: "escape" }
  | { kind: "arrow"; dir: "up" | "down" | "left" | "right" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "page"; dir: "up" | "down" }
  | { kind: "ctrl"; char: string };

/** A parsed key plus how many bytes it consumed from the front of the buffer. */
export interface ParsedKey {
  key: Key;
  consumed: number;
}

const ESC = 0x1b;

/**
 * Parse one key from the start of a raw input buffer.
 *
 * Returns `null` when the buffer holds only an incomplete escape or multi-byte
 * sequence (the caller should wait for more bytes). A lone `ESC` is treated as
 * the Escape key; a split `\x1b[` sequence is a known v1 limitation (cbreak
 * mode delivers most CSIs as a single read).
 */
export function parseKey(buf: Uint8Array<ArrayBufferLike>): ParsedKey | null {
  if (buf.length === 0) return null;
  const b0 = buf[0]!;

  // ── Escape / CSI sequences ────────────────────────────────────────────
  if (b0 === ESC) {
    if (buf.length === 1) return { key: { kind: "escape" }, consumed: 1 };
    if (buf[1] === 0x5b) {
      // CSI: ESC [
      if (buf.length < 3) return null; // incomplete
      const final = buf[2]!;
      switch (final) {
        case 0x41: return { key: { kind: "arrow", dir: "up" }, consumed: 3 };
        case 0x42: return { key: { kind: "arrow", dir: "down" }, consumed: 3 };
        case 0x43: return { key: { kind: "arrow", dir: "right" }, consumed: 3 };
        case 0x44: return { key: { kind: "arrow", dir: "left" }, consumed: 3 };
        case 0x48: return { key: { kind: "home" }, consumed: 3 };
        case 0x46: return { key: { kind: "end" }, consumed: 3 };
        case 0x33:
        case 0x35:
        case 0x36:
          if (buf.length < 4) return null; // waiting for the `~`
          if (buf[3] === 0x7e) {
            if (final === 0x33) return { key: { kind: "delete" }, consumed: 4 };
            return {
              key: { kind: "page", dir: final === 0x35 ? "up" : "down" },
              consumed: 4,
            };
          }
          break;
        default:
          break; // unknown CSI final byte — fall through
      }
      // Unknown/unhandled CSI: consume the 3-byte form so the loop advances.
      return { key: { kind: "escape" }, consumed: 3 };
    }
    // ESC not followed by '[': treat as a lone Escape.
    return { key: { kind: "escape" }, consumed: 1 };
  }

  // ── Single-byte control keys ──────────────────────────────────────────
  switch (b0) {
    case 0x0d:
    case 0x0a:
      return { key: { kind: "enter" }, consumed: 1 };
    case 0x7f:
    case 0x08:
      return { key: { kind: "backspace" }, consumed: 1 };
    case 0x09:
      return { key: { kind: "tab" }, consumed: 1 };
    default:
      break;
  }
  if (b0 < 0x20) {
    // Other control char → Ctrl + letter (0x01 → 'a', 0x03 → 'c', …).
    return { key: { kind: "ctrl", char: String.fromCodePoint(b0 + 0x60) }, consumed: 1 };
  }

  // ── Printable / multi-byte UTF-8 ──────────────────────────────────────
  const len = utf8Len(b0);
  if (len === null) {
    // Unexpected continuation/invalid lead byte: consume one and emit nothing useful.
    return { key: { kind: "char", char: String.fromCodePoint(b0) }, consumed: 1 };
  }
  if (buf.length < len) return null; // incomplete multi-byte sequence
  const char = new TextDecoder().decode(buf.subarray(0, len));
  return { key: { kind: "char", char }, consumed: len };
}

/** Expected byte length of a UTF-8 code point starting at a lead byte. */
function utf8Len(lead: number): number | null {
  if (lead >= 0x20 && lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return null;
}
