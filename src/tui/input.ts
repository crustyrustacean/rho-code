// A multi-line text input editor. Pure logic: keystrokes mutate an internal
// text buffer (which may contain newlines) and a char-offset cursor, with no
// terminal I/O. The render layer reads `text`/`cursor` to paint the input box;
// the event loop feeds `Key`s in.
//
// Cursor positions are character (code-point) offsets into the whole buffer,
// so multi-byte input stays correct and single-line behavior is unchanged when
// no newlines are present. Readline-style bindings (Ctrl-A/E/U/W/K) are
// line-local, matching pi/emacs. Vertical arrows move between lines.

import type { Key } from "./key.ts";

/** Result of one keystroke: `submitted` is set when the user presses Enter. */
export interface HandleResult {
  submitted: string | null;
}

/** A multi-line editor with cursor, used for the TUI input box. */
export class InputEditor {
  #chars: string[] = [];
  #cursor = 0;

  /** The current input text (may contain `\n`). */
  get text(): string {
    return this.#chars.join("");
  }

  /** The cursor position as a character (code-point) offset. */
  get cursor(): number {
    return this.#cursor;
  }

  /** Apply one keystroke. Returns `{ submitted }` when Enter is pressed. */
  handle(key: Key): HandleResult {
    switch (key.kind) {
      case "char":
        this.#chars.splice(this.#cursor, 0, key.char);
        this.#cursor += [...key.char].length;
        return { submitted: null };
      case "newline": // Ctrl-J / pasted LF: insert a line break
        this.#chars.splice(this.#cursor, 0, "\n");
        this.#cursor += 1;
        return { submitted: null };
      case "enter": {
        const text = this.text;
        if (text.length === 0) return { submitted: null };
        this.clear();
        return { submitted: text };
      }
      case "backspace":
        if (this.#cursor > 0) {
          this.#chars.splice(this.#cursor - 1, 1);
          this.#cursor -= 1;
        }
        return { submitted: null };
      case "delete":
        if (this.#cursor < this.#chars.length) {
          this.#chars.splice(this.#cursor, 1);
        }
        return { submitted: null };
      case "arrow":
        return this.#handleArrow(key.dir);
      case "home":
        this.#cursor = this.#lineStartAt(this.#cursor);
        return { submitted: null };
      case "end":
        this.#cursor = this.#lineEndAt(this.#cursor);
        return { submitted: null };
      case "ctrl":
        return this.#handleCtrl(key.char);
      case "escape":
        this.clear();
        return { submitted: null };
      case "tab":
      case "page":
        return { submitted: null };
    }
  }

  /** Replace the whole buffer (e.g. restoring from history). */
  setText(text: string): void {
    this.#chars = [...text];
    this.#cursor = this.#chars.length;
  }

  /** Clear the buffer and reset the cursor. */
  clear(): void {
    this.#chars = [];
    this.#cursor = 0;
  }

  /** Left/right move by one code point; up/down move between lines. */
  #handleArrow(dir: "up" | "down" | "left" | "right"): HandleResult {
    if (dir === "left") {
      this.#cursor = Math.max(0, this.#cursor - 1);
    } else if (dir === "right") {
      this.#cursor = Math.min(this.#chars.length, this.#cursor + 1);
    } else if (dir === "up") {
      const ls = this.#lineStartAt(this.#cursor);
      if (ls === 0) return { submitted: null }; // already on the first line
      const prevNewline = ls - 1; // index of the `\n` ending the previous line
      const prevStart = this.#lineStartAt(prevNewline);
      const col = this.#cursor - ls;
      this.#cursor = prevStart + Math.min(col, prevNewline - prevStart);
    } else {
      // down
      const le = this.#lineEndAt(this.#cursor);
      if (le >= this.#chars.length) return { submitted: null }; // last line
      const ls = this.#lineStartAt(this.#cursor);
      const col = this.#cursor - ls;
      const nextStart = le + 1; // past the `\n`
      const nextEnd = this.#lineEndAt(nextStart);
      this.#cursor = nextStart + Math.min(col, nextEnd - nextStart);
    }
    return { submitted: null };
  }

