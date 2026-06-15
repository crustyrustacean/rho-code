// rho-code — frontend for the rho-coding-agent
// Spawns rho in headless JSON-RPC mode, provides an interactive REPL

const RHO_BIN = "rho";

// ── ANSI helpers ─────────────────────────────────────────────────────────────────

const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const yellow = "\x1b[33m";
const red = "\x1b[31m";
const cyan = "\x1b[36m";
const gray = "\x1b[90m";

// ── State ──────────────────────────────────────────────────────────────────────

let resolveApproval: ((approved: boolean) => void) | null = null;
let readyResolve!: () => void;
const readyPromise = new Promise<void>((r) => {
  readyResolve = r;
});
let inReasoning = false;

// ── Spawn rho ──────────────────────────────────────────────────────────────────

const command = new Deno.Command(RHO_BIN, {
  args: ["--accept-external-provider"],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
});

const child = command.spawn();
const childStdin = child.stdin;
const childStdout = child.stdout;

if (!childStdin || !childStdout) {
  console.error("Failed to pipe stdin/stdout");
  Deno.exit(1);
}

// ── Send JSON-RPC request to rho ──────────────────────────────────────────────

function sendRequest(method: string, params: Record<string, unknown> = {}) {
  const message = JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params,
  });
  const writer = childStdin.getWriter();
  writer.write(new TextEncoder().encode(message + "\n"));
  writer.releaseLock();
}

// ── Format tool arguments for display ──────────────────────────────────────────

function formatToolArgs(args: string): string {
  try {
    const parsed = JSON.parse(args);
    // For path-only tools, just show the path
    if (parsed.path && Object.keys(parsed).length === 1) {
      return parsed.path;
    }
    // For edit_file, show path + edit count
    if (parsed.path && Array.isArray(parsed.edits)) {
      return `${parsed.path} (${parsed.edits.length} edit${
        parsed.edits.length !== 1 ? "s" : ""
      })`;
    }
    // For run_command, show the command
    if (parsed.command) {
      const cmd = parsed.command.length > 60
        ? parsed.command.slice(0, 57) + "..."
        : parsed.command;
      return cmd;
    }
    // For search, show the pattern
    if (parsed.pattern) {
      return `/${parsed.pattern}/`;
    }
    // Fallback: show key=value pairs
    return Object.entries(parsed)
      .filter(([k]) => k !== "path")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  } catch {
    return args.length > 80 ? args.slice(0, 77) + "..." : args;
  }
}

// ── Handle JSON-RPC message from rho ──────────────────────────────────────────

function handleRhoMessage(msg: Record<string, unknown>) {
  // JSON-RPC responses have "id"
  if (msg.id) {
    if (msg.error) {
      console.error(`${red}[error]${reset} ${JSON.stringify(msg.error)}`);
    }
    return;
  }

  // JSON-RPC notifications have "method" (no "id")
  const method = msg.method as string;
  const params = msg.params as Record<string, unknown>;

  switch (method) {
    case "ready":
      console.log(
        `\n${bold}rho-code${reset} — interactive frontend for rho-coding-agent`,
      );
      console.log(`${gray}Type a message, /quit to exit, /abort to cancel.${reset}\n`);
      process.stdout.write("> ");
      readyResolve();
      break;

    case "state/change":
      if (params.state === "thinking" && !inReasoning) {
        // First thinking state — model is processing
      } else if (params.state === "idle") {
        if (inReasoning) {
          inReasoning = false;
          process.stdout.write(`${reset}\n`);
        }
      }
      break;

    case "message/delta":
      // Close any open reasoning block
      if (inReasoning) {
        inReasoning = false;
        process.stdout.write(`${reset}\n\n`);
      }
      process.stdout.write(params.delta as string);
      break;

    case "reasoning/delta":
      if (!inReasoning) {
        inReasoning = true;
        process.stdout.write(`${gray}┌ thinking${reset}\n${dim}`);
      }
      process.stdout.write(params.delta as string);
      break;

    case "tool/call": {
      // Close any open reasoning block
      if (inReasoning) {
        inReasoning = false;
        process.stdout.write(`${reset}\n`);
      }
      const name = params.name as string;
      const args = formatToolArgs(params.arguments as string);
      process.stdout.write(`\n${yellow}● ${bold}${name}${reset} ${gray}${args}${reset}`);
      break;
    }

    case "tool/result": {
      const isError = params.is_error as boolean;
      process.stdout.write(
        isError
          ? ` ${red}✗${reset}\n`
          : ` ${gray}✓${reset}\n`,
      );
      break;
    }

    case "tool/denied":
      process.stdout.write(` ${yellow}blocked${reset}\n`);
      break;

    case "approval/request": {
      const risk = params.risk as string;
      const riskColor = risk === "destructive" ? red : risk === "network" ? yellow : gray;
      console.log(
        `\n${red}⚠${reset} ${bold}Approval required${reset} ${riskColor}[${risk}]${reset}`,
      );
      console.log(`  ${cyan}${params.tool}${reset} ${gray}${formatToolArgs(params.arguments as string)}${reset}`);
      process.stdout.write(`  ${gray}Allow? [y/n]${reset} `);
      resolveApproval = (approved: boolean) => {
        sendRequest("approvalResponse", { approved });
        resolveApproval = null;
      };
      break;
    }

    case "agent/start":
      break;

    case "agent/end": {
      const dur = params.durationMs as number;
      const iters = params.iterations as number;
      const toolCalls = params.toolCalls as Array<{ name: string; outcome: { kind: string } }>;
      const usage = params.usage as { totalCost: number; totalTokens: number };

      // Build summary line
      const parts: string[] = [];
      if (iters > 1) parts.push(`${iters} iterations`);
      if (toolCalls && toolCalls.length > 0) {
        parts.push(`${toolCalls.length} tool call${toolCalls.length !== 1 ? "s" : ""}`);
      }
      if (dur > 1000) {
        parts.push(`${(dur / 1000).toFixed(1)}s`);
      } else {
        parts.push(`${dur}ms`);
      }
      if (usage?.totalCost > 0) {
        parts.push(`$${usage.totalCost.toFixed(4)}`);
      }

      process.stdout.write(`\n${gray}─── ${parts.join(" · ")} ───${reset}\n`);
      process.stdout.write("> ");
      break;
    }

    case "agent/error":
      console.error(`\n${red}[error]${reset} ${params.error}`);
      process.stdout.write("> ");
      break;

    default:
      console.log(`[${method}]`, JSON.stringify(params));
  }
}

// ── Read rho's stdout (JSON-RPC notifications) ─────────────────────────────────

async function readRhoOutput() {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of childStdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleRhoMessage(msg);
      } catch {
        console.error("[parse error]", line);
      }
    }
  }
}

// ── Read user input from terminal ───────────────────────────────────────────────

async function readUserInput() {
  await readyPromise;

  const buf = new Uint8Array(1024);

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break; // EOF (Ctrl+D)
    const line = new TextDecoder().decode(buf.subarray(0, n)).trim();
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (trimmed === "/quit" || trimmed === "/q") {
      child.kill("SIGTERM");
      break;
    }

    if (trimmed === "/abort") {
      sendRequest("abort");
      continue;
    }

    // Route to approval handler if rho is waiting for one
    if (resolveApproval) {
      const approved = trimmed === "y" || trimmed === "yes";
      resolveApproval(approved);
      continue;
    }

    sendRequest("prompt", { message: trimmed });
  }
}

// ── Run both loops concurrently ────────────────────────────────────────────────

await Promise.all([readRhoOutput(), readUserInput()]);
