# Goal

Iterate rho-code's TUI (Deno/TS) toward resembling the pi-coding-agent TUI,
using TDD on top of the existing pure-module test suite. See kb doc
"pi-coding-agent TUI layout reference (for rho-code)".

# Signature features to replicate (minimum)

1. **User prompt echoed as a full-width highlighted background block** on submit
   (pi `UserMessageComponent`: `userMessageBg` box).
2. **Tool calls rendered as state-colored background blocks** —
   pending/success/error bg — with bold tool name + args + output (pi
   `ToolExecutionComponent`). Use the currently-unused `tool/result` `output`
   field.
3. **Two-line footer**: line 1 `pwd (git-branch) · session`, line 2
   token/cost/context stats (left, dim) + model (right, dim). (pi
   `FooterComponent`.)

# Constraints

- Pure-logic-first: each new piece is a unit-tested pure module;
  `run.ts`/`screen.ts` only glue.
- Never break the existing 59 tests.
- `deno task test` is the project test command (no AGENTS.md). Lint =
  `deno lint`, fmt = `deno fmt`.
- Background blocks are padded to `cols` at push/replace time (matches existing
  "wrap at current cols" v1 philosophy; resize reflow is an accepted v1
  limitation, consistent with existing wrap.ts note).

# Phases

- **P1 — width utils + bg colors.** ✅ New `src/tui/width.ts`: `visibleWidth`,
  `truncateToWidth`, `padRight`. Background SGR codes in `src/ansi.ts`. Tests:
  `test/width_test.ts`.
- **P2 — block renderer.** ✅ New `src/tui/block.ts`: `blockLines`/`blockBlank`.
  Tests: `test/block_test.ts`.
- **P3 — scrollback multi-line replace.** ✅ `Scrollback.replaceLastN`. Tests in
  `test/scrollback_test.ts`.
- **P4 — footer builder.** ✅ New `src/tui/footer.ts`: `buildFooter` +
  `formatTokens`. Tests: `test/footer_test.ts`.
- **P5 — wire into the TUI.** ✅ User-prompt echo blocks; tool
  call/result/denied blocks (capturing `output`); cumulative token/cost from
  `usage`; cwd + git branch; `buildFooter`; dropped sticky header for a
  scrollback banner; Screen 2-footer layout. New `test/tool_block_test.ts`.
  `--allow-env` added to tasks.
- **P6 — verify + commit.** ✅ 99 tests green; `deno lint`/`deno fmt --check`
  clean; `deno check main.ts` clean; live pty smoke (rho 0.86.0) renders banner
  - footer + model, clean exit.

# Out of scope for this pass (future work)

- Bordered multi-line editor (pi's editor border + Shift+Enter newline).
- Collapsible thinking blocks (Ctrl-T).
- Tool-output expand/collapse (Ctrl-O).
- @-file completion, image paste, OSC 133 zones.
