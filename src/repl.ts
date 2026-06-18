// The two concurrent I/O loops: reading rho's JSON-RPC stdout, and reading
// user terminal input with slash-command dispatch.

import { red, reset, cyan } from "./ansi.ts";
import { dispatchResponse, getChild, getChildStdout, sendRequest } from "./rpc.ts";
import { handleRhoMessage } from "./handler.ts";
import { dispatchCommand } from "./commands.ts";
import { readyPromise, resolveApproval } from "./state.ts";

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
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!(await handleLine(trimmed))) return; // /quit
    }
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
    resolveApproval(line === "y" || line === "yes");
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

  // Plain prompt: forward to rho.
  sendRequest("prompt", { message: line });
  return true;
}
