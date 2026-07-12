// Terminal I/O glue for the TUI: raw mode, the alternate screen buffer, and a
// full-repaint renderer. This is the only module that touches the live
// terminal; everything else is pure logic. The renderer paints three regions
// top-to-bottom — output scrollback, a status bar, and an input line — then
// parks the cursor in the input box.

import { reset } from "../ansi.ts";

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[K";

/** One screen frame for [`Screen.render`]. */
export interface Frame {
  /** Output lines, already sized to the output region's height. */
  lines: string[];
  /** Single status-bar line (model / busy / context). */
  statusBar: string;
  /** Visible input text (already windowed to the box width). */
  input: string;
  /** Cursor column within `input` (0 = before the first char). */
  inputCol: number;
}

/** Terminal dimensions. */
export interface Size {
  rows: number;
  cols: number;
}

/** Clip a line to `cols` characters so it can't wrap and break the layout. */
function clip(line: string, cols: number): string {
  return line.length <= cols ? line : line.slice(0, cols);
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
      this.writeRaw(LEAVE_ALT);
      this.#inAlt = false;
    }
  }

  /** Paint a frame. Output region height is `rows - 2` (status bar + input). */
  render(frame: Frame): void {
    const { rows, cols } = this.size();
    if (rows < 3) return; // too small to render anything useful
    const outputHeight = rows - 2;
    const inputWidth = cols;

    let buf = HOME;
    for (let r = 0; r < outputHeight; r++) {
      const line = frame.lines[r] ?? "";
      buf += clip(line, cols) + reset + CLEAR_LINE + "\n";
    }
    buf += clip(frame.statusBar, cols) + reset + CLEAR_LINE + "\n";
    buf += clip(frame.input, inputWidth) + reset + CLEAR_LINE;
    // Park the cursor in the input box at the editor's column (1-based).
    buf += `\x1b[${rows};${frame.inputCol + 1}H`;
    this.writeRaw(buf);
  }

  /** Clear the screen and show a final message before leaving (e.g. on exit). */
  farewell(_message: string): void {
    // Kept for future "exit summary" rendering; currently a no-op.
  }

  #write(text: string): void {
    this.writeRaw(text);
  }

  private writeRaw(text: string): void {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  }
}
