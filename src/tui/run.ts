// The TUI event loop: owns the screen, input editor, and scrollback, and wires
// them to rho. Two concurrent loops — terminal keystrokes and rho's JSON-RPC
// stdout — mutate shared state and trigger a re-render. The pure pieces
// (InputEditor, Scrollback, parseKey, markdown) are unit-tested elsewhere; this
// module is the thin glue that composes them.
//
// console.log/error are redirected to the scrollback so the existing slash-
// command handlers (which log their results) stay TUI-safe instead of
// clobbering the rendered screen.

import {
  bgToolError,
  bgToolPending,
  bgToolSuccess,
  bgUser,
  bold,
  cyan,
  dim,
  gray,
  green,
  red,
  reset,
  yellow,
} from "../ansi.ts";
import { buildPromptParams } from "../prompt.ts";
import {
  dispatchResponse,
  getChild,
  getChildStdout,
  requestResponse,
  sendRequest,
} from "../rpc.ts";
import { dispatchCommand } from "../commands.ts";
import { formatToolArgs } from "../format.ts";
import {
  flushMarkdownBuffer,
  setMarkdownSink,
  writeMarkdownChunk,
} from "../markdown.ts";
import {
  currentModel,
  inPasteMode,
  readyResolve,
  resolveApproval,
  setCurrentModel,
  setInPasteMode,
  setResolveApproval,
  setTurnInProgress,
  turnInProgress,
} from "../state.ts";
import type { Key } from "./key.ts";
import { InputEditor, inputView } from "./input.ts";
import { parseKey } from "./key.ts";
import { Scrollback } from "./scrollback.ts";
import { Screen } from "./screen.ts";
import { blockLines } from "./block.ts";
import { buildFooter } from "./footer.ts";

/** Run the TUI until the user exits or rho dies. Requires a real terminal. */
export async function runTui(): Promise<void> {
  if (!Deno.stdin.isTerminal()) {
    console.error(
      `${red}rho-code's TUI requires an interactive terminal.${reset}`,
    );
    return;
  }

  const tui = new Tui();
  // Route markdown + console output into the scrollback (one finished line each).
  setMarkdownSink((line) => tui.scrollback.push(line));
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => tui.scrollback.push(args.join(" "));
  console.error = (...args: unknown[]) =>
    tui.scrollback.push(red + args.join(" ") + reset);

  // Re-render every 500ms while a turn runs so the footer's elapsed time ticks.
  const tick = setInterval(() => {
    if (turnInProgress) tui.render();
  }, 500);
  try {
    tui.screen.enter();
    tui.render();
    await Promise.all([tui.outputLoop(), tui.inputLoop()]);
  } finally {
    clearInterval(tick);
    tui.exit();
    console.log = origLog;
    console.error = origErr;
  }
}

/** All mutable TUI state and the loops that drive it. */
class Tui {
  screen = new Screen();
  scrollback = new Scrollback();
  editor = new InputEditor();

  // Streaming/rendering scratch state.
  contextPct: number | undefined;
  contextWindow = 0;
  reasoningBuf = "";
  reasoningActive = false;
  toolBlockLines = 0; // lines in the live tool block, for replaceLastN repaints
  lastToolName = "";
  lastToolArgs = "";
  pasteBuf: string[] = [];
  exited = false;

  // Cumulative session token usage (accumulated from `usage` notifications).
  cumInput = 0;
  cumOutput = 0;
  cumCached = 0;
  sessionCost = 0;

  // Footer chrome: working directory and git branch, refreshed on ready.
  cwd = "";
  gitBranch: string | undefined;

