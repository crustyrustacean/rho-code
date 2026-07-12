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
  bgSelected,
  bgToolError,
  bgToolPending,
  bgToolSuccess,
  bgUser,
  bold,
  cyan,
  dim,
  gray,
  green,
  italic,
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
import { parseKey, scrollDir } from "./key.ts";
import { Scrollback } from "./scrollback.ts";
import { Screen } from "./screen.ts";
import { blockLines } from "./block.ts";
import { buildFooter } from "./footer.ts";
import { SessionPicker } from "./picker.ts";
import { reasoningTailLines } from "./reasoning.ts";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "./spinner.ts";
import { padRight, truncateToWidth } from "./width.ts";

/** Maximum rows the input box may grow to before it scrolls internally. */
const MAX_INPUT_ROWS = 5;

/** Maximum wrapped rows of reasoning shown live while the model thinks. */
const REASONING_TAIL_ROWS = 6;

/** Tool-result output rows shown collapsed (default) vs expanded (Ctrl-O). */
const COLLAPSED_OUTPUT_LINES = 8;
const EXPANDED_OUTPUT_LINES = 200;

/** Mutable state of one tool block — tracked in the scrollback by `id` so it
 * can be repainted (result/denied) and expanded/collapsed (Ctrl-O) in place. */
interface ToolBlockState {
  id: number;
  name: string;
  args: string;
  status: "pending" | "done" | "blocked";
  error: boolean;
  fullOutput: string;
  expanded: boolean;
}

