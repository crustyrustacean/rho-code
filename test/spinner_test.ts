// Tests for the working-indicator spinner frame selection.

import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
} from "../src/tui/spinner.ts";
import { assertEquals } from "@std/assert";

Deno.test("spinnerFrame: at time 0 returns the first frame", () => {
  assertEquals(spinnerFrame(0), SPINNER_FRAMES[0]);
});

Deno.test("spinnerFrame: advances one frame per interval", () => {
  assertEquals(spinnerFrame(SPINNER_INTERVAL_MS), SPINNER_FRAMES[1]);
  assertEquals(spinnerFrame(SPINNER_INTERVAL_MS * 2), SPINNER_FRAMES[2]);
});

Deno.test("spinnerFrame: wraps around after the last frame", () => {
  assertEquals(
    spinnerFrame(SPINNER_INTERVAL_MS * SPINNER_FRAMES.length),
    SPINNER_FRAMES[0],
  );
  assertEquals(
    spinnerFrame(SPINNER_INTERVAL_MS * (SPINNER_FRAMES.length + 3)),
    SPINNER_FRAMES[3],
  );
});

Deno.test("spinnerFrame: a non-positive interval falls back to the first frame", () => {
  assertEquals(spinnerFrame(9999, 0), SPINNER_FRAMES[0]);
});
