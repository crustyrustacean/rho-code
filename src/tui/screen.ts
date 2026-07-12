// Terminal I/O glue for the TUI: raw mode, the alternate screen buffer, and a
// full-repaint renderer. This is the only module that touches the live
// terminal; everything else is pure logic. The renderer paints three regions
// top-to-bottom — output scrollback, a footer, and a bordered multi-line input
// box — then parks the cursor inside the input box.
//
// The frame composition (`composeFrame`) is a pure function so the layout is
// unit-testable without a terminal; `Screen.render` is the thin I/O wrapper.

import { gray, reset } from "../ansi.ts";
import { padRight } from "./width.ts";

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[K";
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

/** One screen frame for [`Screen.render`] / [`composeFrame`]. */
export interface Frame {
  /** Output lines, already sized to the output region's height. */
  lines: string[];
  /** Footer rows (cwd/stats), each pre-sized to the terminal width. */
  footerLines: string[];
  /** Visible input rows (already wrapped to `cols - 4` and windowed). */
  inputRows: string[];
  /** Cursor position within `inputRows`. */
  inputCursor: { row: number; col: number };
}

/** Inputs to [`composeFrame`]: a frame plus the terminal dimensions. */
export interface FrameInput extends Frame {
  rows: number;
  cols: number;
}

/** Inputs to [`composePickerFrame`]: a title, the visible rows, and a hint. */
export interface PickerFrameInput {
  rows: number;
  cols: number;
  title: string;
  /** Pre-styled, already-windowed list rows. */
  rows_text: string[];
  hint: string;
}

/** A composed frame: the raw ANSI string and where to park the cursor. */
export interface ComposedFrame {
  text: string;
  cursorRow: number; // 1-based screen row
  cursorCol: number; // 1-based screen column
}

/** Terminal dimensions. */
export interface Size {
  rows: number;
  cols: number;
}

/**
 * Compose a full-screen frame as an ANSI string + cursor position. Pure.
 *
 * Layout (top → bottom): output region · footer (N rows) · bordered input box
 * (top border, one row per `inputRows`, bottom border). Returns `null` when the
 * terminal is too small to show at least one output row plus the box.
 */
export function composeFrame(f: FrameInput): ComposedFrame | null {
  const { rows, cols } = f;
  const footerH = f.footerLines.length;
  const borderH = 2;
  const inputH = f.inputRows.length + borderH;
  const outputH = rows - footerH - inputH;
  const innerWidth = cols - 4;
  if (outputH < 1 || innerWidth < 1) return null;

  let buf = HOME;
  // Output region.
  for (let r = 0; r < outputH; r++) {
    buf += (f.lines[r] ?? "") + reset + CLEAR_LINE + "\n";
  }
  // Footer rows (pre-sized — emit verbatim).
  for (const fl of f.footerLines) {
    buf += fl + reset + CLEAR_LINE + "\n";
  }
  // Bordered input box.
  buf += gray + "\u250C" + "\u2500".repeat(cols - 2) + "\u2510" + reset +
    CLEAR_LINE +
    "\n";
  for (const row of f.inputRows) {
    buf += gray + "\u2502" + reset + " " + padRight(row, innerWidth) + " " +
      gray +
      "\u2502" + reset + CLEAR_LINE + "\n";
  }
  buf += gray + "\u2514" + "\u2500".repeat(cols - 2) + "\u2518" + reset +
    CLEAR_LINE;

  // Cursor: inside the input box, after `│ ` (border + padding).
  const inputTopRow = outputH + footerH + 1; // 1-based row of the top border
  const cursorRow = inputTopRow + 1 + f.inputCursor.row;
  const cursorCol = 3 + f.inputCursor.col; // │(1) + space(1) + col, 1-based
  return { text: SHOW_CURSOR + buf, cursorRow, cursorCol };
}

/** Compose a full-screen picker/overlay frame (title · list · hint). Pure.
 * Hides the hardware cursor (the picker has no text cursor). Returns null when
 * the terminal is too short for the title, at least one row, and the hint. */
export function composePickerFrame(f: PickerFrameInput): ComposedFrame | null {
  const { rows, cols } = f;
  // Layout: title (1) · blank (1) · list (L) · blank (1) · hint (1) = L + 4.
  const listH = rows - 4;
  if (listH < 1) return null;

  let buf = HOME;
  buf += f.title + reset + CLEAR_LINE + "\n";
  buf += CLEAR_LINE + "\n"; // blank
  for (let i = 0; i < listH; i++) {
    buf += (f.rows_text[i] ?? "") + reset + CLEAR_LINE + "\n";
  }
  buf += CLEAR_LINE + "\n"; // blank
  buf += f.hint + reset + CLEAR_LINE;
  // Hint is the last row (listH + 4 = rows); park the (hidden) cursor there.
  return { text: HIDE_CURSOR + buf, cursorRow: rows, cursorCol: 1 };
}

/** Manages the terminal for the TUI lifecycle. */
export class Screen {
  #inAlt = false;
  #raw = false;

  /** Current terminal size (throws if not a TTY — check before entering). */
  size(): Size {
    const { rows, columns: cols } = Deno.consoleSize();
    return { rows, cols };
  }

  /** Enter raw mode + the alternate screen. Idempotent. */
  enter(): void {
    if (!this.#inAlt) {
      this.writeRaw(ENTER_ALT);
      this.#inAlt = true;
    }
    if (!this.#raw) {
      Deno.stdin.setRaw(true);
      this.#raw = true;
    }
  }

  /** Restore the original terminal. Idempotent; safe to call from a finally. */
  leave(): void {
    if (this.#raw) {
      try {
        Deno.stdin.setRaw(false);
      } catch {
        // stdin may already be closed; nothing useful to do.
      }
      this.#raw = false;
    }
    if (this.#inAlt) {
      this.writeRaw(SHOW_CURSOR);
      this.writeRaw(LEAVE_ALT);
      this.#inAlt = false;
    }
  }

  /** Paint a frame. Layout: output region · footer · bordered input box. */
  render(frame: Frame): void {
    const { rows, cols } = this.size();
    const composed = composeFrame({ ...frame, rows, cols });
    if (!composed) return; // too small to render
    this.writeRaw(composed.text);
    this.writeRaw(`\x1b[${composed.cursorRow};${composed.cursorCol}H`);
  }

  /** Paint a picker/overlay frame (replaces the chat view while a picker is
   * open). */
  renderPicker(frame: PickerFrameInput): void {
    const composed = composePickerFrame(frame);
    if (!composed) return;
    this.writeRaw(composed.text);
    this.writeRaw(`\x1b[${composed.cursorRow};${composed.cursorCol}H`);
  }

  private writeRaw(text: string): void {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  }
}
