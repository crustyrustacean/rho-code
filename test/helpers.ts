// Shared test fixtures: concise Key builders for input/editor tests.

import type { Key } from "../src/tui/key.ts";

/** A printable-character key. */
export function char(c: string): Key {
  return { kind: "char", char: c };
}

/**
 * Build a non-char Key. `k("enter")`, `k("arrow", "left")`, `k("ctrl", "a")`,
 * `k("page", "up")`, etc.
 */
export function k(
  kind: Key["kind"],
  arg?: string,
): Key {
  switch (kind) {
    case "enter":
    case "backspace":
    case "delete":
    case "tab":
    case "escape":
    case "home":
    case "end":
      return { kind } as Key;
    case "arrow":
      return { kind: "arrow", dir: arg as "up" | "down" | "left" | "right" };
    case "page":
      return { kind: "page", dir: arg as "up" | "down" };
    case "ctrl":
      return { kind: "ctrl", char: arg! };
    case "char":
      return { kind: "char", char: arg ?? "" };
  }
}
