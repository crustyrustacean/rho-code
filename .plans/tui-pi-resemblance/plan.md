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

- **P1 — width utils + bg colors.** New `src/tui/width.ts`: `visibleWidth`,
  `truncateToWidth`, `padRight`. Add background SGR codes (`bgUser`,
  `bgToolPending`, `bgToolSuccess`, `bgToolError`, `bgCode`) to `src/ansi.ts`.
  Tests: `test/width_test.ts`.
- **P2 — block renderer.** New `src/tui/block.ts`:
  `blockLines(content, cols, bgCode, padX)` → full-width bg-padded styled lines.
  Tests: `test/block_test.ts`.
- **P3 — scrollback multi-line replace.** Add
  `Scrollback.replaceLastN(n, lines)` and expose a line-count getter for the
  last block. Tests appended to `test/scrollback_test.ts`.
- **P4 — footer builder.** New `src/tui/footer.ts`: pure `buildFooter(state)` →
  `[pwdLine, statsLine]` with token formatting, dim styling, right-aligned
  model, context-% color thresholds. Tests: `test/footer_test.ts`.
- **P5 — wire into the TUI.** `run.ts`: echo user prompts as blocks; render tool
  call/result/denied as blocks capturing `output`; accumulate
  input/output/cached tokens from `usage`; fetch cwd+git branch; call
  `buildFooter`. `screen.ts`: drop sticky header (move hints into a startup
  banner in the scrollback), render 2-row footer, layout = output(rows-3) +
  footer(2) + input(1). Add `formatTokens` shared helper.
- **P6 — verify + commit.** `deno task test` all green; `deno lint`; `deno fmt`;
  manual `deno task dev` smoke if a TTY is available. Commit per phase, final
  commit on the branch.

# Out of scope for this pass (future work)

- Bordered multi-line editor (pi's editor border + Shift+Enter newline).
- Collapsible thinking blocks (Ctrl-T).
- Tool-output expand/collapse (Ctrl-O).
- @-file completion, image paste, OSC 133 zones.
