// ANSI escape codes for terminal formatting.

export const dim = "\x1b[2m";
export const reset = "\x1b[0m";
export const bold = "\x1b[1m";
export const yellow = "\x1b[33m";
export const red = "\x1b[31m";
export const cyan = "\x1b[36m";
export const gray = "\x1b[90m";
export const green = "\x1b[32m";
export const italic = "\x1b[3m";
export const underline = "\x1b[4m";
export const codeBg = "\x1b[48;5;236m";
export const codeFg = "\x1b[38;5;252m";

// ── Backgrounds for pi-style message/tool blocks ────────────────────────
// 256-color picks that read well on dark terminals. Each paints a full-width
// block when padded out by `blockLines`.
/** Soft tint behind echoed user messages (pi `userMessageBg`). */
export const bgUser = "\x1b[48;5;239m";
/** Pending/running tool call block (pi `toolPendingBg`). */
export const bgToolPending = "\x1b[48;5;238m";
/** Successful tool call block (pi `toolSuccessBg`). */
export const bgToolSuccess = "\x1b[48;5;22m";
/** Failed tool call block (pi `toolErrorBg`). */
export const bgToolError = "\x1b[48;5;52m";