/** A previous session row, as returned by the `listSessions` RPC. */
interface SessionEntry {
  path: string;
  mtimeSecs: number;
  sizeKb: number;
  entryCount: number;
}

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

  // Re-render at the spinner cadence while a turn runs so the footer's
  // spinner animates and the elapsed time ticks.
  const tick = setInterval(() => {
    if (turnInProgress) tui.render();
  }, SPINNER_INTERVAL_MS);
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
  reasoningBlockLines = 0; // rows in the live thinking block, for replaceLastN
  reasoningStart = 0; // Date.now() at the first reasoning delta of a segment
  nextToolId = 1; // monotonic block id for each tool call
  lastTool: ToolBlockState | null = null; // most recent tool block (Ctrl-O target)
  // Session resume picker overlay (null when closed).
  picker: SessionPicker | null = null;
  pickerSessions: SessionEntry[] = [];
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
  // Date.now() at the start of the current turn; 0 when idle. Drives the
  // footer's elapsed-time + spinner while a turn runs.
  turnStart = 0;
  // Steers sent during the current turn (reset on agent/end). Shown in the
  // footer as a live `↻N` indicator while the turn processes them.
  steerCount = 0;

  push(line: string): void {
    this.scrollback.push(line);
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  render(): void {
    if (this.picker) {
      this.renderPicker();
      return;
    }
    const { rows, cols } = this.screen.size();
    const footerLines = this.footerLines(cols);
    const footerH = footerLines.length;
    const innerWidth = Math.max(1, cols - 4);
    // Cap the input box so it never crowds out the output region (reserve one
    // output row + the two border rows).
    const maxInputRows = Math.max(
      1,
      Math.min(MAX_INPUT_ROWS, rows - footerH - 3),
    );
    const view = inputView(
      this.editor.text,
      this.editor.cursor,
      innerWidth,
      maxInputRows,
    );
    const outputHeight = Math.max(1, rows - footerH - view.rows.length - 2);
    this.scrollback.viewportHeight = outputHeight;
    this.screen.render({
      lines: this.scrollback.visible(outputHeight, cols),
      footerLines,
      inputRows: view.rows,
      inputCursor: { row: view.cursorRow, col: view.cursorCol },
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
      working: turnInProgress && this.turnStart > 0,
      elapsedMs: this.turnStart ? Date.now() - this.turnStart : 0,
      spinner: turnInProgress && this.turnStart > 0
        ? spinnerFrame(Date.now())
        : undefined,
      steers: this.steerCount,
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
    // While the session picker is open, all other keys navigate it.
    if (this.picker) {
      await this.onPickerKey(key);
      return;
    }
    // Esc cancels paste mode.
    if (key.kind === "escape" && inPasteMode) {
      setInPasteMode(false);
      this.pasteBuf = [];
      this.render();
      return;
    }
    // Scrolling: PageUp/PageDn, plus Shift/Alt/Ctrl + Up/Down (macOS has no
    // dedicated PgUp/PgDn keys, so a modifier + arrow pages through history).
    const sdir = scrollDir(key);
    if (sdir) {
      const { rows } = this.screen.size();
      const page = Math.max(1, rows - 3);
      this.scrollback.viewportHeight = page;
      if (sdir === "up") this.scrollback.scrollUp(page);
      else this.scrollback.scrollDown(page);
      this.render();
      return;
    }
    // Ctrl-O expands/collapses the most recent tool block's output.
    if (key.kind === "ctrl" && key.char === "o") {
      this.toggleLastToolExpanded();
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
    // `/quit` (and aliases) always exit, even mid-approval or in paste mode.
    if (text === "/quit" || text === "/q" || text === "/exit") {
      this.exit();
      return;
    }

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
      // `/abort` cancels the in-progress turn (handled here, not in the
      // command registry, so it works without a live rho round-trip wrapper).
      if (cmd === "/abort") {
        sendRequest("abort");
        this.push(`${gray}abort requested${reset}`);
        return;
      }
      // `/resume` with no args opens the interactive session picker.
      if (cmd === "/resume" && !args) {
        await this.openSessionPicker();
        return;
      }
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

  /** Send a prompt. When idle the message is echoed as a highlighted user
   * block; when a turn is in progress it's sent as a steering nudge and shown
   * as a compact `↳ steer (N): …` line, with a live steer count in the footer. */
  sendPrompt(message: string): void {
    if (turnInProgress) {
      this.steerCount += 1;
      const cols = this.screen.size().cols;
      const firstLine = message.split("\n")[0] ?? "";
      const preview = truncateToWidth(firstLine, Math.max(10, cols - 18), "…");
      this.push(`${dim}↳ steer (${this.steerCount}): ${preview}${reset}`);
    } else {
      this.echoUser(message);
    }
    sendRequest("prompt", buildPromptParams(message, turnInProgress));
  }

  /** Echo a submitted user message as a full-width highlighted block (pi-style). */
  echoUser(message: string): void {
    const cols = this.screen.size().cols;
    for (const line of blockLines(message, cols, bgUser, 1)) this.push(line);
  }

  // ── Session resume picker ─────────────────────────────────────────────

  /** Open the interactive session picker (fetches `listSessions`). No-op
   * message if there are none. */
  async openSessionPicker(): Promise<void> {
    let result: { sessions: SessionEntry[] };
    try {
      result = await requestResponse("listSessions") as {
        sessions: SessionEntry[];
      };
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      this.push(`${red}failed to list sessions${reset}: ${msg}`);
      return;
    }
    const sessions = (result.sessions ?? []).slice().sort((a, b) =>
      b.mtimeSecs - a.mtimeSecs
    );
    if (sessions.length === 0) {
      this.push(`${gray}no previous sessions${reset}`);
      return;
    }
    this.pickerSessions = sessions;
    this.picker = new SessionPicker(
      sessions.map((s) => this.formatSessionRow(s)),
    );
    this.render();
  }

  /** Route a keystroke to the open picker; select resumes, escape closes. */
  async onPickerKey(key: Key): Promise<void> {
    const picker = this.picker!;
    const action = picker.handle(key);
    if (action === "select") {
      const entry = this.pickerSessions[picker.selected];
      this.closePicker();
      if (entry) await this.resumeSession(entry.path);
      return;
    }
    if (action === "cancel") {
      this.closePicker();
      return;
    }
    this.render();
  }

  /** Close the picker and repaint the chat underneath. */
  closePicker(): void {
    this.picker = null;
    this.render();
  }

  /** Resume a session by path, updating the footer model/cwd. */
  async resumeSession(path: string): Promise<void> {
    try {
      const result = await requestResponse("resumeSession", { path }) as {
        model: string;
        cwd?: string;
        entryCount: number;
      };
      setCurrentModel(result.model);
      if (result.cwd) this.cwd = result.cwd;
      this.push(
        `${green}resumed${reset} ${gray}${path} (${result.entryCount} entries, model: ${result.model})${reset}`,
      );
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      this.push(`${red}failed to resume${reset}: ${msg}`);
    }
  }

  /** Render the picker overlay (title · windowed list · hint). */
  renderPicker(): void {
    const { rows, cols } = this.screen.size();
    const picker = this.picker!;
    picker.viewportHeight = Math.max(1, rows - 4);
    const rows_text = picker.visible().map((v) => {
      const text = truncateToWidth(v.text, Math.max(1, cols - 2), "…");
      return v.selected
        ? `${bgSelected}${padRight(text, cols)}${reset}`
        : `${dim}${text}${reset}`;
    });
    this.screen.renderPicker({
      rows,
      cols,
      title: `${bold}Resume a session${reset} ${gray}(${picker.count})${reset}`,
      rows_text,
      hint:
        `${dim}↑↓ navigate · PgUp/PgDn page · enter resume · esc cancel${reset}`,
    });
  }

  /** One plain picker row: date · entries · size · filename. */
  formatSessionRow(s: SessionEntry): string {
    const date = new Date(s.mtimeSecs * 1000).toLocaleString();
    const name = s.path.split("/").pop() ?? s.path;
    return `${date}  ${s.entryCount} entries · ${s.sizeKb}KB  ${name}`;
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
        this.turnStart = Date.now();
        this.steerCount = 0;
        setTurnInProgress(true);
        break;

      case "agent/end":
        setTurnInProgress(false);
        this.onAgentEnd(params);
        break;

      case "agent/error":
        setTurnInProgress(false);
        this.turnStart = 0;
        this.push(`${red}[error]${reset} ${params.error}`);
        break;

      case "state/change":
        if (params.state === "idle") this.finishReasoning();
        break;

      case "message/delta":
        this.finishReasoning();
        writeMarkdownChunk(params.delta as string);
        break;

      case "reasoning/delta": {
        flushMarkdownBuffer();
        if (!this.reasoningActive) {
          this.reasoningActive = true;
          this.reasoningBuf = "";
          this.reasoningStart = Date.now();
        }
        this.reasoningBuf += params.delta as string;
        const cols = this.screen.size().cols;
        const block = [
          `${gray}${italic}✦ thinking${reset}`,
          ...reasoningTailLines(this.reasoningBuf, cols, REASONING_TAIL_ROWS),
        ];
        if (this.reasoningBlockLines === 0) {
          for (const line of block) this.push(line);
        } else {
          this.scrollback.replaceLastN(this.reasoningBlockLines, block);
        }
        this.reasoningBlockLines = block.length;
        break;
      }

      case "tool/call": {
        this.finishReasoning();
        flushMarkdownBuffer();
        const tool: ToolBlockState = {
          id: this.nextToolId++,
          name: params.name as string,
          args: formatToolArgs(params.arguments as string),
          status: "pending",
          error: false,
          fullOutput: "",
          expanded: false,
        };
        this.lastTool = tool;
        const cols = this.screen.size().cols;
        this.scrollback.pushBlock(
          tool.id,
          this.buildToolBlockLines(tool, cols),
        );
        break;
      }

      case "tool/result": {
        const isError = params.is_error as boolean;
        if (this.lastTool) {
          this.lastTool.status = "done";
          this.lastTool.error = isError;
          this.lastTool.fullOutput = params.output as string ?? "";
          this.lastTool.expanded = false;
          const cols = this.screen.size().cols;
          this.scrollback.replaceBlock(
            this.lastTool.id,
            this.buildToolBlockLines(this.lastTool, cols),
          );
        }
        break;
      }

      case "tool/denied": {
        if (this.lastTool) {
          this.lastTool.status = "blocked";
          this.lastTool.expanded = false;
          const cols = this.screen.size().cols;
          this.scrollback.replaceBlock(
            this.lastTool.id,
            this.buildToolBlockLines(this.lastTool, cols),
          );
        }
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
      `${dim}type to chat · Ctrl-J newline · Ctrl-O expand tool · /help · /quit or Ctrl-C · scroll: PgUp/PgDn or Shift/Alt+↑↓${reset}`,
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

  /** On `agent/end`: flush trailing markdown, freeze the turn clock, and
   * refresh the context snapshot for the footer. */
  async onAgentEnd(_params: Record<string, unknown>): Promise<void> {
    flushMarkdownBuffer();
    this.turnStart = 0; // stop the spinner / elapsed counter
    this.steerCount = 0; // steers processed — clear the indicator
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

  /** Collapse the live reasoning block into a one-line summary (leaves it in
   * the scrollback as a record). */
  finishReasoning(): void {
    if (!this.reasoningActive) return;
    this.reasoningActive = false;
    this.reasoningBuf = "";
    const secs = this.reasoningStart
      ? ((Date.now() - this.reasoningStart) / 1000).toFixed(1)
      : "";
    const summary = secs
      ? `${gray}✦ thought · ${secs}s${reset}`
      : `${gray}✦ thought${reset}`;
    this.scrollback.replaceLastN(this.reasoningBlockLines, [summary]);
    this.reasoningBlockLines = 0;
    this.reasoningStart = 0;
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

  /** Build the lines for a tool block (a leading blank + a bg-painted block)
   * from its current state. Output is trimmed to COLLAPSED/EXPANDED rows. */
  buildToolBlockLines(tool: ToolBlockState, cols: number): string[] {
    const bg = tool.error
      ? bgToolError
      : tool.status === "pending"
      ? bgToolPending
      : tool.status === "blocked"
      ? bgToolError
      : bgToolSuccess;
    const status = tool.status === "pending"
      ? `${yellow}●${reset} ${dim}running${reset}`
      : tool.status === "blocked"
      ? `${yellow}⊘ blocked${reset}`
      : tool.error
      ? `${red}✗ failed${reset}`
      : `${green}✓ done${reset}`;
    const maxLines = tool.expanded
      ? EXPANDED_OUTPUT_LINES
      : COLLAPSED_OUTPUT_LINES;
    const output = tool.fullOutput
      ? this.formatToolOutput(tool.fullOutput, maxLines)
      : "";
    const head = `${bold}${tool.name}${reset}` +
      (tool.args ? ` ${gray}${tool.args}${reset}` : "") +
      `  ${status}`;
    const content = output ? `${head}\n${output}` : head;
    return ["", ...blockLines(content, cols, bg, 1)];
  }

  /** Ctrl-O: toggle the most recent tool block between collapsed/expanded. */
  toggleLastToolExpanded(): void {
    if (!this.lastTool) return;
    this.lastTool.expanded = !this.lastTool.expanded;
    const cols = this.screen.size().cols;
    this.scrollback.replaceBlock(
      this.lastTool.id,
      this.buildToolBlockLines(this.lastTool, cols),
    );
    if (this.scrollback.atBottom) this.scrollback.scrollToBottom();
    this.render();
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
