// Tests for the two-line footer builder (pwd line + stats/model line). Pure:
// given a snapshot of session state and the terminal width, returns the two
// rendered lines. Mirrors pi's FooterComponent layout (pwd · branch · session
// on top; token/cost/context stats left, model right, both dim).

import {
  buildFooter,
  buildWorkingLine,
  formatTokens,
} from "../src/tui/footer.ts";
import { dim, red, yellow } from "../src/ansi.ts";
import { visibleWidth } from "../src/tui/width.ts";
import { assertEquals } from "@std/assert";

/** Strip ANSI escapes so assertions can reason about the visible text. */
function plain(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

const base = {
  cwd: "/home/jeff/dev/app",
  home: "/home/jeff",
  gitBranch: "main",
  sessionName: undefined as string | undefined,
  inputTokens: 1500,
  outputTokens: 3000,
  cachedTokens: 500,
  cost: 0.012,
  contextPercent: 45 as number | undefined,
  contextWindow: 200_000,
  autoCompact: true,
  model: "claude-sonnet",
  provider: undefined as string | undefined,
  showProvider: false,
  width: 80,
};

Deno.test("formatTokens: <1k raw, <10k one decimal, <1M rounded k, <10M one-decimal M", () => {
  assertEquals(formatTokens(0), "0");
  assertEquals(formatTokens(500), "500");
  assertEquals(formatTokens(999), "999");
  assertEquals(formatTokens(1500), "1.5k");
  assertEquals(formatTokens(3000), "3.0k");
  assertEquals(formatTokens(9999), "10.0k");
  assertEquals(formatTokens(12_345), "12k");
  assertEquals(formatTokens(200_000), "200k");
  assertEquals(formatTokens(1_500_000), "1.5M");
  assertEquals(formatTokens(25_000_000), "25M");
});

Deno.test("footer pwd line: substitutes home with ~, appends branch and session", () => {
  const [pwd] = buildFooter({ ...base, sessionName: "release audit" });
  assertEquals(plain(pwd), "~/dev/app (main) • release audit");
  assertEquals(pwd.startsWith(dim), true);
});

Deno.test("footer pwd line: no home substitution when cwd is outside $HOME", () => {
  const [pwd] = buildFooter({
    ...base,
    cwd: "/opt/project",
    home: "/home/jeff",
  });
  assertEquals(plain(pwd), "/opt/project (main)");
  const [pwd2] = buildFooter({ ...base, cwd: "/etc", home: undefined });
  assertEquals(plain(pwd2), "/etc (main)");
});

Deno.test("footer pwd line: omits branch and session when absent", () => {
  const [pwd] = buildFooter({
    ...base,
    gitBranch: undefined,
    sessionName: undefined,
  });
  assertEquals(plain(pwd), "~/dev/app");
});

Deno.test("footer pwd line: truncates with an ellipsis when wider than the terminal", () => {
  const [pwd] = buildFooter({ ...base, cwd: "/" + "a".repeat(100), width: 20 });
  assertEquals(visibleWidth(pwd), 20);
  assertEquals(plain(pwd).endsWith("..."), true);
});

Deno.test("footer stats line: left stats and right-aligned model, full width", () => {
  const [, stats] = buildFooter(base);
  assertEquals(visibleWidth(stats), 80);
  const text = plain(stats);
  assertEquals(text.includes("↑1.5k"), true);
  assertEquals(text.includes("↓3.0k"), true);
  assertEquals(text.includes("R500"), true);
  assertEquals(text.includes("$0.012"), true);
  assertEquals(text.includes("45%/200k(auto)"), true);
  assertEquals(text.endsWith("claude-sonnet"), true);
});

Deno.test("footer stats line: context >90% is red, >70% is yellow, else dim", () => {
  const [, hi] = buildFooter({ ...base, contextPercent: 95 });
  assertEquals(hi.includes(`${red}95%/200k(auto)`), true);
  const [, mid] = buildFooter({ ...base, contextPercent: 75 });
  assertEquals(mid.includes(`${yellow}75%/200k(auto)`), true);
  const [, lo] = buildFooter({ ...base, contextPercent: 40 });
  assertEquals(lo.includes(`${dim}40%/200k(auto)`), true);
});

Deno.test("footer stats line: unknown context percent renders as ?", () => {
  const [, stats] = buildFooter({ ...base, contextPercent: undefined });
  assertEquals(plain(stats).includes("?/200k(auto)"), true);
});

Deno.test("footer stats line: model is dropped when the terminal is too narrow", () => {
  const [, stats] = buildFooter({ ...base, width: 10 });
  assertEquals(plain(stats).includes("claude-sonnet"), false);
});

Deno.test("footer stats line: provider prefix shown when requested and room allows", () => {
  const [, stats] = buildFooter({
    ...base,
    showProvider: true,
    provider: "anthropic",
  });
  assertEquals(plain(stats).endsWith("(anthropic) claude-sonnet"), true);
});

Deno.test("footer stats line: no token parts when usage is zero/absent", () => {
  const [, stats] = buildFooter({
    ...base,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cost: 0,
    contextPercent: 0,
  });
  const text = plain(stats);
  assertEquals(text.includes("↑"), false);
  assertEquals(text.includes("$0.000"), false);
  assertEquals(text.includes("0%/200k(auto)"), true);
});

Deno.test("buildWorkingLine: spinner + Working + elapsed + activity + steers", () => {
  const line = buildWorkingLine({
    spinner: "\u280B",
    elapsedMs: 3200,
    activity: "thinking",
    steers: 2,
  });
  const text = plain(line);
  assertEquals(text.startsWith("\u280B Working 3.2s"), true);
  assertEquals(text.includes("thinking"), true);
  assertEquals(text.includes("\u21BB2"), true); // ↻2
});

Deno.test("buildWorkingLine: omits activity and steers when absent/zero", () => {
  const line = buildWorkingLine({ spinner: "\u280B", elapsedMs: 500 });
  assertEquals(plain(line), "\u280B Working 0.5s");
});