  push(line: string): void {
    this.scrollback.push(line);
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  render(): void {
    const { rows, cols } = this.screen.size();
    const footerLines = this.footerLines(cols);
    const outputHeight = Math.max(1, rows - footerLines.length - 1);
    this.scrollback.viewportHeight = outputHeight;
    const { view, col } = inputView(this.editor.text, this.editor.cursor, cols);
    this.screen.render({
      lines: this.scrollback.visible(outputHeight, cols),
      footerLines,
      input: view,
      inputCol: col,
    });
  }

  /** Build the footer rows for the current state at `cols` width. */
  footerLines(cols: number): string[] {
    return buildFooter({
      cwd: this.cwd || safeCwd(),
      home: safeEnv("HOME") ?? safeEnv("USERPROFILE"),
      gitBranch: this.gitBranch,
      sessionName: undefined,
      inputTokens: this.cumInput,
      outputTokens: this.cumOutput,
      cachedTokens: this.cumCached,
      cost: this.sessionCost,
      contextPercent: this.contextPct,
      contextWindow: this.contextWindow,
      autoCompact: true,
      model: currentModel || "no-model",
      provider: undefined,
      showProvider: false,
      width: cols,
    });
  }

  // ── Input loop ────────────────────────────────────────────────────────

  async inputLoop(): Promise<void> {
    let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    for await (const chunk of Deno.stdin.readable) {
      if (this.exited) break;
      buf = concat(buf, chunk);
      let parsed = parseKey(buf);
      while (parsed) {
        buf = buf.subarray(parsed.consumed);
        await this.onKey(parsed.key);
        if (this.exited) return;
        parsed = parseKey(buf);
      }
    }
  }

  /** Handle one decoded keystroke. */
  async onKey(key: Key): Promise<void> {
    if (key.kind === "ctrl" && key.char === "c") {
      this.exit();
      return;
    }
    // Esc cancels paste mode.
    if (key.kind === "escape" && inPasteMode) {
      setInPasteMode(false);
      this.pasteBuf = [];
      this.render();
      return;
    }
    // Scrolling (PageUp/PageDn).
    if (key.kind === "page") {
      const { rows } = this.screen.size();
      this.scrollback.viewportHeight = Math.max(1, rows - 3);
      if (key.dir === "up") this.scrollback.scrollUp(rows - 3);
      else this.scrollback.scrollDown(rows - 3);
      this.render();
      return;
    }

    const result = this.editor.handle(key);
    if (result.submitted !== null) {
      this.scrollback.scrollToBottom();
      await this.onSubmit(result.submitted);
    }
    this.render();
  }

  /** Route a submitted input line to approval / paste / command / prompt. */
  async onSubmit(text: string): Promise<void> {
    // Approval mode: y/yes → allow, n/no → deny, anything else → redirect.
    if (resolveApproval) {
      const lower = text.toLowerCase();
      if (lower === "y" || lower === "yes") resolveApproval(true);
      else if (lower === "n" || lower === "no") resolveApproval(null);
      else resolveApproval(text);
      return;
    }

    if (inPasteMode) {
      if (text.trim() === ".") {
        const body = this.pasteBuf.join("\n");
        this.pasteBuf = [];
        setInPasteMode(false);
        if (body.trim()) this.sendPrompt(body);
      } else {
        this.pasteBuf.push(text);
      }
      return;
    }

    if (text.startsWith("/")) {
      const space = text.indexOf(" ");
      const cmd = space === -1 ? text : text.slice(0, space);
      const args = space === -1 ? "" : text.slice(space + 1).trim();
      try {
        const found = await dispatchCommand(cmd, args);
        if (!found) {
          this.push(
            `${red}unknown command: ${cmd}${reset} ${gray}(try /help)${reset}`,
          );
        }
      } catch (e) {
        const msg = (e as { message?: string })?.message ?? String(e);
        this.push(`${red}error${reset}: ${msg}`);
      }
      return;
    }

    this.sendPrompt(text);
  }

  /** Send a prompt, echoing it as a highlighted user block, and steering the
   * active turn if one is in progress. */
  sendPrompt(message: string): void {
    this.echoUser(message);
    sendRequest("prompt", buildPromptParams(message, turnInProgress));
    if (turnInProgress) {
      this.push(`${dim}↳ steering the current turn…${reset}`);
    }
  }

  /** Echo a submitted user message as a full-width highlighted block (pi-style). */
  echoUser(message: string): void {
    const cols = this.screen.size().cols;
    for (const line of blockLines(message, cols, bgUser, 1)) this.push(line);
  }

  // ── Output loop (rho → screen) ────────────────────────────────────────

  async outputLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const stdout = getChildStdout();
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (dispatchResponse(msg)) continue;
          this.handleNotification(msg);
          this.render();
        } catch {
          this.push(`${red}[parse error]${reset} ${line}`);
          this.render();
        }
      }
    }
    // rho's stdout closed — the agent process exited.
    if (!this.exited) {
      this.push(`${gray}rho exited.${reset}`);
      this.exit();
    }
  }

  /** Map a rho notification to scrollback lines + state changes. */
  handleNotification(msg: Record<string, unknown>): void {
    if (msg.id) {
      if (msg.error) {
        this.push(`${red}[error]${reset} ${JSON.stringify(msg.error)}`);
      }
      return;
    }
    const method = msg.method as string;
    const params = (msg.params as Record<string, unknown>) ?? {};
    switch (method) {
      case "ready":
        this.onReady();
        break;

      case "agent/start":
        setTurnInProgress(true);
        break;

      case "agent/end":
        setTurnInProgress(false);
        this.onAgentEnd(params);
        break;

      case "agent/error":
        setTurnInProgress(false);
        this.push(`${red}[error]${reset} ${params.error}`);
        break;

      case "state/change":
        if (params.state === "idle") this.finishReasoning();
        break;

      case "message/delta":
        this.finishReasoning();
        writeMarkdownChunk(params.delta as string);
        break;

      case "reasoning/delta":
        flushMarkdownBuffer();
        if (!this.reasoningActive) {
          this.reasoningActive = true;
          this.reasoningBuf = "";
          this.push(`${gray}┌ thinking${reset}`);
        }
        this.reasoningBuf += params.delta as string;
        this.scrollback.replaceLast(`${dim}${this.reasoningBuf}${reset}`);
        break;

      case "tool/call": {
        this.finishReasoning();
        flushMarkdownBuffer();
        const name = params.name as string;
        const args = formatToolArgs(params.arguments as string);
        this.lastToolName = name;
        this.lastToolArgs = args;
        const cols = this.screen.size().cols;
        const lines = this.renderToolBlock(
          bgToolPending,
          name,
          args,
          { status: `${yellow}●${reset} ${dim}running${reset}` },
          cols,
        );
        for (const line of lines) this.push(line);
        this.toolBlockLines = lines.length;
        break;
      }

      case "tool/result": {
        const isError = params.is_error as boolean;
        const output = this.formatToolOutput(params.output as string ?? "");
        const bg = isError ? bgToolError : bgToolSuccess;
        const status = isError
          ? `${red}✗ failed${reset}`
          : `${green}✓ done${reset}`;
        const cols = this.screen.size().cols;
        const lines = this.renderToolBlock(
          bg,
          this.lastToolName,
          this.lastToolArgs,
          { status, output },
          cols,
        );
        this.scrollback.replaceLastN(this.toolBlockLines, lines);
        this.toolBlockLines = lines.length;
        break;
      }

      case "tool/denied": {
        const cols = this.screen.size().cols;
        const lines = this.renderToolBlock(
          bgToolError,
          this.lastToolName,
          this.lastToolArgs,
          { status: `${yellow}⊘ blocked${reset}` },
          cols,
        );
        this.scrollback.replaceLastN(this.toolBlockLines, lines);
        this.toolBlockLines = lines.length;
        break;
      }

      case "approval/request":
        this.onApprovalRequest(params);
        break;

      case "usage":
        this.onUsage(params);
        break;

      default:
        this.push(`${gray}[unhandled notification: ${method}]${reset}`);
    }
  }

  /** On `ready`: fetch the active model + cwd, detect the git branch, show a
   * startup banner, and resolve readiness. */
  onReady(): void {
    requestResponse("getState").then((state) => {
      const s = state as { model: string; cwd?: string };
      setCurrentModel(s.model);
      this.cwd = s.cwd ?? "";
      this.pushStartupBanner();
      this.detectGitBranch(this.cwd || Deno.cwd()).then((branch) => {
        this.gitBranch = branch;
        this.render();
      });
      readyResolve();
      this.render();
    }).catch(() => {
      this.pushStartupBanner();
      readyResolve(); // model stays blank; not fatal
    });
  }

  /** One-time branded banner + hints, pushed to the scrollback on ready. */
  pushStartupBanner(): void {
    this.push(`${bold}rho-code${reset}`);
    this.push(
      `${dim}type to chat · while rho works, input steers · /help · Ctrl-C quit · PgUp/PgDn scroll${reset}`,
    );
    this.push("");
  }

  /** Best-effort `git … –abbrev-ref HEAD` for the footer pwd line. */
  async detectGitBranch(cwd: string): Promise<string | undefined> {
    try {
      const cmd = new Deno.Command("git", {
        args: ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
        stdout: "piped",
        stderr: "null",
      });
      const { stdout, success } = await cmd.output();
      if (!success) return undefined;
      const branch = new TextDecoder().decode(stdout).trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }

  /** On `agent/end`: flush trailing markdown and refresh the context snapshot
   * for the footer (per-iteration usage already accrued via `usage`). */
  async onAgentEnd(_params: Record<string, unknown>): Promise<void> {
    flushMarkdownBuffer();
    try {
      const stats = await requestResponse("getSessionStats") as {
        utilizationPercent?: number;
        contextWindow?: number;
      };
      if (typeof stats.utilizationPercent === "number") {
        this.contextPct = stats.utilizationPercent;
      }
      if (typeof stats.contextWindow === "number") {
        this.contextWindow = stats.contextWindow;
      }
    } catch {
      // Stats are best-effort; the footer keeps its running values.
    }
    this.render();
  }

  /** End a live reasoning line (leaves it in the scrollback as a record). */
  finishReasoning(): void {
    if (this.reasoningActive) {
      this.reasoningActive = false;
      this.reasoningBuf = "";
    }
  }

  /** On `approval/request`: prompt in the scrollback; input is captured on submit. */
  onApprovalRequest(params: Record<string, unknown>): void {
    flushMarkdownBuffer();
    const risk = params.risk as string;
    const riskColor = risk === "destructive"
      ? red
      : risk === "network"
      ? yellow
      : gray;
    this.push(
      `${red}⚠${reset} ${bold}Approval required${reset} ${riskColor}[${risk}]${reset}`,
    );
    this.push(
      `  ${cyan}${params.tool}${reset} ${gray}${
        formatToolArgs(params.arguments as string)
      }${reset}`,
    );
    this.push(
      `${dim}  [y] allow · [n] deny · or type a redirect message${reset}`,
    );
    setResolveApproval((decision: boolean | string | null) => {
      if (decision === true) {
        sendRequest("approvalResponse", { approved: true });
      } else if (typeof decision === "string" && decision.trim()) {
        sendRequest("approvalResponse", { approved: false, message: decision });
      } else {
        sendRequest("approvalResponse", { approved: false });
      }
      setResolveApproval(null);
    });
  }

  /** On `usage`: accumulate token/cost deltas + refresh the context snapshot. */
  onUsage(params: Record<string, unknown>): void {
    const u = params.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cached_tokens?: number;
      cost?: number;
    } | undefined;
    if (u) {
      if (typeof u.input_tokens === "number") this.cumInput += u.input_tokens;
      if (typeof u.output_tokens === "number") {
        this.cumOutput += u.output_tokens;
      }
      if (typeof u.cached_tokens === "number") {
        this.cumCached += u.cached_tokens;
      }
      if (typeof u.cost === "number") this.sessionCost += u.cost;
    }
    const c = params.context as {
      utilizationPercent?: number;
      contextWindow?: number;
    } | undefined;
    if (c) {
      if (typeof c.utilizationPercent === "number") {
        this.contextPct = c.utilizationPercent;
      }
      if (typeof c.contextWindow === "number") {
        this.contextWindow = c.contextWindow;
      }
    }
  }

  /** Render a tool block (a leading blank line + a bg-painted block). Pure
   * layout given the current `cols`; the caller pushes or replaceLastN-refs it. */
  renderToolBlock(
    bg: string,
    name: string,
    args: string,
    opts: { status?: string; output?: string },
    cols: number,
  ): string[] {
    const head = `${bold}${name}${reset}` +
      (args ? ` ${gray}${args}${reset}` : "") +
      (opts.status ? `  ${opts.status}` : "");
    const content = opts.output ? `${head}\n${opts.output}` : head;
    return ["", ...blockLines(content, cols, bg, 1)];
  }

  /** Trim and style a tool-result `output` string for the block body. */
  formatToolOutput(output: string, maxLines = 8): string {
    const raw = output.replace(/\s+$/, "");
    if (!raw) return "";
    const lines = raw.split("\n");
    const body = lines.slice(0, maxLines).map((l) => `${dim}${l}${reset}`).join(
      "\n",
    );
    if (lines.length > maxLines) {
      return `${body}\n${gray}… (${
        lines.length - maxLines
      } more lines)${reset}`;
    }
    return body;
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  /** Idempotent teardown: leave the screen, kill rho, unblock the input loop. */
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.screen.leave();
    try {
      getChild().kill("SIGTERM");
    } catch {
      // child may already be dead
    }
    try {
      Deno.stdin.close();
    } catch {
      // stdin may already be closed
    }
  }
}

/** Concatenate two byte buffers into a fresh allocation. */
function concat(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** `Deno.env.get` that yields undefined on a permission error (non-fatal). */
function safeEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** `Deno.cwd` that falls back to "" on a permission error (non-fatal). */
function safeCwd(): string {
  try {
    return Deno.cwd();
  } catch {
    return "";
  }
}
