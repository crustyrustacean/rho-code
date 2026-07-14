// Terminal I/O glue for the TUI: raw mode, the alternate screen buffer, and a
// double-buffered diff renderer. This is the only module that touches the live
// terminal; everything else is pure logic.
//
// Rendering strategy: the frame composition (`frameRows` / `pickerRows`) and
// the diff decision (`paintPlan`) are pure functions so the layout is unit-
// testable without a terminal. `Screen.render` is the thin I/O wrapper that
// diffs the next frame against a back-buffer and emits only the changed lines
// in a single write — the key to flicker-free painting on Windows ConPTY,
// which exposes intermediate states of a full-repaint stream.
//
// The renderer paints three regions top-to-bottom — output scrollback, a
// footer, and a bordered multi-line input box — then parks the cursor inside
// the input box.

import { gray, reset } from "../ansi.ts";
import { padRight, visibleWidth } from "./width.ts";

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[K";
const CLEAR_BELOW = "\x1b[0J"; // clear from cursor to end of screen
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const DECAWM_OFF = "\x1b[?7l"; // disable autowrap — writing the bottom-right
const DECAWM_ON = "\x1b[?7h"; //  cell can't trigger a scroll/linefeed

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
  /** Optional working-status line shown between the output region and the
   * footer while an agent turn runs. */
  workingLine?: string;
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

// ── Pure frame composition ────────────────────────────────────────────────

/** The logical rows + cursor position for a chat frame. Pure.
 *
 * Each returned row is a styled string of visible width `cols` (output/footer
 * rows are padded by the caller; borders and input rows are padded here).
 * Returns `null` when the terminal is too small to show at least one output
 * row plus the bordered input box. */
export function frameRows(
  f: FrameInput,
): { rows: string[]; cursorRow: number; cursorCol: number } | null {
  const { rows, cols } = f;
  const footerH = f.footerLines.length;
  const borderH = 2;
  const inputH = f.inputRows.length + borderH;
  const extra = f.workingLine ? 1 : 0;
  const outputH = rows - footerH - extra - inputH;
  const innerWidth = cols - 4;
  if (outputH < 1 || innerWidth < 1) return null;

  const out: string[] = [];
  for (let r = 0; r < outputH; r++) out.push((f.lines[r] ?? "") + reset);
  if (f.workingLine) out.push(f.workingLine + reset);
  for (const fl of f.footerLines) out.push(fl + reset);
  // Bordered input box.
  out.push(gray + "\u250C" + "\u2500".repeat(cols - 2) + "\u2510" + reset);
  for (const row of f.inputRows) {
    out.push(
      gray + "\u2502" + reset + " " + padRight(row, innerWidth) + " " + gray +
        "\u2502" + reset,
    );
  }
  out.push(gray + "\u2514" + "\u2500".repeat(cols - 2) + "\u2518" + reset);

  const inputTopRow = outputH + extra + footerH + 1; // 1-based row of the top border
  const cursorRow = inputTopRow + 1 + f.inputCursor.row;
  const cursorCol = 3 + f.inputCursor.col; // │(1) + space(1) + col, 1-based
  return { rows: out, cursorRow, cursorCol };
}

/**
 * Compose a full-screen chat frame as an ANSI string + cursor position. Pure.
 *
 * Layout (top → bottom): output region · footer (N rows) · bordered input box
 * (top border, one row per `inputRows`, bottom border). Returns `null` when the
 * terminal is too small to show at least one output row plus the box.
 */
export function composeFrame(f: FrameInput): ComposedFrame | null {
  const fr = frameRows(f);
  if (!fr) return null;
  const parts = fr.rows.map((r, i) =>
    r + CLEAR_LINE + (i < fr.rows.length - 1 ? "\n" : "")
  );
  return {
    text: SHOW_CURSOR + HOME + parts.join(""),
    cursorRow: fr.cursorRow,
    cursorCol: fr.cursorCol,
  };
}

/** The logical rows for a picker/overlay frame. Pure. Returns `null` when the
 * terminal is too short for the title, at least one list row, and the hint. */
export function pickerRows(f: PickerFrameInput): string[] | null {
  const { rows } = f;
  // Layout: title (1) · blank (1) · list (L) · blank (1) · hint (1) = L + 4.
  const listH = rows - 4;
  if (listH < 1) return null;
  const out: string[] = [];
  out.push(f.title + reset);
  out.push(""); // blank
  for (let i = 0; i < listH; i++) out.push((f.rows_text[i] ?? "") + reset);
  out.push(""); // blank
  out.push(f.hint + reset);
  return out;
}

/** Compose a full-screen picker/overlay frame (title · list · hint). Pure.
 * Hides the hardware cursor (the picker has no text cursor). Returns null when
 * the terminal is too short for the title, at least one row, and the hint. */
export function composePickerFrame(f: PickerFrameInput): ComposedFrame | null {
  const rows = pickerRows(f);
  if (!rows) return null;
  const parts = rows.map((r, i) =>
    r + CLEAR_LINE + (i < rows.length - 1 ? "\n" : "")
  );
  // Hint is the last row; park the (hidden) cursor there.
  return {
    text: HIDE_CURSOR + HOME + parts.join(""),
    cursorRow: f.rows,
    cursorCol: 1,
  };
}

// ── Pure diff planning ────────────────────────────────────────────────────

/** One row to (re)paint: its 1-based screen index and its styled text. */
export interface PaintedRow {
  index: number;
  text: string;
}

/** The set of rows to write for one frame, plus whether it's a full repaint. */
export interface PaintPlan {
  /** True → repaint every row (back-buffer was empty, mode changed, or the row
   * count changed). `rows` still lists every row in that case. */
  full: boolean;
  /** Rows to write. When `full`, every row; otherwise only the changed ones. */
  rows: PaintedRow[];
}

/**
 * Decide which rows need repainting given the previous back-buffer and the next
 * frame. Pure — the I/O layer turns this into bytes. A `null` `prev` (first
 * paint, after a resize, or after leaving/re-entering the alt screen) or a mode
 * switch forces a full repaint. Unchanged rows are skipped, which is what keeps
 * ConPTY from re-processing the whole screen every frame.
 */
export function paintPlan(
  prev: string[] | null,
  prevMode: string | null,
  next: string[],
  mode: string,
): PaintPlan {
  if (prev === null || prevMode !== mode || prev.length !== next.length) {
    return { full: true, rows: next.map((text, index) => ({ index, text })) };
  }
  const rows: PaintedRow[] = [];
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) rows.push({ index: i, text: next[i]! });
  }
  return { full: false, rows };
}

