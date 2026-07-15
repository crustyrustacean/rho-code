// ANSI escape codes for terminal formatting.

export const dim = "\x1b[2m";
export const reset = "\x1b[0m";
export const bold = "\x1b[1m";
export const yellow = "\x1b[33m";
export const red = "\x1b[31m";
export const cyan = "\x1b[36m";
export const gray = "\x1b[90m";
export const green = "\x1b[32m";
export const italic = "\x1b[3m";
export const underline = "\x1b[4m";
export const codeBg = "\x1b[48;5;236m";
export const codeFg = "\x1b[38;5;252m";

// ── Backgrounds for pi-style message/tool blocks ────────────────────────
// 256-color picks that read well on dark terminals. Each paints a full-width
// block when padded out by `blockLines`.
/** Soft tint behind echoed user messages (pi `userMessageBg`). */
export const bgUser = "\x1b[48;5;239m";
/** Pending/running tool call block (pi `toolPendingBg`). */
export const bgToolPending = "\x1b[48;5;238m";
/** Successful tool call block (pi `toolSuccessBg`). */
export const bgToolSuccess = "\x1b[48;5;22m";
/** Failed tool call block (pi `toolErrorBg`). */
export const bgToolError = "\x1b[48;5;52m";
export const bgSelected = "\x1b[48;5;239m";

export const ESC = "\x1b";

/** Result of consuming one ANSI escape sequence from a character array.
 * `esc` is the full escape string; `end` is the index after the final byte.
 * Returns `null` if `chars[from]` is not ESC or the sequence is incomplete.
 */
export interface AnsiEscape {
  esc: string;
  end: number;
}

/**
 * Consume one ANSI escape sequence starting at `chars[from]`. The sequence
 * is `ESC` followed by any number of intermediate bytes (0x20–0x2F), then
 * a final byte in `0x40–0x7E`. If the final byte is a letter, the escape
 * is complete; otherwise (e.g. at the end of the buffer), `null` is returned.
 */
export function consumeAnsiEscape(
  chars: string[],
  from: number,
): AnsiEscape | null {
  if (chars[from] !== ESC) return null;
  let i = from + 1;
  while (i < chars.length) {
    const f = chars[i]!;
    if (/[A-Za-z]/.test(f)) {
      return { esc: chars.slice(from, i + 1).join(""), end: i + 1 };
    }
    i += 1;
  }
  return null; // incomplete — final byte not yet arrived
}
