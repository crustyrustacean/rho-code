// The TUI event loop: owns the screen, input editor, and scrollback, and wires
// them to rho. Two concurrent loops — terminal keystrokes and rho's JSON-RPC
// stdout — mutate shared state and trigger a re-render. The pure pieces
// (InputEditor, Scrollback, parseKey, markdown) are unit-tested elsewhere; this
// module is the thin glue that composes them.
//
// console.log/error are redirected to the scrollback so the existing slash-
// command handlers (which log their results) stay TUI-safe instead of
// clobbering the rendered screen.

import { cyan, dim, gray, green, red, reset, yellow, bold } from "../ansi.ts";
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

/** Run the TUI until the user exits or rho dies. Requires a real terminal. */
export async function runTui(): Promise<void> {
  if (!Deno.stdin.isTerminal()) {
    console.error(`${red}rho-code's TUI requires an interactive terminal.${reset}`);
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
  contextPct = "";
  reasoningBuf = "";
  reasoningActive = false;
  lastToolLine = "";
  pasteBuf: string[] = [];
  exited = false;

  // Per-turn metrics shown live in the footer. Reset on agent/start.
  turnIters = 0;
  turnTools = 0;
  turnCost = 0;
  turnStart = 0; // Date.now() at agent/start; 0 when no turn is active
  turnDuration: number | null = null; // authoritative ms from agent/end

  push(line: string): void {
    this.scrollback.push(line);
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  render(): void {
    const { rows, cols } = this.screen.size();
    const outputHeight = Math.max(1, rows - 3);
    this.scrollback.viewportHeight = outputHeight;
    const { view, col } = inputView(this.editor.text, this.editor.cursor, cols);
    this.screen.render({
      header: this.header(),
      lines: this.scrollback.visible(outputHeight, cols),
      footerStats: this.footerStats(),
      input: view,
      inputCol: col,
    });
  }

  /** Sticky header line: how to use rho-code. */
  header(): string {
    return `${bold}rho-code${reset} ${gray}— type to chat; while rho works, input steers · /help · Ctrl-C quit · PgUp/PgDn scroll${reset}`;
  }

  /** Footer: model · busy/ready · iters · tools · time · ctx% · cost. */
  footerStats(): string {
    if (inPasteMode) {
      return `${dim}paste mode — type lines, a lone . to send, Esc to cancel${reset}`;
    }
    const sep = ` ${gray}·${reset} `;
    const parts: string[] = [];
    parts.push(`${cyan}${currentModel}${reset}`);
    parts.push(turnInProgress ? `${yellow}working${reset}` : `${green}ready${reset}`);
    if (this.turnIters > 0) parts.push(`${this.turnIters}i`);
    if (this.turnTools > 0) parts.push(`${this.turnTools}t`);
    parts.push(this.elapsedLabel());
    if (this.contextPct) parts.push(`${this.contextPct}%`);
    parts.push(this.costLabel());
    return parts.join(sep);
  }

  /** Elapsed time for the current/last turn (live while a turn runs). */
  elapsedLabel(): string {
    const ms = this.turnDuration ?? (this.turnStart ? Date.now() - this.turnStart : 0);
    return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  /** Per-turn cost, or an em dash before any pricing arrives. */
  costLabel(): string {
    return this.turnCost > 0 ? `$${this.turnCost.toFixed(4)}` : `${gray}—${reset}`;
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
      this.scrollback.viewportHeight = Math.max(1, rows - 2);
      if (key.dir === "up") this.scrollback.scrollUp(rows - 2);
      else this.scrollback.scrollDown(rows - 2);
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
          this.push(`${red}unknown command: ${cmd}${reset} ${gray}(try /help)${reset}`);
        }
      } catch (e) {
        const msg = (e as { message?: string })?.message ?? String(e);
        this.push(`${red}error${reset}: ${msg}`);
      }
      return;
    }

    this.sendPrompt(text);
  }

  /** Send a prompt, steering the active turn if one is in progress. */
  sendPrompt(message: string): void {
    sendRequest("prompt", buildPromptParams(message, turnInProgress));
    if (turnInProgress) {
      this.push(`${dim}↳ steering the current turn…${reset}`);
    }
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
      if (msg.error) this.push(`${red}[error]${reset} ${JSON.stringify(msg.error)}`);
      return;
    }
    const method = msg.method as string;
    const params = (msg.params as Record<string, unknown>) ?? {};
    switch (method) {
      case "ready":
        this.onReady();
        break;

      case "agent/start":
        this.startTurn();
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
        this.turnTools += 1;
        const name = params.name as string;
        const args = formatToolArgs(params.arguments as string);
        this.lastToolLine =
          `${yellow}●${reset} ${bold}${name}${reset} ${gray}${args}${reset}`;
        this.push(this.lastToolLine);
        break;
      }

      case "tool/result": {
        const isError = params.is_error as boolean;
        const marker = isError ? ` ${red}✗${reset}` : ` ${gray}✓${reset}`;
        this.scrollback.replaceLast(this.lastToolLine + marker);
        break;
      }

      case "tool/denied":
        this.scrollback.replaceLast(this.lastToolLine + ` ${yellow}blocked${reset}`);
        break;

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

  /** On `ready`: fetch the active model for the footer, resolve readiness. */
  onReady(): void {
    requestResponse("getState").then((state) => {
      const s = state as { model: string };
      setCurrentModel(s.model);
      readyResolve();
      this.render();
    }).catch(() => {
      readyResolve(); // model stays blank; not fatal
    });
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
    const riskColor = risk === "destructive" ? red : risk === "network" ? yellow : gray;
    this.push(
      `${red}⚠${reset} ${bold}Approval required${reset} ${riskColor}[${risk}]${reset}`,
    );
    this.push(
      `  ${cyan}${params.tool}${reset} ${gray}${formatToolArgs(params.arguments as string)}${reset}`,
    );
    this.push(`${dim}  [y] allow · [n] deny · or type a redirect message${reset}`);
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

  /** On `usage`: track iteration count + per-iteration cost + context %. */
  onUsage(params: Record<string, unknown>): void {
    const iter = params.iteration as number | undefined;
    if (typeof iter === "number") this.turnIters = Math.max(this.turnIters, iter);
    const u = params.usage as { cost?: number } | undefined;
    if (u && typeof u.cost === "number" && u.cost > 0) this.turnCost += u.cost;
    const c = params.context as { utilizationPercent?: number } | undefined;
    if (c && typeof c.utilizationPercent === "number") {
      this.contextPct = String(c.utilizationPercent);
    }
  }

  /** On `agent/start`: reset the per-turn footer metrics. */
  startTurn(): void {
    this.turnIters = 0;
    this.turnTools = 0;
    this.turnCost = 0;
    this.turnStart = Date.now();
    this.turnDuration = null;
  }

  /** On `agent/end`: finalize the footer's per-turn metrics + context %. */
  async onAgentEnd(params: Record<string, unknown>): Promise<void> {
    flushMarkdownBuffer();
    this.turnIters = (params.iterations as number) ?? this.turnIters;
    const toolCalls = params.toolCalls as Array<{ name: string }> | undefined;
    if (toolCalls) this.turnTools = toolCalls.length;
    this.turnDuration = (params.durationMs as number) ?? null;
    this.turnStart = 0; // freeze the live elapsed display
    try {
      const stats = await requestResponse("getSessionStats") as { utilizationPercent: number };
      if (typeof stats.utilizationPercent === "number") {
        this.contextPct = String(stats.utilizationPercent);
      }
    } catch {
      // Stats are best-effort; the footer keeps its running values.
    }
    this.render();
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