/**
 * The clear-to-end suffix a row needs, or "" if none. A full-width (or wider)
 * row already fills the line; emitting `ESC[K` after it would, with autowrap
 * disabled, erase its last cell — the bug that cut off the model name and the
 * input box's right border. Shorter rows keep the clear to wipe stale trailing
 * content. Pure.
 */
export function clearLineFor(text: string, cols: number): string {
  return visibleWidth(text) < cols ? CLEAR_LINE : "";
}

// ── Terminal manager ──────────────────────────────────────────────────────

/** Manages the terminal for the TUI lifecycle. */
export class Screen {
  #inAlt = false;
  #raw = false;
  /** Back-buffer of the last painted frame's rows (null = force full repaint). */
  #buf: string[] | null = null;
  /** Which view the back-buffer holds, so a chat↔picker switch forces full. */
  #mode: "chat" | "picker" | null = null;
  #lastRows = 0;
  #lastCols = 0;
  #lastPaint = ""; // raw bytes of the last #paint write, for the debug dump

  /** Current terminal size (throws if not a TTY — check before entering). */
  size(): Size {
    const { rows, columns: cols } = Deno.consoleSize();
    return { rows, cols };
  }

  /** Snapshot of the renderer's internal state, for the Ctrl-D debug dump. */
  debugState(): {
    buf: string[] | null;
    lastPaint: string;
    mode: string | null;
    lastRows: number;
    lastCols: number;
  } {
    return {
      buf: this.#buf,
      lastPaint: this.#lastPaint,
      mode: this.#mode,
      lastRows: this.#lastRows,
      lastCols: this.#lastCols,
    };
  }

