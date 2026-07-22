// Command-bar, footer, and working-line builders. Pure: given a snapshot of
// session state and the terminal width, returns the rendered lines (no I/O).
// Layout:
//   command bar (sticky, top): a compact, dim hint strip of the most useful
//     slash commands and keybindings — always visible while the scrollback
//     flows underneath.
//   footer (sticky, very bottom, 2 lines, mirrors pi's FooterComponent):
//     line 1 `cwd (git-branch) • session` — dim, ~-substituted, truncated;
//     line 2 `↑in ↓out R:cached $cost ctx%/window(auto)` (left, dim) … `model`
//     (right, dim). Context % red >90%, yellow >70%.
//   working line (transient, above the input box while a turn runs): spinner +
//     `Working` + elapsed + activity + `↻N: preview` (latest steer, if any).

import { bold, dim, gray, red, reset, yellow } from "../ansi.ts";
import { padRight, truncateToWidth, visibleWidth } from "./width.ts";

/** Compact token-count formatting, matching pi's footer. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Snapshot of the session state the footer reflects. */
export interface FooterState {
  cwd: string;
  home?: string;
  gitBranch?: string;
  sessionName?: string;
  /** Cumulative input tokens (0 hides the part). */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Total session cost (0 hides the part). */
  cost?: number;
  /** 0–100, or undefined for unknown (post-compaction). */
  contextPercent?: number;
  contextWindow?: number;
  autoCompact?: boolean;
  model: string;
  provider?: string;
  /** Prefix the model with `(provider)` when true. */
  showProvider?: boolean;
  /** Terminal columns. */
  width: number;
}

/** Substitute `$HOME` with `~`, then append branch and session name. */
function formatPwd(s: FooterState): string {
  let p = s.cwd;
  const home = s.home;
  if (home) {
    if (p === home) p = "~";
    else if (p.startsWith(home + "/")) p = "~" + p.slice(home.length);
  }
  if (s.gitBranch) p += ` (${s.gitBranch})`;
  if (s.sessionName) p += ` • ${s.sessionName}`;
  return p;
}

/** The colored context band: `pct%/window(auto)` with threshold coloring. */
function contextPart(s: FooterState): string {
  const win = formatTokens(s.contextWindow ?? 0);
  const auto = s.autoCompact ? "(auto)" : "";
  const pct = s.contextPercent;
  const text = pct == null ? `?/${win}${auto}` : `${pct}%/${win}${auto}`;
  const color = pct == null ? dim : pct > 90 ? red : pct > 70 ? yellow : dim;
  return `${color}${text}${reset}`;
}

// ── Command bar (sticky top) ──────────────────────────────────────────────

/** Build the sticky TOP command-hint bar: a compact, dim strip of the most
 * useful slash commands and keybindings. Keeps the reference visible while the
 * scrollback flows underneath. Truncates to `width` (the leftmost, most-used
 * commands survive) and pads to full width so the row fills the line. Pure. */
export function buildCommandBar(width: number): string {
  const cmds = "/help /model /resume /compact /stats /new /quit";
  const keys = "Ctrl-L · Ctrl-O · Ctrl-T · Ctrl-J";
  const text = `${cmds}  ${keys}`;
  const styled = `${dim}${truncateToWidth(text, width, "")}${reset}`;
  return padRight(styled, width);
}

// ── Footer (sticky bottom, pi-style two lines) ────────────────────────────

/** Build the two footer lines for the given state and terminal width.
 * Mirrors pi's FooterComponent: line 1 `cwd (git-branch) • session`, line 2
 * token/cost/context stats (left) + model (right). Pure. */
export function buildFooter(s: FooterState): string[] {
  const pwd = `${dim}${truncateToWidth(formatPwd(s), s.width, "...")}${reset}`;
  const stats = buildStatsLine(s);
  return [pwd, stats];
}

/** Assemble the stats line: left token/cost/context parts, right-aligned model. */
function buildStatsLine(s: FooterState): string {
  const parts: string[] = [];
  if (s.inputTokens) {
    parts.push(`${dim}↑${formatTokens(s.inputTokens)}${reset}`);
  }
  if (s.outputTokens) {
    parts.push(`${dim}↓${formatTokens(s.outputTokens)}${reset}`);
  }
  if (s.cachedTokens) {
    parts.push(`${dim}R${formatTokens(s.cachedTokens)}${reset}`);
  }
  if (s.cost && s.cost > 0) parts.push(`${dim}$${s.cost.toFixed(3)}${reset}`);

  const left = parts.length > 0
    ? parts.join(" ") + " " + contextPart(s)
    : contextPart(s);
  const rightCore = s.showProvider && s.provider
    ? `(${s.provider}) ${s.model}`
    : s.model;
  const right = `${dim}${rightCore}${reset}`;

  const leftW = visibleWidth(left);
  const rightW = visibleWidth(right);
  const minGap = 2;

  if (leftW + minGap + rightW <= s.width) {
    const pad = " ".repeat(s.width - leftW - rightW);
    return left + pad + right;
  }
  // Not enough room for both: try to keep the model, truncated.
  const availForRight = s.width - leftW - minGap;
  if (availForRight > 0) {
    const truncRight = truncateToWidth(right, availForRight, "");
    const pad = " ".repeat(
      Math.max(0, s.width - leftW - visibleWidth(truncRight)),
    );
    return left + pad + truncRight;
  }
  // No room for the model at all: drop it, truncate the stats.
  return truncateToWidth(left, s.width, "...");
}

// ── Working status line ───────────────────────────────────────────────────

/** Snapshot for the transient "Working" line shown above the input box while an
 * agent turn runs. */
export interface WorkingLineState {
  spinner: string;
  elapsedMs: number;
  /** Current activity label, e.g. "thinking" / "read" / "responding". */
  activity?: string;
  /** Steering messages sent during the current turn (0 hides the indicator). */
  steers?: number;
  /** Preview text of the most recent steer; shown as `↻N: preview` so the latest
   * steering message stays visible while the turn runs, instead of scrolling
   * away in the output region. */
  steerPreview?: string;
}

/**
 * Build the working-status line: spinner + "Working" + elapsed + activity +
 * `↻N[: preview]`. Pure. Left-aligned (not padded) — the renderer clears the
 * rest of the row.
 */
export function buildWorkingLine(s: WorkingLineState): string {
  const secs = (s.elapsedMs / 1000).toFixed(1);
  const parts: string[] = [
    `${yellow}${s.spinner}${reset} ${bold}Working${reset} ${dim}${secs}s${reset}`,
  ];
  if (s.activity) parts.push(`${gray}${s.activity}${reset}`);
  if (s.steers && s.steers > 0) {
    const preview = s.steerPreview ? `: ${s.steerPreview}` : "";
    parts.push(`${yellow}↻${s.steers}${reset}${dim}${preview}${reset}`);
  }
  return parts.join(" ");
}
