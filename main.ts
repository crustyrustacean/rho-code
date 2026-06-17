// rho-code — frontend for the rho-coding-agent
// Spawns rho in headless JSON-RPC mode, provides an interactive REPL

const RHO_BIN = "rho";
const continueSession = Deno.args.includes("-c");

// ── ANSI helpers ─────────────────────────────────────────────────────────────────

const dim = "\x1b[2m";
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const yellow = "\x1b[33m";
const red = "\x1b[31m";
const cyan = "\x1b[36m";
const gray = "\x1b[90m";
const green = "\x1b[32m";
const italic = "\x1b[3m";
const underline = "\x1b[4m";
const codeBg = "\x1b[48;5;236m";
const codeFg = "\x1b[38;5;252m";

// ── State ──────────────────────────────────────────────────────────────────────

let resolveApproval: ((approved: boolean) => void) | null = null;
let readyResolve!: () => void;
const readyPromise = new Promise<void>((r) => {
  readyResolve = r;
});
let inReasoning = false;
let currentModel = "";
let currentProvider = "";

// ── Markdown streaming formatter ────────────────────────────────────────────
// Buffers partial lines and applies ANSI formatting to complete lines as
// they arrive via message/delta. Handles headers, bold, italic, inline code,
// and fenced code blocks.

let lineBuffer = "";
let inCodeBlock = false;

