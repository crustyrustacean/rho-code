// A generic list picker for overlay UIs (e.g. the session resume picker). Pure
// navigation + windowing logic — no rendering, no I/O — driven by the same
// `Key` type the terminal loop produces. The render layer reads `visible()`
// each frame; `handle()` returns the user's decision.

import type { Key } from "./key.ts";

/** Outcome of one keystroke in the picker. */
export type PickerAction = "select" | "cancel" | null;

/**
 * A navigable list. `items` are pre-formatted display strings (one per row);
 * the caller maps the selected index back to the underlying data. The viewport
 * height is set by the render loop so windowing fits the screen.
 */
export class SessionPicker {
  readonly items: string[];
  #selected = 0;
  #top = 0; // index of the first visible row
  /** Visible-row count, set by the render loop so the window fits. */
  viewportHeight = 0;

  constructor(items: string[]) {
    this.items = items;
  }

  /** The currently selected row index (0-based). */
  get selected(): number {
    return this.#selected;
  }

  /** Number of items in the list. */
  get count(): number {
    return this.items.length;
  }

  /** Apply one keystroke; returns "select"/"cancel" when the user decides. */
  handle(key: Key): PickerAction {
    switch (key.kind) {
      case "enter":
        return "select";
      case "escape":
        return "cancel";
      case "arrow":
        if (key.dir === "up") this.#move(-1);
        else if (key.dir === "down") this.#move(1);
        return null;
      case "page":
        this.#move(key.dir === "up" ? -this.#page() : this.#page());
        return null;
      case "home":
        this.#setSelected(0);
        return null;
      case "end":
        this.#setSelected(this.items.length - 1);
        return null;
      default:
        return null; // typing, etc. is ignored in the picker
    }
  }

  /** The visible window, each row marked whether it's the selected one. */
  visible(): { index: number; text: string; selected: boolean }[] {
    this.#clampTop();
    const h = Math.max(1, this.viewportHeight);
    const end = Math.min(this.items.length, this.#top + h);
    const out: { index: number; text: string; selected: boolean }[] = [];
    for (let i = this.#top; i < end; i++) {
      out.push({
        index: i,
        text: this.items[i]!,
        selected: i === this.#selected,
      });
    }
    return out;
  }

  #move(delta: number): void {
    this.#setSelected(this.#selected + delta);
  }

  #setSelected(i: number): void {
    const n = this.items.length;
    this.#selected = n === 0 ? 0 : Math.max(0, Math.min(i, n - 1));
    this.#clampTop();
  }

  #page(): number {
    return Math.max(1, this.viewportHeight);
  }

  /** Keep the selected row within the visible window, scrolling if needed. */
  #clampTop(): void {
    const h = Math.max(1, this.viewportHeight);
    if (this.#selected < this.#top) this.#top = this.#selected;
    if (this.#selected >= this.#top + h) this.#top = this.#selected - h + 1;
    const maxTop = Math.max(0, this.items.length - h);
    this.#top = Math.max(0, Math.min(this.#top, maxTop));
  }
}
