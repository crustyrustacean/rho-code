// Two-line footer builder, mirroring pi's FooterComponent. Pure: given a
// snapshot of session state and the terminal width, returns the two rendered
// lines (no I/O). Layout:
//   line 1: `cwd (git-branch) · session-name` — dim, ~-substituted, truncated.
//   line 2: `↑in ↓out R:cached $cost ctx%/window(auto)` (left, dim) … `model`
//           (right, dim). The context % is red >90%, yellow >70%, else dim.

import { dim, red, reset, yellow } from "../ansi.ts";
import { truncateToWidth, visibleWidth } from "./width.ts";

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

/** Build the two footer lines for the given state and terminal width. */
export function buildFooter(s: FooterState): string[] {
  const pwd = `${dim}${truncateToWidth(formatPwd(s), s.width, "...")}${reset}`;
  const stats = buildStatsLine(s);
  return [pwd, stats];
}

/** Assemble the stats line: left token/cost/context parts, right-aligned model. */
function buildStatsLine(s: FooterState): string {
  const parts: string[] = [];
  if (s.inputTokens) parts.push(`${dim}↑${formatTokens(s.inputTokens)}${reset}`);
  if (s.outputTokens) parts.push(`${dim}↓${formatTokens(s.outputTokens)}${reset}`);
  if (s.cachedTokens) parts.push(`${dim}R${formatTokens(s.cachedTokens)}${reset}`);
  if (s.cost && s.cost > 0) parts.push(`${dim}$${s.cost.toFixed(3)}${reset}`);

  const left = parts.length > 0 ? parts.join(" ") + " " + contextPart(s) : contextPart(s);
  const rightCore = s.showProvider && s.provider ? `(${s.provider}) ${s.model}` : s.model;
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
    const pad = " ".repeat(Math.max(0, s.width - leftW - visibleWidth(truncRight)));
    return left + pad + truncRight;
  }
  // No room for the model at all: drop it, truncate the stats.
  return truncateToWidth(left, s.width, "...");
}
