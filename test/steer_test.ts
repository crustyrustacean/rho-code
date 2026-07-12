// Unit tests for the mid-turn steering decision. `buildPromptParams` is the
// pure idle-vs-steer logic that `submitPrompt` applies; testing it directly
// avoids the RPC transport and shared mutable state.

import { buildPromptParams } from "../src/repl.ts";
import { assertEquals } from "@std/assert";

Deno.test("buildPromptParams: an idle message carries no steer flag", () => {
  assertEquals(buildPromptParams("hello", false), { message: "hello" });
});

Deno.test("buildPromptParams: a mid-turn message carries steer:true", () => {
  assertEquals(buildPromptParams("nudge", true), {
    message: "nudge",
    steer: true,
  });
});
