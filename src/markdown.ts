// Streaming markdown formatter: buffers partial lines from message/delta and
// applies ANSI formatting to complete lines as they arrive. Handles headers,
// bold, italic, inline code, and fenced code blocks.
//
// Emits one finished line (with ANSI styling, no trailing newline) per call to
// the configured sink. The TUI points the sink at the scrollback; tests can
// point it at an array. Kept free of `process.stdout` so it composes with the
// TUI's line-based output region.

import {
  bold,
  codeBg,
  codeFg,
  cyan,
  italic,
  reset,
  underline,
} from "./ansi.ts";

let lineBuffer = "";
let inCodeBlock = false;

/** Current sink for finished lines. Defaults to a no-op until configured. */
let emit: (line: string) => void = () => {};

/** Set where finished, styled lines are sent (e.g. the TUI scrollback). */
export function setMarkdownSink(fn: (line: string) => void): void {
  emit = fn;
}

const RE_CODE_BLOCK = /^\s{0,3}```/;
const RE_INLINE_CODE = /\x60([^\x60]+)\x60/g;
const RE_BOLD = /\*\*([^*]+)\*\*/g;
const RE_ITALIC = /(?<!\*)\*([^*]+)\*(?!\*)/g;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;

function flushFormattedLine(line: string): void {
  if (inCodeBlock) {
    if (RE_CODE_BLOCK.test(line)) {
      inCodeBlock = false;
      emit(reset);
    } else {
      emit(codeBg + codeFg + line + reset);
    }
    return;
  }

  if (RE_CODE_BLOCK.test(line)) {
    inCodeBlock = true;
    return;
  }

  if (line === "") {
    emit("");
    return;
  }

  const headingMatch = line.match(RE_HEADING);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    const text = headingMatch[2]!;
    if (level === 1) emit(bold + cyan + text + reset);
    else if (level === 2) emit(bold + underline + text + reset);
    else emit(bold + text + reset);
    return;
  }

  let formatted = line;
  formatted = formatted.replace(
    RE_INLINE_CODE,
    (_m, p1) => codeBg + codeFg + p1 + reset,
  );
  formatted = formatted.replace(RE_BOLD, (_m, p1) => bold + p1 + reset);
  formatted = formatted.replace(RE_ITALIC, (_m, p1) => italic + p1 + reset);
  emit(formatted);
}

/** Feed a streaming delta; complete lines are flushed to the sink. */
export function writeMarkdownChunk(delta: string): void {
  lineBuffer += delta;
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    flushFormattedLine(line);
  }
}

/** Flush any buffered partial line and close an open code block. */
export function flushMarkdownBuffer(): void {
  if (lineBuffer.length > 0) {
    flushFormattedLine(lineBuffer);
    lineBuffer = "";
  }
  if (inCodeBlock) {
    inCodeBlock = false;
    emit(reset);
  }
}

/** Reset all internal state (line buffer, code block tracking).
 * Call between sessions so a mid-stream code block in one session
 * doesn't leak formatting into the next. */
export function resetMarkdown(): void {
  lineBuffer = "";
  inCodeBlock = false;
}
