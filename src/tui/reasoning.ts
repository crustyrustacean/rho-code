// Styled lines for the streaming reasoning ("thinking") block. The TUI shows a
// compact tail of the reasoning buffer while the model thinks, then collapses
// it to a summary line. Pure — no I/O — so the tail selection + wrapping is
// unit-testable.

import { dim, gray, italic, reset } from "../ansi.ts";
import { wrapLine } from "./wrap.ts";

/**
 * The wrapped, styled tail of a reasoning buffer: split on newlines, char-wrap
 * each logical line to `cols`, then keep the last `maxRows` visual rows. Each
 * returned line is dim + italic. Bounded by `maxRows` so a long train of
 * thought stays compact while streaming.
 */
export function reasoningTailLines(
  buf: string,
  cols: number,
  maxRows: number,
): string[] {
  if (maxRows <= 0 || buf.length === 0) return [];
  const rows: string[] = [];
  for (const logical of buf.split("\n")) {
    for (const seg of wrapLine(logical, cols)) {
      rows.push(`${dim}${italic}${seg}${reset}`);
    }
  }
  return rows.slice(-maxRows);
}

/**
 * The wrapped, styled FULL reasoning (for an expanded block): every logical
 * line char-wrapped to `cols`, dim + italic, capped at `maxRows` with a
 * "\u2026 (N more lines)" marker when exceeded. Pure.
 */
export function fullReasoningLines(
  buf: string,
  cols: number,
  maxRows: number,
): string[] {
  if (maxRows <= 0 || buf.length === 0) return [];
  const rows: string[] = [];
  for (const logical of buf.split("\n")) {
    for (const seg of wrapLine(logical, cols)) {
      rows.push(`${dim}${italic}${seg}${reset}`);
    }
  }
  if (rows.length <= maxRows) return rows;
  return [
    ...rows.slice(0, maxRows),
    `${gray}\u2026 (${rows.length - maxRows} more lines)${reset}`,
  ];
}