const RE_CODE_BLOCK = /^\s{0,3}```/;
const RE_INLINE_CODE = /\x60([^\x60]+)\x60/g;
const RE_BOLD = /\*\*([^*]+)\*\*/g;
const RE_ITALIC = /(?<!\*)\*([^*]+)\*(?!\*)/g;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;

function flushFormattedLine(line: string) {
  if (inCodeBlock) {
    if (RE_CODE_BLOCK.test(line)) {
      inCodeBlock = false;
      process.stdout.write(reset + "\n");
    } else {
      process.stdout.write(codeBg + codeFg + line + reset + "\n");
    }
    return;
  }

  if (RE_CODE_BLOCK.test(line)) {
    inCodeBlock = true;
    return;
  }

  if (line === "") {
    process.stdout.write("\n");
    return;
  }

  const headingMatch = line.match(RE_HEADING);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    const text = headingMatch[2]!;
    if (level === 1) process.stdout.write(bold + cyan + text + reset + "\n");
    else if (level === 2) process.stdout.write(bold + underline + text + reset + "\n");
    else process.stdout.write(bold + text + reset + "\n");
    return;
  }

  let formatted = line;
  formatted = formatted.replace(RE_INLINE_CODE, (_m, p1) => codeBg + codeFg + p1 + reset);
  formatted = formatted.replace(RE_BOLD, (_m, p1) => bold + p1 + reset);
  formatted = formatted.replace(RE_ITALIC, (_m, p1) => italic + p1 + reset);
  process.stdout.write(formatted + "\n");
}

function writeMarkdownChunk(delta: string) {
  lineBuffer += delta;
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    flushFormattedLine(line);
  }
}

function flushMarkdownBuffer() {
  if (lineBuffer.length > 0) {
    flushFormattedLine(lineBuffer);
    lineBuffer = "";
  }
  if (inCodeBlock) {
    inCodeBlock = false;
    process.stdout.write(reset + "\n");
  }
}

// ── Spawn rho ──────────────────────────────────────────────────────────────────

const command = new Deno.Command(RHO_BIN, {
  args: ["--accept-external-provider", ...(continueSession ? ["--continue"] : [])],
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

// Pending request-response callbacks, keyed by JSON-RPC id. The callback
// receives the full response object so it can distinguish a success
// `result` from an `error` and reject the promise accordingly.
const pendingRequests = new Map<string, (msg: Record<string, unknown>) => void>();

function sendRequest(method: string, params: Record<string, unknown> = {}): string {
  const id = crypto.randomUUID();
  const message = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  const writer = childStdin.getWriter();
  writer.write(new TextEncoder().encode(message + "\n"));
  writer.releaseLock();
  return id;
}

function requestResponse(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = sendRequest(method, params);
    pendingRequests.set(id, (msg) => {
      if (msg.error) {
        reject(msg.error);
      } else {
        resolve(msg.result);
      }
    });
  });
}

// ── Format tool arguments for display ──────────────────────────────────────────

function formatToolArgs(args: string): string {
  try {
    const parsed = JSON.parse(args);
    if (parsed.path && Object.keys(parsed).length === 1) return parsed.path;
    if (parsed.path && Array.isArray(parsed.edits)) {
      return `${parsed.path} (${parsed.edits.length} edit${parsed.edits.length !== 1 ? "s" : ""})`;
    }
    if (parsed.command) {
      const cmd = parsed.command.length > 60 ? parsed.command.slice(0, 57) + "..." : parsed.command;
      return cmd;
    }
    if (parsed.pattern) return `/${parsed.pattern}/`;
    return Object.entries(parsed)
      .filter(([k]) => k !== "path")
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  } catch {
    return args.length > 80 ? args.slice(0, 77) + "..." : args;
  }
}

// ── Handle JSON-RPC message from rho ──────────────────────────────────────

function handleRhoMessage(msg: Record<string, unknown>) {
  if (msg.id) {
    if (msg.error) console.error(`${red}[error]${reset} ${JSON.stringify(msg.error)}`);
    return;
  }

  const method = msg.method as string;
  const params = msg.params as Record<string, unknown>;

  switch (method) {
    case "ready":
      // Fetch model/provider state before showing the banner.
      requestResponse("getState").then((state) => {
        const s = state as { model: string; provider: string; cwd: string };
        currentModel = s.model;
        currentProvider = s.provider;
        console.log(`\n${bold}rho-code${reset} — interactive frontend for rho-coding-agent`);
        console.log(`${gray}Type a message, /quit to exit, /abort to cancel.${reset}`);
        console.log(`${gray}Commands: /model, /models, /providers, /compact, /reload, /abort${reset}`);
        console.log(
          `${cyan}${s.model}${reset} ${gray}(${s.provider || "default provider"})${reset}`,
        );
        console.log(`${dim}${s.cwd}${reset}\n`);
        process.stdout.write("> ");
        readyResolve();
      }).catch((e) => {
        console.error(`${red}[error]${reset} failed to fetch state: ${JSON.stringify(e)}`);
        readyResolve();
      });
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
      if (inReasoning) {
        inReasoning = false;
        process.stdout.write(`${reset}\n\n`);
      }
      writeMarkdownChunk(params.delta as string);
      break;

    case "reasoning/delta":
      flushMarkdownBuffer();
      if (!inReasoning) {
        inReasoning = true;
        process.stdout.write(`${gray}┌ thinking${reset}\n${dim}`);
      }
      process.stdout.write(params.delta as string);
      break;

    case "tool/call": {
      flushMarkdownBuffer();
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
      process.stdout.write(isError ? ` ${red}✗${reset}\n` : ` ${gray}✓${reset}\n`);
      break;
    }

    case "tool/denied":
      process.stdout.write(` ${yellow}blocked${reset}\n`);
      break;

    case "approval/request": {
      const risk = params.risk as string;
      const riskColor = risk === "destructive" ? red : risk === "network" ? yellow : gray;
      console.log(`\n${red}⚠${reset} ${bold}Approval required${reset} ${riskColor}[${risk}]${reset}`);
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
      flushMarkdownBuffer();
      const dur = params.durationMs as number;
      const iters = params.iterations as number;
      const toolCalls = params.toolCalls as Array<{ name: string; outcome: { kind: string } }>;

      const parts: string[] = [];
      parts.push(`${cyan}${currentModel}${reset}`);
      if (iters > 1) parts.push(`${iters} iterations`);
      if (toolCalls && toolCalls.length > 0) {
        parts.push(`${toolCalls.length} tool call${toolCalls.length !== 1 ? "s" : ""}`);
      }
      parts.push(dur > 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`);

      requestResponse("getSessionStats").then((stats) => {
        const s = stats as {
          contextWindow: number;
          estimatedUsed: number;
          estimatedRemaining: number;
          utilizationPercent: number;
          apiUsage: { totalCost: number; totalTokens: number; requestCount: number };
        };
        parts.push(`${Math.round(s.estimatedUsed / 1000)}k/${Math.round(s.contextWindow / 1000)}k ctx (${s.utilizationPercent}%)`);
        if (s.apiUsage?.totalCost > 0) parts.push(`$${s.apiUsage.totalCost.toFixed(4)}`);
        process.stdout.write(`\n${gray}─── ${parts.join(" · ")} ───${reset}\n`);
        process.stdout.write("> ");
      }).catch((e) => {
        process.stdout.write(`\n${gray}─── ${parts.join(" · ")} ───${reset}\n`);
        process.stdout.write("> ");
        console.error(`${red}[error]${reset} failed to fetch session stats: ${JSON.stringify(e)}`);
      });
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

// ── Slash commands ──────────────────────────────────────────────────────────

async function cmdModel(args: string) {
  if (!args) {
    // Show current model
    const state = await requestResponse("getState") as { model: string; provider: string };
    console.log(`${cyan}${state.model}${reset} ${gray}(provider: ${state.provider || "default"})${reset}`);
    return;
  }

  // Switch model. The backend rejects unknown models/providers with a
  // JSON-RPC error (see `App::set_model`); surface that as a failed switch
  // instead of falsely reporting success.
  try {
    const result = await requestResponse("setModel", { model: args }) as { model: string; provider: string };
    currentModel = result.model;
    currentProvider = result.provider;
    console.log(`${green}switched${reset} to ${cyan}${result.model}${reset} ${gray}(provider: ${result.provider || "default"})${reset}`);
  } catch (e) {
    const message = (e as { message?: string })?.message ?? JSON.stringify(e);
    console.log(`${red}not switched${reset}: ${message}`);
    console.log(`${gray}(model left unchanged)${reset}`);
  }
}

