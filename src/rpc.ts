// JSON-RPC 2.0 transport over the rho child process stdin/stdout.

// Pending request-response callbacks, keyed by JSON-RPC id. The callback
// receives the full response object so it can distinguish a success
// `result` from an `error` and reject the promise accordingly.
const pendingRequests = new Map<
  string,
  (msg: Record<string, unknown>) => void
>();

const RHO_BIN = "rho";

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

export function sendRequest(
  method: string,
  params: Record<string, unknown> = {},
): string {
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

export function requestResponse(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
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
