// JSON-RPC 2.0 transport over the rho child process stdin/stdout.

// Pending request-response callbacks, keyed by JSON-RPC id. The callback
// receives the full response object so it can distinguish a success
// `result` from an `error` and reject the promise accordingly.
const pendingRequests = new Map<
  string,
  (msg: Record<string, unknown>) => void
>();

/** True when the stdin pipe is broken (rho exited or stdin closed). */
let writeBroken = false;

/** Callback invoked when a write to rho's stdin fails. Set by the TUI. */
let onTransportError: ((msg: string) => void) | null = null;

/** Reset the broken-pipe flag. Used in tests to isolate transport state. */
export function resetWriteBroken(): void {
  writeBroken = false;
}

/** Set a callback for transport errors (e.g. broken stdin pipe). */
export function setTransportErrorCallback(fn: (msg: string) => void): void {
  onTransportError = fn;
}

/** Returns true if the transport stdin pipe is broken. */
export function isWriteBroken(): boolean {
  return writeBroken;
}
const RHO_BIN = "rho";

/** Default timeout for requestResponse promises (ms). */
export const RESPONSE_TIMEOUT_MS = 30_000;

export function spawnRho(continueSession: boolean) {
  const command = new Deno.Command(RHO_BIN, {
    args: [
      "--accept-external-provider",
      ...(continueSession ? ["--continue"] : []),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;

  if (!childStdin || !childStdout || !childStderr) {
    console.error("Failed to pipe stdin/stdout/stderr");
    Deno.exit(1);
  }

  return { child, childStdin, childStdout, childStderr };
}

export async function sendRequest(
  method: string,
  params: Record<string, unknown> = {},
): Promise<string> {
  if (writeBroken) return crypto.randomUUID();
  const id = crypto.randomUUID();
  const message = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  try {
    const writer = childStdin.getWriter();
    await writer.write(new TextEncoder().encode(message + "\n"));
    writer.releaseLock();
  } catch {
    writeBroken = true;
    onTransportError?.("[transport error] rho stdin is closed");
  }
  return id;
}

export function requestResponse(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<unknown> {
  const idPromise = sendRequest(method, params);
  return new Promise((resolve, reject) => {
    let settled = false;
    let registeredId: string | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (registeredId) pendingRequests.delete(registeredId);
      reject(new Error(`requestResponse timed out: ${method}`));
    }, timeoutMs);
    idPromise.then((id) => {
      if (settled) return;
      if (writeBroken) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`requestResponse failed: rho stdin is closed`));
        return;
      }
      registeredId = id;
      pendingRequests.set(id, (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (msg.error) {
          reject(msg.error);
        } else {
          resolve(msg.result);
        }
      });
    });
  });
}

/** Dispatch a parsed JSON-RPC response by id, returning true if consumed. */
export function dispatchResponse(msg: Record<string, unknown>): boolean {
  const id = msg.id as string;
  if (id && pendingRequests.has(id)) {
    pendingRequests.get(id)!(msg);
    pendingRequests.delete(id);
    return true;
  }
  return false;
}

// ── Child process handles (set by init) ───────────────────────────────────

let childStdin: WritableStream<Uint8Array>;
let childStdout: ReadableStream<Uint8Array>;
let childStderr: ReadableStream<Uint8Array>;
let child: Deno.ChildProcess;

/** Wire the transport to the spawned child process. Must be called once. */
export function initTransport(
  c: Deno.ChildProcess,
  stdin: WritableStream<Uint8Array>,
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
) {
  child = c;
  childStdin = stdin;
  childStdout = stdout;
  childStderr = stderr;
}

export function getChild() {
  return child;
}

export function getChildStdout() {
  return childStdout;
}

export function getChildStderr() {
  return childStderr;
}
