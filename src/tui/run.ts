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
  getChildStderr,
  getChildStdout,
  requestResponse,
  sendRequest,
  setTransportErrorCallback,
} from "../rpc.ts";
import { dispatchCommand } from "../commands.ts";
import { formatToolArgs } from "../format.ts";
import {
  flushMarkdownBuffer,
  resetMarkdown,
  setMarkdownSink,
  writeMarkdownChunk,
} from "../markdown.ts";
import {
  currentModel,
  inPasteMode,
  resolveApproval,
  setCurrentModel,
  setInPasteMode,
  setReady,
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
import { buildFooter, buildWorkingLine } from "./footer.ts";
import { formatModelRow, formatProviderRow, Picker } from "./picker.ts";
import { fullReasoningLines, reasoningTailLines } from "./reasoning.ts";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "./spinner.ts";
import { padRight, truncateToWidth, visibleWidth } from "./width.ts";

/** Maximum rows the input box may grow to before it scrolls internally. */
const MAX_INPUT_ROWS = 5;

/** Maximum wrapped rows of reasoning shown live while the model thinks, and in
 * the compact (collapsed) finished block. */
const REASONING_TAIL_ROWS = 6;

/** Rows of reasoning shown when a block is expanded via Ctrl-T. */
const EXPANDED_REASONING_LINES = 200;

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

/** Mutable state of one reasoning ("thinking") block — tracked in the
 * scrollback by `id` so it can be repainted (streaming → finished) and
 * expanded/collapsed (Ctrl-T) in place. `buf` holds the full reasoning text. */
interface ReasoningBlockState {
  id: number;
  buf: string;
  start: number;
  streaming: boolean;
  expanded: boolean;
}

/** A previous session row, as returned by the `listSessions` RPC. */
interface SessionEntry {
  path: string;
  mtimeSecs: number;
  sizeKb: number;
  entryCount: number;
}

/** A model row, as returned by the `listModels` RPC. */
interface ModelEntry {
  id: string;
  provider: string;
}

/** A provider row, as returned by the `listProviders` RPC. */
interface ProviderEntry {
  name: string;
  isExternal: boolean;
  reachable: boolean;
  active: boolean;
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
  setTransportErrorCallback((msg) => {
    tui.scrollback.push(red + msg + reset);
    tui.render();
  });
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => tui.scrollback.push(args.join(" "));
  console.error = (...args: unknown[]) =>
    tui.scrollback.push(red + args.join(" ") + reset);
  // Re-render at the spinner cadence so the footer spinner animates and
  // the elapsed time ticks. Also makes resize detection reactive — the
  // terminal dimensions are polled every SPINNER_INTERVAL_MS even when
  // idle, so the first render after a resize picks up the new size.
  const tick = setInterval(() => {
    tui.render();
  }, SPINNER_INTERVAL_MS);
  try {
    tui.screen.enter();
    tui.render();
    await Promise.all([tui.outputLoop(), tui.inputLoop(), tui.stderrLoop()]);
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
  // The live or most-recent reasoning ("thinking") block, tracked in the
  // scrollback by id so it can be repainted (streaming → finished) and
  // expanded/collapsed (Ctrl-T) in place. `buf` is preserved so the full
  // reasoning can be shown on expand instead of being swallowed.
  reasoningBlock: ReasoningBlockState | null = null;
  nextBlockId = 1; // monotonic id for tracked blocks (tool calls + reasoning)
  lastTool: ToolBlockState | null = null; // most recent tool block (Ctrl-O target)
  // Picker overlay (session resume / model switch / provider browse).
  picker: Picker | null = null;
  pickerKind: "session" | "model" | "provider" | null = null;
  pickerTitle = "";
  pickerHint = "";
  pickerSessions: SessionEntry[] = [];
  pickerModels: ModelEntry[] = [];
  pickerProviders: ProviderEntry[] = [];
  pasteBuf: string[] = [];
  exited = false;
  /** Last terminal dimensions seen by render(), for resize detection. */
  _lastRenderRows = 0;
  _lastRenderCols = 0;

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
  // working line as a live `↻N` indicator while the turn processes them.
  steerCount = 0;
  // Current activity label for the working line ("thinking" / tool name /
  // "responding"), updated as notifications arrive during a turn.
  workingActivity = "";

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

    // Detect terminal resize and rebuild width-dependent tracked blocks
    // at the new column width so background padding and wraps reflow.
    if (
      this._lastRenderRows && this._lastRenderCols &&
      (this._lastRenderRows !== rows || this._lastRenderCols !== cols)
    ) {
      if (this.reasoningBlock) {
        this.scrollback.replaceBlock(
          this.reasoningBlock.id,
          this.buildReasoningLines(this.reasoningBlock, cols),
        );
      }
      if (this.lastTool) {
        this.scrollback.replaceBlock(
          this.lastTool.id,
          this.buildToolBlockLines(this.lastTool, cols),
        );
      }
    }
    this._lastRenderRows = rows;
    this._lastRenderCols = cols;
    const footerLines = this.footerLines(cols);
    const workingLine = this.workingLine();
    const footerH = footerLines.length;
    const extra = workingLine ? 1 : 0;
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
    const outputHeight = Math.max(
      1,
      rows - footerH - extra - view.rows.length - 2,
    );
    this.scrollback.viewportHeight = outputHeight;
    this.screen.render({
      rows,
      cols,
      lines: this.scrollback.visible(outputHeight, cols),
      footerLines,
      workingLine,
      inputRows: view.rows,
      inputCursor: { row: view.cursorRow, col: view.cursorCol },
    });
  }

  /** Build the footer rows for the current state at `cols` width. The working
   * indicator lives on its own line (see `workingLine`). */
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

  /** The transient "Working" line shown above the footer while a turn runs, or
   * undefined when idle. */
  workingLine(): string | undefined {
    if (!turnInProgress || this.turnStart <= 0) return undefined;
    return buildWorkingLine({
      spinner: spinnerFrame(Date.now()),
      elapsedMs: Date.now() - this.turnStart,
      activity: this.workingActivity,
      steers: this.steerCount,
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
    // Ctrl-T expands/collapses the most recent reasoning (thinking) block.
    if (key.kind === "ctrl" && key.char === "t") {
      this.toggleLastReasoningExpanded();
      return;
    }
    // Ctrl-D dumps the renderer state to logs/frame.txt for debugging.
    if (key.kind === "ctrl" && key.char === "d") {
      this.dumpDebug();
      return;
    }
    // Ctrl-L opens the model picker (pi-style model select).
    if (key.kind === "ctrl" && key.char === "l") {
      await this.openModelPicker();
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
      // `/model` with no args opens the model picker.
      if (cmd === "/model" && !args) {
        await this.openModelPicker();
        return;
      }
      // `/providers` opens the provider picker.
      if (cmd === "/providers") {
        await this.openProviderPicker();
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
    this.openPicker(
      "session",
      sessions.map((s) => this.formatSessionRow(s)),
      `${bold}Resume a session${reset} ${gray}(${sessions.length})${reset}`,
      `${dim}↑↓ navigate · PgUp/PgDn page · enter resume · esc cancel${reset}`,
    );
  }

  /** Open the model picker, optionally filtered to one provider. */
  async openModelPicker(filterProvider?: string): Promise<void> {
    let result: { models: ModelEntry[] };
    try {
      result = await requestResponse("listModels") as { models: ModelEntry[] };
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      this.push(`${red}failed to list models${reset}: ${msg}`);
      return;
    }
    let models = (result.models ?? []).slice().sort((a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.id.localeCompare(b.id)
    );
    if (filterProvider) {
      models = models.filter((m) => m.provider === filterProvider);
    }
    if (models.length === 0) {
      this.push(
        `${gray}no models${reset}${
          filterProvider ? ` ${gray}for ${filterProvider}${reset}` : ""
        }`,
      );
      return;
    }
    this.pickerModels = models;
    const scope = filterProvider ? ` · ${filterProvider}` : "";
    const picker = this.openPicker(
      "model",
      models.map((m) => formatModelRow(m, currentModel)),
      `${bold}Choose a model${reset} ${gray}(${models.length}${scope})${reset}`,
      `${dim}↑↓ navigate · enter switch · esc cancel${reset}`,
    );
    const cur = models.findIndex((m) => m.id === currentModel);
    if (cur >= 0) picker.select(cur);
    this.render();
  }

  /** Open the provider picker; selecting one opens its filtered model picker. */
  async openProviderPicker(): Promise<void> {
    let result: { providers: ProviderEntry[] };
    try {
      result = await requestResponse("listProviders") as {
        providers: ProviderEntry[];
      };
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      this.push(`${red}failed to list providers${reset}: ${msg}`);
      return;
    }
    const providers = (result.providers ?? []).slice().sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    if (providers.length === 0) {
      this.push(`${gray}no providers configured${reset}`);
      return;
    }
    this.pickerProviders = providers;
    this.openPicker(
      "provider",
      providers.map((p) => formatProviderRow(p)),
      `${bold}Choose a provider${reset} ${gray}(${providers.length})${reset}`,
      `${dim}↑↓ navigate · enter browse models · esc cancel${reset}`,
    );
  }

  /** Create + install a picker overlay of `kind` and render it. */
  openPicker(
    kind: "session" | "model" | "provider",
    items: string[],
    title: string,
    hint: string,
  ): Picker {
    this.pickerKind = kind;
    this.pickerTitle = title;
    this.pickerHint = hint;
    this.picker = new Picker(items);
    this.render();
    return this.picker;
  }

  /** Route a keystroke to the open picker. */
  async onPickerKey(key: Key): Promise<void> {
    const picker = this.picker!;
    const action = picker.handle(key);
    if (action === "select") {
      const idx = picker.selected;
      const kind = this.pickerKind;
      if (kind === "session") {
        const entry = this.pickerSessions[idx];
        this.closePicker();
        if (entry) await this.resumeSession(entry.path);
      } else if (kind === "model") {
        const m = this.pickerModels[idx];
        this.closePicker();
        if (m) await this.switchModel(m.id);
      } else if (kind === "provider") {
        const p = this.pickerProviders[idx];
        if (p) await this.openModelPicker(p.name); // swap to filtered model picker
        else this.closePicker();
      }
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
    this.pickerKind = null;
    this.render();
  }

  /** Switch the active model via the `setModel` RPC, updating the footer. */
  async switchModel(id: string): Promise<void> {
    try {
      const result = await requestResponse("setModel", { model: id }) as {
        model: string;
        provider: string;
      };
      setCurrentModel(result.model);
      this.push(
        `${green}switched${reset} to ${cyan}${result.model}${reset} ${gray}(provider: ${
          result.provider || "default"
        })${reset}`,
      );
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      this.push(`${red}not switched${reset}: ${msg}`);
    }
  }

  /** Resume a session by path, updating the footer model/cwd. */
  async resumeSession(path: string): Promise<void> {
    resetMarkdown();
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
      title: this.pickerTitle,
      rows_text,
      hint: this.pickerHint,
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
        } catch {
          this.push(`${red}[parse error]${reset} ${line}`);
        }
      }
      // One paint per chunk, not per line. A streaming turn can deliver many
      // deltas in a single stdout read; rendering after each tears on ConPTY
      // (many partial paints) and is wasted work — handleNotification only
      // mutates state, so coalescing to the final frame is both smoother and
      // correct. (Async handlers like onReady render themselves when they
      // settle, so they aren't affected by this batching.)
      this.render();
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
        this.workingActivity = "";
        setTurnInProgress(true);
        break;

      case "agent/end":
        this.finishReasoning();
        setTurnInProgress(false);
        this.onAgentEnd(params);
        break;

      case "agent/error":
        this.finishReasoning();
        setTurnInProgress(false);
        this.turnStart = 0;
        this.workingActivity = "";
        this.push(`${red}[error]${reset} ${params.error}`);
        break;

      case "state/change":
        if (params.state === "idle") this.finishReasoning();
        break;

      case "message/delta":
        this.finishReasoning();
        this.workingActivity = "responding";
        writeMarkdownChunk(params.delta as string);
        break;

      case "reasoning/delta": {
        flushMarkdownBuffer();
        this.workingActivity = "thinking";
        const cols = this.screen.size().cols;
        if (!this.reasoningBlock || !this.reasoningBlock.streaming) {
          this.reasoningBlock = {
            id: this.nextBlockId++,
            buf: "",
            start: Date.now(),
            streaming: true,
            expanded: false,
          };
          this.scrollback.pushBlock(
            this.reasoningBlock.id,
            this.buildReasoningLines(this.reasoningBlock, cols),
          );
        }
        this.reasoningBlock.buf += params.delta as string;
        this.scrollback.replaceBlock(
          this.reasoningBlock.id,
          this.buildReasoningLines(this.reasoningBlock, cols),
        );
        break;
      }

      case "tool/call": {
        this.finishReasoning();
        flushMarkdownBuffer();
        const push = (msg: string) => this.push(msg);
        this.workingActivity = param<string>(push, params, "name", isStr) ?? "";
        const tool: ToolBlockState = {
          id: this.nextBlockId++,
          name: param<string>(push, params, "name", isStr) ?? "(unknown)",
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
        const push = (msg: string) => this.push(msg);
        const isError = param<boolean>(push, params, "is_error", isBool);
        if (this.lastTool) {
          this.lastTool.status = "done";
          this.lastTool.error = isError === true;
          this.lastTool.fullOutput =
            param<string>(push, params, "output", isStr) ?? "";
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
      setReady(true);
      this.render();
    }).catch(() => {
      this.pushStartupBanner();
      setReady(true); // model stays blank; not fatal
    });
  }

  /** One-time branded banner + hints, pushed to the scrollback on ready. */
  pushStartupBanner(): void {
    this.push(`${bold}rho-code${reset}`);
    this.push(
      `${dim}type to chat · Ctrl-J newline · Ctrl-L model · Ctrl-O expand tool · Ctrl-T expand thinking · /help · /quit or Ctrl-C · scroll: PgUp/PgDn or Shift/Alt+↑↓${reset}`,
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
  async onAgentEnd(params: Record<string, unknown>): Promise<void> {
    flushMarkdownBuffer();
    // One-line turn summary from the enriched agent/end payload (iterations,
    // tool count, duration, non-stop finish reasons). Dim so it doesn't
    // compete with the reply.
    const parts: string[] = [];
    const iters = params.iterations as number | undefined;
    const toolCalls = params.toolCalls as unknown[] | undefined;
    const durMs = params.durationMs as number | undefined;
    const finish = params.finishReason as string | undefined;
    if (typeof iters === "number") parts.push(`${iters} iter`);
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      parts.push(`${toolCalls.length} tool`);
    }
    if (typeof durMs === "number") parts.push(`${(durMs / 1000).toFixed(1)}s`);
    if (typeof finish === "string" && finish !== "stop") parts.push(finish);
    if (parts.length > 0) this.push(`${dim}  ${parts.join(" · ")}${reset}`);
    this.turnStart = 0; // stop the spinner / elapsed counter
    this.steerCount = 0; // steers processed — clear the indicator
    this.workingActivity = "";
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

  /** Freeze the live reasoning block: switch its header to the `✦ thought · Ns`
   * summary but keep the (compact) tail visible — the thinking is not swallowed,
   * and the full text is preserved for Ctrl-T expand. No-op if not streaming. */
  finishReasoning(): void {
    if (!this.reasoningBlock || !this.reasoningBlock.streaming) return;
    this.reasoningBlock.streaming = false;
    const cols = this.screen.size().cols;
    this.scrollback.replaceBlock(
      this.reasoningBlock.id,
      this.buildReasoningLines(this.reasoningBlock, cols),
    );
  }

  /** On `approval/request`: prompt in the scrollback; input is captured on submit. */
  onApprovalRequest(params: Record<string, unknown>): void {
    flushMarkdownBuffer();
    resetMarkdown();
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
      inputTokens?: number;
      outputTokens?: number;
      cachedTokens?: number;
      cost?: number;
    } | undefined;
    if (u) {
      if (typeof u.inputTokens === "number") this.cumInput += u.inputTokens;
      if (typeof u.outputTokens === "number") {
        this.cumOutput += u.outputTokens;
      }
      if (typeof u.cachedTokens === "number") {
        this.cumCached += u.cachedTokens;
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

  /** Ctrl-T: toggle the most recent reasoning block between compact and full. */
  toggleLastReasoningExpanded(): void {
    if (!this.reasoningBlock) return;
    this.reasoningBlock.expanded = !this.reasoningBlock.expanded;
    const cols = this.screen.size().cols;
    this.scrollback.replaceBlock(
      this.reasoningBlock.id,
      this.buildReasoningLines(this.reasoningBlock, cols),
    );
    if (this.scrollback.atBottom) this.scrollback.scrollToBottom();
    this.render();
  }

  /** Build the lines for a reasoning block from its current state: a header
   * (`✦ thinking` while streaming, `✦ thought · Ns` when done) followed by the
   * compact tail, or the full reasoning when expanded. */
  buildReasoningLines(block: ReasoningBlockState, cols: number): string[] {
    const secs = block.start
      ? ((Date.now() - block.start) / 1000).toFixed(1)
      : "";
    const header = block.streaming
      ? `${gray}${italic}✦ thinking${reset}`
      : secs
      ? `${gray}✦ thought · ${secs}s${reset}`
      : `${gray}✦ thought${reset}`;
    const body = (!block.streaming && block.expanded)
      ? fullReasoningLines(block.buf, cols, EXPANDED_REASONING_LINES)
      : reasoningTailLines(block.buf, cols, REASONING_TAIL_ROWS);
    return [header, ...body];
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

  /** Ctrl-D: write the renderer's internal state to logs/frame.txt so a
   * rendering bug can be diagnosed from the renderer's own model (back-buffer),
   * the scrollback's current visible rows, and the exact bytes last sent to the
   * terminal — without a screenshot. */
  dumpDebug(): void {
    const { rows, cols } = this.screen.size();
    const sc = this.scrollback.debugState();
    const sd = this.screen.debugState();
    const esc = (s: string) => s.replaceAll("\x1b", "\\e");
    const out: string[] = [];
    out.push("=== rho-code debug dump ===");
    out.push(`time: ${new Date().toISOString()}`);
    out.push(`terminal: ${cols} cols × ${rows} rows`);
    out.push(
      `turn: inProgress=${turnInProgress} elapsed=${
        this.turnStart
          ? ((Date.now() - this.turnStart) / 1000).toFixed(1) + "s"
          : "idle"
      } activity=${
        JSON.stringify(this.workingActivity)
      } steers=${this.steerCount}`,
    );
    out.push(
      `reasoning: ${
        this.reasoningBlock
          ? `id=${this.reasoningBlock.id} streaming=${this.reasoningBlock.streaming} expanded=${this.reasoningBlock.expanded} bufLen=${this.reasoningBlock.buf.length}`
          : "null"
      }`,
    );
    out.push(
      `lastTool: ${
        this.lastTool
          ? `id=${this.lastTool.id} name=${this.lastTool.name} status=${this.lastTool.status} error=${this.lastTool.error} expanded=${this.lastTool.expanded}`
          : "null"
      }`,
    );
    out.push("");
    out.push(
      `scrollback: lineCount=${sc.lineCount} offset=${sc.offset} atBottom=${sc.atBottom} viewportHeight=${sc.viewportHeight}`,
    );
    out.push("");
    const visible = this.scrollback.visible(sc.viewportHeight, cols);
    out.push(
      `--- scrollback visible (current output) — ${visible.length} rows ---`,
    );
    visible.forEach((r, i) =>
      out.push(`[v${String(i).padStart(2)}] w=${visibleWidth(r)} | ${esc(r)}`)
    );
    out.push("");
    if (sd.buf) {
      out.push(`--- back-buffer (renderer model) — ${sd.buf.length} rows ---`);
      sd.buf.forEach((r, i) =>
        out.push(`[${String(i).padStart(2)}] w=${visibleWidth(r)} | ${esc(r)}`)
      );
    } else {
      out.push("--- back-buffer: null (full repaint pending) ---");
    }
    out.push("");
    out.push("--- raw last paint (bytes written on the last render) ---");
    out.push(esc(sd.lastPaint));
    out.push("");
    try {
      Deno.mkdirSync("logs", { recursive: true });
      Deno.writeTextFileSync("logs/frame.txt", out.join("\n") + "\n");
      this.push(
        `${green}debug dump written to ${bold}logs/frame.txt${reset}`,
      );
    } catch (e) {
      this.push(`${red}debug dump failed: ${e}${reset}`);
    }
    this.render();
  }

  /** Drain rho's stderr (its `tracing` logs) to nothing. Inherited stderr
   * would write at the cursor — parked in the input box — corrupting the
   * rendered frame and desyncing the back-buffer; piping + draining keeps the
   * pipe empty (so rho never blocks) and the terminal untouched. The TUI
   * surfaces the relevant state itself (model in the footer, context via
   * /stats), so the raw logs are discarded. */
  async stderrLoop(): Promise<void> {
    const stderr = getChildStderr();
    if (!stderr) return;
    const reader = stderr.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // stderr closed — nothing to do.
    }
    // If stderr closed but rho exited and the TUI hasn't shut down yet,
    // outputLoop may be stuck on stdout. Trigger teardown.
    if (!this.exited) {
      try {
        const status = await getChild().status;
        if (status && status.code !== null) this.exit();
      } catch {
        // child already gone
      }
    }
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

/** Extract a typed field from notification params, warning on mismatch.
 *
 * Returns `params[key]` cast via `typeof val === guard` if the value matches,
 * otherwise `undefined` and pushes a `[protocol warning]` to the scrollback.
 */
function param<T>(
  push: (msg: string) => void,
  params: Record<string, unknown>,
  key: string,
  guard: (v: unknown) => v is T,
): T | undefined {
  const val = params[key];
  if (val === undefined || val === null) return undefined;
  if (guard(val)) return val;
  push(
    `${yellow}[protocol warning]${reset} ${key}: unexpected type ${typeof val}`,
  );
  return undefined;
}
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
