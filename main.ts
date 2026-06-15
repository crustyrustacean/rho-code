// rho-code — frontend for the rho-coding-agent
// Spawns rho in headless JSON-RPC mode, provides an interactive REPL

// Deno.stdin.readable gives a ReadableStream of Uint8Array chunks

const RHO_BIN = "rho";

// ── State ──────────────────────────────────────────────────────────────────────

let resolveApproval: ((approved: boolean) => void) | null = null;
let readyResolve!: () => void;
const readyPromise = new Promise<void>((r) => {
  readyResolve = r;
});

// ── Spawn rho ──────────────────────────────────────────────────────────────────

const command = new Deno.Command(RHO_BIN, {
  args: ["--ephemeral", "--accept-external-provider"],
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

// ── Handle JSON-RPC message from rho ──────────────────────────────────────────

function handleRhoMessage(msg: Record<string, unknown>) {
  // JSON-RPC responses have "id"
  if (msg.id) {
    if (msg.error) {
      console.error(`[error] ${JSON.stringify(msg.error)}`);
    }
    return;
  }

  // JSON-RPC notifications have "method" (no "id")
  const method = msg.method as string;
  const params = msg.params as Record<string, unknown>;

  switch (method) {
    case "ready":
      console.log("rho is ready. Type a message or /quit to exit.\n");
      process.stdout.write("> ");
      readyResolve();
      break;

    case "state/change":
      if (params.state === "idle") {
        process.stdout.write("\n");
      }
      break;

    case "message/delta":
      process.stdout.write(params.delta as string);
      break;

    case "reasoning/delta":
      process.stdout.write(`\x1b[2m${params.delta}\x1b[0m`);
      break;

    case "tool/call":
      console.log(`\n\x1b[33m→ ${params.name}\x1b[0m`);
      break;

    case "tool/result":
      console.log(
        `\x1b[33m  ↳ ${params.is_error ? "✗ error" : "✓ ok"}\x1b[0m`,
      );
      break;

    case "tool/denied":
      console.log(`\x1b[33m  ↳ denied\x1b[0m`);
      break;

    case "approval/request":
      console.log(`\n\x1b[31m⚠ Approval needed: ${params.tool}\x1b[0m`);
      console.log(`  Arguments: ${params.arguments}`);
      console.log(`  Risk: ${params.risk}`);
      process.stdout.write("  Approve? [y/n] ");
      resolveApproval = (approved: boolean) => {
        sendRequest("approvalResponse", { approved });
        resolveApproval = null;
      };
      break;

    case "agent/start":
      break;

    case "agent/end": {
      const dur = params.durationMs;
      const iters = params.iterations;
      console.log(`\n\x1b[2m(${dur}ms, ${iters} iterations)\x1b[0m`);
      process.stdout.write("> ");
      break;
    }

    case "agent/error":
      console.error(`\n\x1b[31m[error] ${params.error}\x1b[0m`);
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
