// Decoding raw terminal input (bytes) into a `Key`. Kept pure — no I/O — so the
// full surface (printable chars, UTF-8, control keys, ANSI escape sequences,
// and partial-input handling) is unit-testable without a terminal.
//
// The read loop feeds accumulated bytes to `parseKey`; when it returns `null`
// the buffer holds an incomplete escape sequence and needs more bytes.

/** Active key modifiers, present only when at least one is pressed. */
export interface Mods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** A single decoded keystroke. */
export type Key =
  | { kind: "char"; char: string }
  | { kind: "enter" }
  | { kind: "newline" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "tab" }
  | { kind: "escape" }
  | {
    kind: "arrow";
    dir: "up" | "down" | "left" | "right";
    mods?: Mods;
  }
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
const decoder = new TextDecoder();

/**
 * Parse one key from the start of a raw input buffer.
 *
 * Returns `null` when the buffer holds only an incomplete escape or multi-byte
 * sequence (the caller should wait for more bytes). A lone `ESC` is treated as
 * the Escape key. Full CSI sequences are parsed including xterm modifier
 * parameters (`CSI 1;<mod><final>`), so Shift/Alt/Ctrl + arrow (and SS3
 * app-cursor arrows) decode correctly.
 */
export function parseKey(buf: Uint8Array<ArrayBufferLike>): ParsedKey | null {
  if (buf.length === 0) return null;
  const b0 = buf[0]!;

  // ── Escape / CSI / SS3 sequences ──────────────────────────────────
  if (b0 === ESC) {
    if (buf.length === 1) return { key: { kind: "escape" }, consumed: 1 };
    if (buf[1] === 0x5b) return parseCsi(buf); // ESC [  — CSI
    if (buf[1] === 0x4f) return parseSs3(buf); // ESC O  — SS3 (app-cursor)
    // ESC + anything else: a lone Escape (leave the next byte buffered).
    return { key: { kind: "escape" }, consumed: 1 };
  }

  // ── Single-byte control keys ──────────────────────────────────────────
  switch (b0) {
    case 0x0d:
      return { key: { kind: "enter" }, consumed: 1 };
    case 0x0a:
      // LF: Ctrl-J (or a pasted line feed) inserts a line break rather than
      // submitting — Enter sends CR (0x0d) in raw mode.
      return { key: { kind: "newline" }, consumed: 1 };
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
    return {
      key: { kind: "ctrl", char: String.fromCodePoint(b0 + 0x60) },
      consumed: 1,
    };
  }

  // ── Printable / multi-byte UTF-8 ──────────────────────────────────────
  const len = utf8Len(b0);
  if (len === null) {
    // Unexpected continuation/invalid lead byte: consume one and emit nothing useful.
    return {
      key: { kind: "char", char: String.fromCodePoint(b0) },
      consumed: 1,
    };
  }
  if (buf.length < len) return null; // incomplete multi-byte sequence
  const char = decoder.decode(buf.subarray(0, len));
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

// ── CSI / SS3 decoding helpers ─────────────────────────────────────────────

/** True for a CSI/SS3 final byte (0x40–0x7e). */
function isFinalByte(b: number): boolean {
  return b >= 0x40 && b <= 0x7e;
}

/** Decode a CSI sequence (`ESC [ params final`) into a Key, consuming the
 * whole sequence including any modifier parameters. Returns `null` when the
 * final byte hasn't arrived yet (the buffer is incomplete). */
function parseCsi(buf: Uint8Array<ArrayBufferLike>): ParsedKey | null {
  let i = 2;
  let finalByte = -1;
  while (i < buf.length) {
    const b = buf[i]!;
    i += 1;
    if (isFinalByte(b)) {
      finalByte = b;
      break;
    }
  }
  if (finalByte === -1) return null; // incomplete — wait for more bytes
  const consumed = i;
  // Strip intermediate bytes (0x20–0x2F) and non-numeric param bytes from the
  // param region so they don't produce NaN values. e.g. ESC [ ? 25 h has
  // '?' as a private parameter byte; without filtering, params would be
  // [NaN, 25] which corrupts modifier detection in modsFromParams.
  const raw = decoder.decode(buf.subarray(2, consumed - 1));
  const paramStr = raw.replaceAll(/[^0-9;]/g, "");
  const params = paramStr === "" ? [] : paramStr.split(";").map(Number);
  return { key: keyFromCsi(finalByte, params), consumed };
}

/** Decode an SS3 sequence (`ESC O <final>`) — arrows/home/end in cursor-key
 * application mode (common inside tmux/screen). Three bytes. */
function parseSs3(buf: Uint8Array<ArrayBufferLike>): ParsedKey | null {
  if (buf.length < 3) return null;
  const finalByte = buf[2]!;
  const key = arrowOrHomeEnd(finalByte);
  return key ? { key, consumed: 3 } : { key: { kind: "escape" }, consumed: 3 };
}

/** Map a CSI final byte + parsed params to a Key. */
function keyFromCsi(finalByte: number, params: number[]): Key {
  switch (finalByte) {
    case 0x41: // A
    case 0x42: // B
    case 0x43: // C
    case 0x44: { // D
      const dir = finalByte === 0x41
        ? "up"
        : finalByte === 0x42
        ? "down"
        : finalByte === 0x43
        ? "right"
        : "left";
      const mods = modsFromParams(params);
      return mods ? { kind: "arrow", dir, mods } : { kind: "arrow", dir };
    }
    case 0x48: // H
      return { kind: "home" };
    case 0x46: // F
      return { kind: "end" };
    case 0x7e: { // ~
      const code = params[0] ?? 0;
      if (code === 3) return { kind: "delete" };
      if (code === 5) return { kind: "page", dir: "up" };
      if (code === 6) return { kind: "page", dir: "down" };
      if (code === 1 || code === 7) return { kind: "home" };
      if (code === 4 || code === 8) return { kind: "end" };
      return { kind: "escape" };
    }
    default:
      return { kind: "escape" };
  }
}

/** Arrow (A/B/C/D) or home (H)/end (F) from a final byte, or null. */
function arrowOrHomeEnd(finalByte: number): Key | null {
  switch (finalByte) {
    case 0x41:
      return { kind: "arrow", dir: "up" };
    case 0x42:
      return { kind: "arrow", dir: "down" };
    case 0x43:
      return { kind: "arrow", dir: "right" };
    case 0x44:
      return { kind: "arrow", dir: "left" };
    case 0x48:
      return { kind: "home" };
    case 0x46:
      return { kind: "end" };
    default:
      return null;
  }
}

/** Decode xterm modifier params (`CSI 1 ; <mod> <final>`) into Mods. The
 * modifier code is 2=shift, 3=alt, 4=shift+alt, 5=ctrl, … — i.e. (code-1) is a
 * bitfield with bit0=shift, bit1=alt, bit2=ctrl. Returns undefined when no
 * modifier is held. */
function modsFromParams(params: number[]): Mods | undefined {
  let code = 0;
  if (params.length >= 2) code = params[1] ?? 0;
  else if (params.length === 1 && params[0] !== 1) code = params[0];
  if (code <= 1) return undefined;
  const v = code - 1;
  const mods: Mods = {
    shift: (v & 1) === 1,
    alt: (v & 2) === 2,
    ctrl: (v & 4) === 4,
  };
  return mods.shift || mods.alt || mods.ctrl ? mods : undefined;
}

/** The scroll direction a key implies, or `null` if it isn't a scroll key.
 *
 * `PageUp`/`PageDn` always scroll. `Shift`/`Alt`/`Ctrl` + Up/Down also scroll
 * — macOS keyboards have no dedicated PgUp/PgDn keys, so a modifier + arrow is
 * the reachable way to page through history. Plain arrows are left for the
 * editor (cursor movement in a future multi-line editor). */
export function scrollDir(key: Key): "up" | "down" | null {
  if (key.kind === "page") return key.dir;
  if (key.kind === "arrow" && (key.dir === "up" || key.dir === "down")) {
    const m = key.mods;
    if (m && (m.shift || m.alt || m.ctrl)) return key.dir;
  }
  return null;
}
