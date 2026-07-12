// The two concurrent I/O loops: reading rho's JSON-RPC stdout, and reading
// user terminal input with slash-command dispatch.

import { red, reset, cyan, dim, gray } from "./ansi.ts";
import { dispatchResponse, getChild, getChildStdout, sendRequest } from "./rpc.ts";
import { handleRhoMessage } from "./handler.ts";
import { dispatchCommand } from "./commands.ts";
import { readyPromise, resolveApproval, inPasteMode, setInPasteMode, turnInProgress } from "./state.ts";

/** Read newline-delimited JSON-RPC from rho's stdout and dispatch. */
export async function readRhoOutput() {
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
        handleRhoMessage(msg);
      } catch {
        console.error("[parse error]", line);
      }
    }
  }
}

/** Read user terminal input, handle slash commands, and forward prompts. */
export async function readUserInput() {
  await readyPromise;

  let pasteBuffer: string[] = [];

  // Stream stdin and split on newlines. This handles arbitrarily long lines
  // and multi-line pastes correctly — a fixed-size read buffer would silently
  // truncate anything longer than itself, losing the tail of a long input.
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep partial trailing line

    for (const line of lines) {
      // In paste mode, collect lines until the user enters a lone ".".
      if (inPasteMode) {
        if (line.trim() === ".") {
          const text = pasteBuffer.join("\n");
          if (!text.trim()) {
            console.log(`${dim}paste cancelled (empty)${reset}`);
          } else {
            submitPrompt(text);
          }
          setInPasteMode(false);
          process.stdout.write("> ");
        } else {
          pasteBuffer.push(line);
        }
        continue;
      }


      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!(await handleLine(trimmed))) return; // /quit
    }
  }
}

/**
 * Build the JSON-RPC `prompt` params for a user message. When a turn is in
 * progress, the message is sent as a steering nudge (`steer: true`) — injected
 * at the next tool-batch seam rather than queued as a separate turn. Extracted
 * as pure logic so the idle-vs-steer decision is unit-testable without the
 * transport or shared state.
 */
export function buildPromptParams(
  message: string,
  busy: boolean,
): Record<string, unknown> {
  return busy ? { message, steer: true } : { message };
}

/**
 * Forward a prompt to rho, steering the active turn if one is in progress
 * (see [`buildPromptParams`]). A one-line ack confirms a steer, since it
 * produces no immediate agent output.
 */
function submitPrompt(message: string) {
  sendRequest("prompt", buildPromptParams(message, turnInProgress));
  if (turnInProgress) {
    console.log(`${gray}↳ steering the current turn…${reset}`);
  }
}

/**
 * Handle one input line.
 *
 * Returns `false` to terminate the read loop (`/quit`). Precedence is
 * intentional: `/quit` and `/abort` are checked before the approval-mode
 * intercept so they keep working while an approval prompt is pending.
 */
async function handleLine(line: string): Promise<boolean> {
  // /quit terminates the frontend.
  if (line === "/quit" || line === "/q") {
    getChild().kill("SIGTERM");
    return false;
  }

  // /abort cancels the in-progress turn (also reachable during approval).
  if (line === "/abort") {
    sendRequest("abort");
    return true;
  }

  // Approval mode intercepts all other input.
  if (resolveApproval) {
    const lower = line.toLowerCase();
    if (lower === "y" || lower === "yes") {
      resolveApproval(true);
    } else if (lower === "n" || lower === "no") {
      resolveApproval(null);
    } else {
      // Anything else is a redirect message — deny the tool call but
      // inject this text as alternative instructions for the model.
      resolveApproval(line);
    }
    return true;
  }

  // Slash commands.
  if (line.startsWith("/")) {
    const spaceIdx = line.indexOf(" ");
    const cmd = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();
    try {
      const found = await dispatchCommand(cmd, args);
      if (!found) {
        console.log(
          `${red}unknown command: ${cmd}${reset}  type ${cyan}/help${reset} for available commands`,
        );
      }
    } catch (e) {
      // A rejected requestResponse (JSON-RPC error) from any command.
      const message = (e as { message?: string })?.message ?? JSON.stringify(e);
      console.log(`${red}error${reset}: ${message}`);
    }
    process.stdout.write("> ");
    return true;
  }

  // Plain prompt: forward to rho (steers if a turn is in progress).
  submitPrompt(line);
  return true;
}