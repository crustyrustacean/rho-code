# rho-code

Interactive REPL frontend for the
[rho coding agent](https://github.com/jeff-mitchell/rho). Spawns rho in headless
JSON-RPC mode and provides a terminal-based chat interface.

## Features

- Terminal UI modeled on the
  [pi coding agent](https://github.com/earendil-works/pi-mono) chat interface:
  - **Bordered multi-line editor** — press `Ctrl-J` (or paste) for a new line;
    `Enter` submits. Up/Down navigate lines; Home/End and Ctrl-A/E/Ctrl-K are
    line-local. The box grows up to five rows.
  - **Highlighted user-message blocks** — your prompts are echoed as full-width
    tinted blocks.
  - **Tool-call blocks** — each tool call renders in a state-colored block (gray
    while running, green on success, red on error) showing the tool name,
    arguments, and trimmed output. Press `Ctrl-O` to expand/collapse the most
    recent tool's full output in place.
  - **Two-line footer** — working directory `(git-branch)` on top; token
    throughput (`↑in ↓out R:cached`), cost, and context usage on the bottom,
    with the model right-aligned. While a turn runs a spinner + elapsed lead the
    line and a `↻N` marker counts steers sent. Context % turns yellow past 70%
    and red past 90%.
  - **Scroll anywhere** — `PgUp`/`PgDn`, or `Shift`/`Alt`/`Ctrl` + ↑/↓ on
    keyboards without dedicated page keys (e.g. macOS).
- Streams agent responses, reasoning, and tool activity in real time
- Markdown rendering for assistant messages (headings, bold/italic, code)
- Type while rho works to steer the active turn
- Interactive approval prompts for tool calls requiring confirmation
- `/resume` opens an interactive session picker (↑↓ navigate, enter resume, esc
  cancel); `/resume <path>` resumes by path
- `Ctrl-L` (or `/model`) opens a model picker; `/providers` opens a provider
  picker that drills into that provider's models
- `/abort` to cancel an in-progress request, `/quit` (or `/q`, `/exit`) to exit;
  `/help` for the full command list
- Compile to a standalone binary with `deno compile`

## Prerequisites

- [Deno](https://deno.land/) 1.40+
- [rho](https://github.com/jeff-mitchell/rho) installed and on your `PATH`

## Usage

### Development (with hot reload)

```sh
deno task dev
```

### Build standalone binary

```sh
deno task build
```

This produces an executable `rho-code` in the project directory.

### Tests

```sh
deno task test
```

## License

MIT — see [LICENSE](./LICENSE) for details.
