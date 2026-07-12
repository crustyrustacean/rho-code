# rho-code

Interactive REPL frontend for the [rho coding agent](https://github.com/jeff-mitchell/rho). Spawns rho in headless JSON-RPC mode and provides a terminal-based chat interface.

## Features

- Streams agent responses, reasoning, and tool activity in real time
- Interactive approval prompts for tool calls requiring confirmation
- `/abort` to cancel an in-progress request, `/quit` to exit
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
