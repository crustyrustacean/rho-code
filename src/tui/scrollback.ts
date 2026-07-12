// The output scrollback: an append-only line buffer with a scroll offset, used
// to render the conversation region of the TUI. Pure logic — the render layer
// sets `viewportHeight` and calls `visible(height)` to get the lines on screen.
//
// Scrolling model: `offset` counts lines above the bottom the view is parked at
// (0 = pinned to bottom). New output auto-scrolls only when already at the
// bottom; while scrolled up, pushes hold the view in place. Clamping needs the
// viewport height, so the render loop sets it each frame.

export interface ScrollbackOptions {
  /** Maximum lines retained; oldest are trimmed. Default 10_000. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 10_000;

export class Scrollback {
  #lines: string[] = [];
  #offset = 0; // lines above the bottom the view is parked at (0 = bottom)
  readonly #maxLines: number;
  /** Height of the output region, set by the render loop so scroll clamps fit. */
  viewportHeight = 0;

  constructor(opts: ScrollbackOptions = {}) {
    this.#maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  }

  /** The greatest legal offset (shows the topmost line at the top of the view). */
  get #maxOffset(): number {
    return Math.max(0, this.#lines.length - Math.max(1, this.viewportHeight));
  }

  /**
   * Append a line. Re-pins to the bottom if already there; otherwise bumps the
   * offset so the user's scrolled position stays over the same content.
   */
  push(line: string): void {
    const wasAtBottom = this.atBottom;
    this.#lines.push(line);
    if (this.#lines.length > this.#maxLines) {
      const excess = this.#lines.length - this.#maxLines;
      this.#lines.splice(0, excess);
    }
    if (!wasAtBottom) this.#offset += 1;
  }

  /** Whether the view is pinned to the bottom (showing the newest output). */
  get atBottom(): boolean {
    return this.#offset === 0;
  }

  /** Scroll the view up (toward older lines) by `n` lines. */
  scrollUp(n: number): void {
    this.#offset = Math.min(this.#offset + n, this.#maxOffset);
  }

  /** Scroll the view down (toward newer lines) by `n` lines. Clamps at bottom. */
  scrollDown(n: number): void {
    this.#offset = Math.max(0, this.#offset - n);
  }

  /** Re-pin to the bottom (newest output). */
  scrollToBottom(): void {
    this.#offset = 0;
  }

  /** Replace the most recent line, or push if empty. For live-updating the last
   * line (e.g. appending a tool-result marker, streaming a reasoning line). */
  replaceLast(line: string): void {
    if (this.#lines.length === 0) {
      this.#lines.push(line);
    } else {
      this.#lines[this.#lines.length - 1] = line;
    }
  }

  /** The lines currently visible in a window of `height` rows. */
  visible(height: number): string[] {
    const end = this.#lines.length - this.#offset;
    const start = Math.max(0, end - height);
    return this.#lines.slice(start, end);
  }
}
