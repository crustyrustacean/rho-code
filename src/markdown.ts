// Streaming markdown formatter: buffers partial lines and applies ANSI
// formatting to complete lines as they arrive via message/delta. Handles
// headers, bold, italic, inline code, and fenced code blocks.

import { reset, bold, cyan, italic, underline, codeBg, codeFg } from "./ansi.ts";

let lineBuffer = "";
let inCodeBlock = false;

const RE_CODE_BLOCK = /^\s{0,3}```/;
const RE_INLINE_CODE = /\x60([^\x60]+)\x60/g;
const RE_BOLD = /\*\*([^*]+)\*\*/g;
const RE_ITALIC = /(?<!\*)\*([^*]+)\*(?!\*)/g;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;

function flushFormattedLine(line: string) {
  if (inCodeBlock) {
    if (RE_CODE_BLOCK.test(line)) {
      inCodeBlock = false;
      process.stdout.write(reset + "\n");
    } else {
      process.stdout.write(codeBg + codeFg + line + reset + "\n");
    }
    return;
  }

  if (RE_CODE_BLOCK.test(line)) {
    inCodeBlock = true;
    return;
  }

  if (line === "") {
    process.stdout.write("\n");
    return;
  }

  const headingMatch = line.match(RE_HEADING);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    const text = headingMatch[2]!;
    if (level === 1) process.stdout.write(bold + cyan + text + reset + "\n");
    else if (level === 2) process.stdout.write(bold + underline + text + reset + "\n");
    else process.stdout.write(bold + text + reset + "\n");
    return;
  }

  let formatted = line;
  formatted = formatted.replace(RE_INLINE_CODE, (_m, p1) => codeBg + codeFg + p1 + reset);
  formatted = formatted.replace(RE_BOLD, (_m, p1) => bold + p1 + reset);
  formatted = formatted.replace(RE_ITALIC, (_m, p1) => italic + p1 + reset);
  process.stdout.write(formatted + "\n");
}

export function writeMarkdownChunk(delta: string) {
  lineBuffer += delta;
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    flushFormattedLine(line);
  }
}

export function flushMarkdownBuffer() {
  if (lineBuffer.length > 0) {
    flushFormattedLine(lineBuffer);
    lineBuffer = "";
  }
  if (inCodeBlock) {
    inCodeBlock = false;
    process.stdout.write(reset + "\n");
  }
}