  #handleCtrl(ch: string): HandleResult {
    switch (ch) {
      case "a":
        this.#cursor = this.#lineStartAt(this.#cursor);
        break;
      case "e":
        this.#cursor = this.#lineEndAt(this.#cursor);
        break;
      case "u": // clear to start of line
        this.#chars.splice(
          this.#lineStartAt(this.#cursor),
          this.#cursor - this.#lineStartAt(this.#cursor),
        );
        this.#cursor = this.#lineStartAt(this.#cursor);
        break;
      case "k": { // kill to end of line
        const lineEnd = this.#lineEndAt(this.#cursor);
        this.#chars.splice(this.#cursor, lineEnd - this.#cursor);
        break;
      }
      case "w": { // delete the previous word
        let i = this.#cursor;
        while (i > 0 && this.#chars[i - 1] === " ") i -= 1;
        while (i > 0 && this.#chars[i - 1] !== " ") i -= 1;
        this.#chars.splice(i, this.#cursor - i);
        this.#cursor = i;
        break;
      }
      default:
        break;
    }
    return { submitted: null };
  }

  /** Offset of the first char of the line containing `offset`. */
  #lineStartAt(offset: number): number {
    for (let i = offset - 1; i >= 0; i--) {
      if (this.#chars[i] === "\n") return i + 1;
    }
    return 0;
  }

  /** Offset just past the last char of the line containing `offset` (the index
   * of the terminating `\n`, or the buffer end). */
  #lineEndAt(offset: number): number {
    for (let i = offset; i < this.#chars.length; i++) {
      if (this.#chars[i] === "\n") return i;
    }
    return this.#chars.length;
  }
}

/** A visible slice of the multi-line input, with the cursor kept on screen. */
export interface InputView {
  /** Visible visual rows, each already wrapped to ≤ `width` columns. */
  rows: string[];
  /** Cursor row within `rows` (0 = first visible row). */
  cursorRow: number;
  /** Cursor column within that row. */
  cursorCol: number;
}

/** One visual row: the char offset where it begins, and its text. */
interface VisualRow {
  start: number;
  text: string;
}

/**
 * Compute the visible window of a (possibly multi-line) input string for a
 * `width`-column box up to `maxRows` rows, keeping the cursor on screen. Pure
 * so the layout math is unit-testable. Each code point is one column
 * (double-width/CJK is a known v1 limitation); lines char-wrap at `width`.
 */
export function inputView(
  text: string,
  cursor: number,
  width: number,
  maxRows: number,
): InputView {
  if (width <= 0 || maxRows <= 0) {
    return { rows: [], cursorRow: 0, cursorCol: 0 };
  }
  const chars = [...text];

  // Split into logical lines (each with the char offset where it starts).
  const lines: VisualRow[] = [];
  let lineStart = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || chars[i] === "\n") {
      lines.push({
        start: lineStart,
        text: chars.slice(lineStart, i).join(""),
      });
      lineStart = i + 1; // skip the `\n`
    }
  }

  // Char-wrap each logical line into `width`-column visual rows.
  const visual: VisualRow[] = [];
  for (const ln of lines) {
    if (ln.text.length === 0) {
      visual.push({ start: ln.start, text: "" });
      continue;
    }
    for (let j = 0; j < ln.text.length; j += width) {
      visual.push({ start: ln.start + j, text: ln.text.slice(j, j + width) });
    }
  }

  // Find the visual row holding the cursor (the last row whose start ≤ cursor,
  // so a cursor at a row boundary sits at col 0 of the following row).
  let cursorRow = 0;
  for (let r = 0; r < visual.length; r++) {
    if (visual[r]!.start <= cursor) cursorRow = r;
    else break;
  }
  const cursorCol = Math.min(cursor - visual[cursorRow]!.start, width);

  // Window to `maxRows` rows, keeping the cursor visible.
  let top = 0;
  if (visual.length > maxRows) {
    top = Math.max(0, cursorRow - maxRows + 1);
    top = Math.min(top, visual.length - maxRows);
  }
  const rows = visual.slice(top, top + maxRows).map((v) => v.text);
  return { rows, cursorRow: cursorRow - top, cursorCol };
}
