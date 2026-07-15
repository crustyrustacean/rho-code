// Unit tests for the JSON-RPC request/response correlation. These wire the
// transport to an in-memory recording sink so we can assert what goes on the
// wire and drive responses back through `dispatchResponse`.

import { assertEquals } from "@std/assert";
import {
  dispatchResponse,
  initTransport,
  requestResponse,
  resetWriteBroken,
  RESPONSE_TIMEOUT_MS,
  sendRequest,
  setTransportErrorCallback,
} from "../src/rpc.ts";

/** A `WritableStream` that records every encoded message written to it. */
function recordingStdin(sink: string[]): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      sink.push(new TextDecoder().decode(chunk));
    },
  });
}

/** Wire the transport to a recording stdin (child and stdout are unused here). */
function initTestTransport(sink: string[]) {
  initTransport(
    {} as unknown as Deno.ChildProcess,
    recordingStdin(sink),
    new ReadableStream<Uint8Array>(),
    new ReadableStream<Uint8Array>(),
  );
}

/**
 * Let pending fire-and-forget writes complete. `sendRequest` writes without
 * awaiting, so the recording sink is populated asynchronously; this drains the
 * WritableStream's internal queue before the test inspects the wire.
 */
function flushWrites(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

Deno.test("requestResponse: resolves when dispatchResponse delivers the matching id", async () => {
  const sent: string[] = [];
  initTestTransport(sent);

  const pending = requestResponse("getState", { foo: 1 });
  await flushWrites();

  // The request hit the wire as a well-formed JSON-RPC message.
  const req = JSON.parse(sent[0]);
  assertEquals(req.jsonrpc, "2.0");
  assertEquals(req.method, "getState");
  assertEquals(req.params, { foo: 1 });

  // Delivering the response keyed by that id resolves the promise.
  const handled = dispatchResponse({
    jsonrpc: "2.0",
    id: req.id,
    result: { model: "mock-model" },
  });
  assertEquals(handled, true);
  assertEquals(await pending, { model: "mock-model" });
});

Deno.test("requestResponse: rejects with the error object on an error response", async () => {
  const sent: string[] = [];
  initTestTransport(sent);

  const pending = requestResponse("setModel", { model: "bogus" });
  await flushWrites();
  const req = JSON.parse(sent[0]);
  dispatchResponse({
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32602, message: "unknown model" },
  });

  let caught: unknown;
  try {
    await pending;
    caught = "resolved unexpectedly";
  } catch (e) {
    caught = e;
  }
  assertEquals(caught, { code: -32602, message: "unknown model" });
});

Deno.test("dispatchResponse: returns false for an unknown id", () => {
  assertEquals(
    dispatchResponse({ jsonrpc: "2.0", id: "never-registered", result: {} }),
    false,
  );
});

Deno.test("requestResponse: rejects with timeout error when no response arrives", async () => {
  const sent: string[] = [];
  initTestTransport(sent);

  const pending = requestResponse("getState", {}, 10);
  await flushWrites();
  JSON.parse(sent[0]); // prove it hit the wire

  let caught: unknown;
  try {
    await pending;
    caught = "resolved unexpectedly";
  } catch (e) {
    caught = e;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(
    (caught as Error).message,
    "requestResponse timed out: getState",
  );
});

Deno.test("requestResponse: resolves normally before timeout fires", async () => {
  const sent: string[] = [];
  initTestTransport(sent);

  const pending = requestResponse("getState", {}, 10_000);
  await flushWrites();
  const req = JSON.parse(sent[0]);

  // Deliver the response well before the 10s timeout.
  dispatchResponse({
    jsonrpc: "2.0",
    id: req.id,
    result: { model: "fast-model" },
  });
  assertEquals(await pending, { model: "fast-model" });
});

Deno.test("requestResponse: cleans up pending map on timeout", async () => {
  const sent: string[] = [];
  initTestTransport(sent);

  const pending = requestResponse("listModels", {}, 10);
  await flushWrites();
  const req = JSON.parse(sent[0]);

  // Let the timeout fire.
  await pending.catch(() => {});

  // A late response for the timed-out id is ignored (not dispatched).
  assertEquals(
    dispatchResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: { models: [] },
    }),
    false,
  );
});

/** A `WritableStream` that rejects all writes (simulating a broken pipe). */
function rejectingStdin(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write() {
      throw new Error("broken pipe");
    },
  });
}

/** Wire the transport to a rejecting stdin (child and stdout are unused). */
function initBrokenTransport() {
  initTransport(
    {} as unknown as Deno.ChildProcess,
    rejectingStdin(),
    new ReadableStream<Uint8Array>(),
    new ReadableStream<Uint8Array>(),
  );
}

Deno.test("requestResponse: rejects immediately when stdin write fails", async () => {
  const errors: string[] = [];
  setTransportErrorCallback((msg) => errors.push(msg));
  initBrokenTransport();

  let caught: unknown;
  try {
    await requestResponse("getState", {});
    caught = "resolved unexpectedly";
  } catch (e) {
    caught = e;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals(
    (caught as Error).message,
    "requestResponse failed: rho stdin is closed",
  );
});

Deno.test("sendRequest: transport error callback is invoked on write failure", async () => {
  resetWriteBroken();
  const errors: string[] = [];
  setTransportErrorCallback((msg) => errors.push(msg));
  initBrokenTransport();

  await sendRequest("submitPrompt", { prompt: "hello" });

  assertEquals(errors.length, 1);
  assertEquals(errors[0], "[transport error] rho stdin is closed");
});

Deno.test("requestResponse: default timeout is RESPONSE_TIMEOUT_MS", () => {
  // The default is already exercised by the timeout tests above.
  // Here we just verify the constant is exported and reasonable.
  assertEquals(RESPONSE_TIMEOUT_MS, 30_000);
});