async function cmdModels() {
  const result = await requestResponse("listModels") as { models: Array<{ id: string; provider: string }> };
  if (result.models.length === 0) {
    console.log(`${gray}no models discovered (providers may not support /v1/models)${reset}`);
    return;
  }
  // Group by provider
  const byProvider = new Map<string, string[]>();
  for (const m of result.models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m.id);
    byProvider.set(m.provider, list);
  }
  for (const [provider, models] of byProvider) {
    console.log(`\n${bold}${provider}${reset}`);
    for (const id of models) {
      const marker = id === currentModel ? `${green}●${reset} ` : "  ";
      console.log(`  ${marker}${id}`);
    }
  }
  console.log("");
}

async function cmdProviders() {
  const result = await requestResponse("listProviders") as {
    providers: Array<{ name: string; isExternal: boolean; reachable: boolean; active: boolean }>;
  };
  if (result.providers.length === 0) {
    console.log(`${gray}no providers configured${reset}`);
    return;
  }
  for (const p of result.providers) {
    const active = p.active ? `${green}●${reset} ` : "  ";
    const external = p.isExternal ? `${yellow}external${reset}` : `${dim}local${reset}`;
    const reachable = p.reachable ? `${green}reachable${reset}` : `${red}unreachable${reset}`;
    console.log(`  ${active}${bold}${p.name}${reset} ${gray}${external} · ${reachable}${reset}`);
  }
  console.log("");
}

function printHelp() {
  console.log(`
${bold}Commands${reset}
  ${cyan}/model${reset} [${italic}id${reset}]     Show or switch the active model
  ${cyan}/models${reset}            List models from all providers
  ${cyan}/providers${reset}         List configured providers
  ${cyan}/compact${reset}           Compact conversation context
  ${cyan}/reload${reset}             Reload extensions
  ${cyan}/abort${reset}             Cancel the current agent turn
  ${cyan}/quit${reset}              Exit rho-code
`);
}

async function cmdReload() {
  const result = await requestResponse("reloadExtensions") as { success: boolean; message?: string };
  if (result.success) {
    console.log(`${green}extensions reloaded${reset}`);
  } else {
    console.log(`${red}reload failed${reset}: ${result.message || 'unknown error'}`);
  }
}

// ── Read rho's stdout (JSON-RPC notifications) ─────────────────────────────

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
        if (msg.id && pendingRequests.has(msg.id)) {
          pendingRequests.get(msg.id)!(msg);
          pendingRequests.delete(msg.id);
          continue;
        }
        handleRhoMessage(msg);
      } catch {
        console.error("[parse error]", line);
      }
    }
  }
}

// ── Read user input from terminal ───────────────────────────────────────────

async function readUserInput() {
  await readyPromise;

  const buf = new Uint8Array(1024);

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    const line = new TextDecoder().decode(buf.subarray(0, n)).trim();

    if (!line) continue;

    if (line === "/quit" || line === "/q") {
      child.kill("SIGTERM");
      break;
    }

    if (line === "/abort") {
      sendRequest("abort");
      continue;
    }

    if (resolveApproval) {
      const approved = line === "y" || line === "yes";
      resolveApproval(approved);
      continue;
    }

    // ── Slash commands ────────────────────────────────────────────────
    if (line.startsWith("/")) {
      const spaceIdx = line.indexOf(" ");
      const cmd = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();

      try {
        switch (cmd) {
          case "/model":
            await cmdModel(args);
            break;
          case "/models":
            await cmdModels();
            break;
          case "/providers":
            await cmdProviders();
            break;
          case "/compact":
            sendRequest("compact");
            console.log(`${gray}compaction requested${reset}`);
            break;
          case "/reload":
            await cmdReload();
            break;
          case "/help":
            printHelp();
            break;
          default:
            console.log(`${red}unknown command: ${cmd}${reset}  type ${cyan}/help${reset} for available commands`);
        }
      } catch (e) {
        // A rejected `requestResponse` (JSON-RPC error) from any command.
        const message = (e as { message?: string })?.message ?? JSON.stringify(e);
        console.log(`${red}error${reset}: ${message}`);
      }
      process.stdout.write("> ");
      continue;
    }

    sendRequest("prompt", { message: line });
  }
}

// ── Run both loops concurrently ────────────────────────────────────────────

await Promise.all([readRhoOutput(), readUserInput()]);