  /** Enter raw mode + the alternate screen, with autowrap disabled so writing
   * the bottom-right cell can't scroll. Idempotent. */
  enter(): void {
    if (!this.#inAlt) {
      this.writeRaw(ENTER_ALT);
      this.writeRaw(DECAWM_OFF);
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
      this.writeRaw(DECAWM_ON);
      this.writeRaw(LEAVE_ALT);
      this.#inAlt = false;
    }
    // Next enter()+render must do a full repaint.
    this.#buf = null;
    this.#mode = null;
  }

  /** Paint a chat frame with a diff against the last frame. Layout: output
   * region · footer · bordered input box; cursor parked inside the box. The
   * caller supplies the terminal size so the wrap width (used for the lines)
   * and the frame width can't drift apart between two size reads. */
  render(frame: FrameInput): void {
    // A resize invalidates the back-buffer (row count or column width changed),
    // forcing one full repaint on the next paint.
    if (
      this.#buf !== null &&
      (this.#lastRows !== frame.rows || this.#lastCols !== frame.cols)
    ) {
      this.#buf = null;
    }
    const composed = frameRows(frame);
    if (!composed) return; // too small to render
    this.#lastRows = frame.rows;
    this.#lastCols = frame.cols;
    this.#paint(
      composed.rows,
      "chat",
      frame.cols,
      { row: composed.cursorRow, col: composed.cursorCol },
    );
  }

  /** Paint a picker/overlay frame (replaces the chat view while a picker is
   * open). The hardware cursor stays hidden. */
  renderPicker(frame: PickerFrameInput): void {
    if (
      this.#buf !== null &&
      (this.#lastRows !== frame.rows || this.#lastCols !== frame.cols)
    ) {
      this.#buf = null;
    }
    const rows = pickerRows(frame);
    if (!rows) return;
    this.#lastRows = frame.rows;
    this.#lastCols = frame.cols;
    this.#paint(rows, "picker", frame.cols, null);
  }

  /**
   * Diff `next` against the back-buffer and write only the changed rows in a
   * single `writeSync`. The cursor is hidden while rows are written, then shown
   * (chat) or left hidden (picker) and positioned. One write per frame is what
   * keeps ConPTY from tearing a frame across two visible updates.
   */
  #paint(
    next: string[],
    mode: "chat" | "picker",
    cols: number,
    cursor: { row: number; col: number } | null,
  ): void {
    const plan = paintPlan(this.#buf, this.#mode, next, mode);
    // When most of the screen changes (e.g. a streaming line scrolls the
    // viewport), a compact HOME + CRLF repaint is gentler on ConPTY than a
    // per-row cursor-positioned diff — fewer cursor moves, one batched write.
    const heavy = plan.full || plan.rows.length > next.length / 2;
    let buf = HIDE_CURSOR;
    if (heavy) {
      buf += HOME;
      for (let i = 0; i < next.length; i++) {
        if (i > 0) buf += "\r\n";
        buf += next[i] + clearLineFor(next[i]!, cols);
      }
      if (this.#buf !== null && this.#buf.length > next.length) {
        buf += `\x1b[${next.length + 1};1H${CLEAR_BELOW}`;
      }
    } else {
      for (const r of plan.rows) {
        buf += `\x1b[${r.index + 1};1H${r.text}${clearLineFor(r.text, cols)}`;
      }
    }
    if (cursor) {
      buf += SHOW_CURSOR + `\x1b[${cursor.row};${cursor.col}H`;
    }
    this.#lastPaint = buf;
    this.writeRaw(buf);
    this.#buf = next;
    this.#mode = mode;
  }

  private writeRaw(text: string): void {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  }
}
