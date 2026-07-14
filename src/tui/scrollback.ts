// The output scrollback: an append-only line buffer with a scroll offset, used
// to render the conversation region of the TUI. Pure logic — the render layer
// sets `viewportHeight` and calls `visible(height)` to get the lines on screen.
//
// Scrolling model: `offset` counts lines above the bottom the view is parked at
// (0 = pinned to bottom). New output auto-scrolls only when already at the
// bottom; while scrolled up, pushes hold the view in place. Clamping needs the
// viewport height, so the render loop sets it each frame.

import { wrapLine } from "./wrap.ts";

export interface ScrollbackOptions {
  /** Maximum lines retained; oldest are trimmed. Default 10_000. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 10_000;

export class Scrollback {
  #lines: string[] = [];
  #offset = 0; // lines above the bottom the view is parked at (0 = bottom)
  readonly #maxLines: number;
  /** Tracked blocks keyed by id, mapping to their [start, start+len) slice of
   * `#lines` so they can be replaced in place (tool-block expand/collapse). */
  #blocks = new Map<number, { start: number; len: number }>();
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
    this.#trim();
    if (!wasAtBottom) this.#offset += 1;
  }

  /** Append a tracked block under `id` (its lines can later be replaced in
   * place via replaceBlock, even after other content is pushed). */
  pushBlock(id: number, lines: string[]): void {
    const wasAtBottom = this.atBottom;
    const start = this.#lines.length;
    for (const line of lines) this.#lines.push(line);
    this.#blocks.set(id, { start, len: lines.length });
    this.#trim();
    if (!wasAtBottom) this.#offset += lines.length;
  }

  /** Replace block `id`'s lines in place (for expand/collapse). Returns false
   * if the id is unknown (never pushed, or trimmed away). */
  replaceBlock(id: number, lines: string[]): boolean {
    const block = this.#blocks.get(id);
    if (!block) return false;
    const delta = lines.length - block.len;
    this.#lines.splice(block.start, block.len, ...lines);
    block.len = lines.length;
    if (delta !== 0) {
      // Shift any blocks that start after this one.
      for (const other of this.#blocks.values()) {
        if (other !== block && other.start > block.start) other.start += delta;
      }
      if (!this.atBottom) {
        this.#offset = Math.max(
          0,
          Math.min(this.#offset + delta, this.#maxOffset),
        );
      }
    }
    return true;
  }

  /** Trim the oldest lines past the cap, dropping block tracking for any block
   * whose start lands in the trimmed region (it can no longer be replaced). */
  #trim(): void {
    if (this.#lines.length <= this.#maxLines) return;
    const excess = this.#lines.length - this.#maxLines;
    this.#lines.splice(0, excess);
    for (const [id, b] of this.#blocks) {
      if (b.start >= excess) b.start -= excess;
      else this.#blocks.delete(id);
    }
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

  /** Replace the last `n` lines with `lines` (a multi-line block repaint).
   *
   * Used to live-update a tool-call block: the pending block is pushed, then
   * repainted as success/error once the result arrives. When pinned to the
   * bottom the view stays pinned; when scrolled up the view is kept over the
   * same content (the offset tracks the net change in line count). */
  replaceLastN(n: number, lines: string[]): void {
    const wasAtBottom = this.atBottom;
    const removeCount = Math.min(n, this.#lines.length);
    if (removeCount > 0) {
      this.#lines.splice(this.#lines.length - removeCount, removeCount);
    }
    for (const line of lines) {
      this.#lines.push(line);
      this.#trim();
      if (!wasAtBottom) this.#offset += 1;
    }
    if (!wasAtBottom) {
      // The removal moved the bottom up by `removeCount`; counteract so a
      // scrolled-up view keeps the same content in frame.
      this.#offset = Math.max(0, this.#offset - removeCount);
      this.#offset = Math.min(this.#offset, this.#maxOffset);
    }
  }

  /** The lines currently visible in a `height`-row window `cols` columns wide.
   *
   * Lines are wrapped to `cols` (ANSI-aware) and the view is bottom-anchored:
   * the newest content fills from the bottom up, accounting for the scroll
   * offset (in logical lines). */
  visible(height: number, cols: number): string[] {
    const rows: string[] = [];
    for (let i = this.#lines.length - this.#offset - 1; i >= 0; i--) {
      if (rows.length >= height) break;
      rows.unshift(...wrapLine(this.#lines[i]!, cols));
    }
    return rows.slice(-height);
  }

  /** Snapshot of the scrollback's internal state, for the Ctrl-D debug dump. */
  debugState(): {
    lineCount: number;
    offset: number;
    atBottom: boolean;
    viewportHeight: number;
  } {
    return {
      lineCount: this.#lines.length,
      offset: this.#offset,
      atBottom: this.atBottom,
      viewportHeight: this.viewportHeight,
    };
  }
}
