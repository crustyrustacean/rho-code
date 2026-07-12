// A single-line text input editor. Pure logic: keystrokes mutate an internal
// text buffer and a char-offset cursor, with no terminal I/O. The render layer
// reads `text`/`cursor` to paint the input box; the event loop feeds `Key`s in.
//
// Cursor positions are character (code-point) offsets, so multi-byte input
// stays correct. Readline-style bindings (Ctrl-A/E/U/W) are supported.

import type { Key } from "./key.ts";

/** Result of one keystroke: `submitted` is set when the user presses Enter. */
export interface HandleResult {
  submitted: string | null;
}

/** A single-line editor with cursor, used for the TUI input box. */
export class InputEditor {
  #chars: string[] = [];
  #cursor = 0;

  /** The current input text. */
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
        if (key.dir === "left") this.#cursor = Math.max(0, this.#cursor - 1);
        else if (key.dir === "right") {
          this.#cursor = Math.min(this.#chars.length, this.#cursor + 1);
        }
        return { submitted: null };
      case "home":
        this.#cursor = 0;
        return { submitted: null };
      case "end":
        this.#cursor = this.#chars.length;
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

  #handleCtrl(ch: string): HandleResult {
    switch (ch) {
      case "a":
        this.#cursor = 0;
        break;
      case "e":
        this.#cursor = this.#chars.length;
        break;
      case "u":
        this.clear();
        break;
      case "k": // kill to end of line
        this.#chars.length = this.#cursor;
        break;
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
}

/** A slice of the input text that fits `width` columns, with the cursor visible. */
export interface InputView {
  /** The visible substring of the input. */
  view: string;
  /** The cursor column within `view` (0 = before the first visible char). */
  col: number;
}

/**
 * Compute the visible window of an input string for a `width`-column box,
 * keeping the cursor on screen. Pure so the layout math is unit-testable.
 *
 * Each code point counts as one column (double-width/CJK handling is a known
 * v1 limitation). When the text fits, the whole string is shown.
 */
export function inputView(text: string, cursor: number, width: number): InputView {
  const chars = [...text];
  if (width <= 0) return { view: "", col: 0 };
  if (chars.length <= width) return { view: text, col: cursor };
  // Anchor the window so the cursor stays visible, biased toward the right
  // edge (so typing at the end keeps new characters in view).
  let start = Math.max(0, cursor - width + 1);
  start = Math.min(start, chars.length - width);
  return {
    view: chars.slice(start, start + width).join(""),
    col: cursor - start,
  };
}
