// Unit tests for tool-argument formatting — a pure function with several
// display branches (path, edits, command, pattern, generic, invalid JSON).

import { formatToolArgs } from "../src/format.ts";
import { assertEquals } from "@std/assert";

Deno.test("formatToolArgs: a path-only object renders as the bare path", () => {
  assertEquals(formatToolArgs(JSON.stringify({ path: "/a/b.ts" })), "/a/b.ts");
});

Deno.test("formatToolArgs: path + edits renders the path and edit count", () => {
  assertEquals(
    formatToolArgs(JSON.stringify({ path: "/a.ts", edits: [{}, {}, {}] })),
    "/a.ts (3 edits)",
  );
  // Singular form for a single edit.
  assertEquals(
    formatToolArgs(JSON.stringify({ path: "/a.ts", edits: [{}] })),
    "/a.ts (1 edit)",
  );
});

Deno.test("formatToolArgs: command renders inline, truncated past 60 chars", () => {
  assertEquals(formatToolArgs(JSON.stringify({ command: "ls -la" })), "ls -la");
  const out = formatToolArgs(JSON.stringify({ command: "x".repeat(65) }));
  assertEquals(out.length, 60); // 57-char head + "..."
  assertEquals(out.endsWith("..."), true);
});

Deno.test("formatToolArgs: pattern renders as a slash-delimited regex", () => {
  assertEquals(formatToolArgs(JSON.stringify({ pattern: "foo" })), "/foo/");
});

Deno.test("formatToolArgs: other keys render as key=value pairs, path excluded", () => {
  assertEquals(
    formatToolArgs(JSON.stringify({ query: "x", limit: 5 })),
    "query=x limit=5",
  );
  // path is dropped; non-string values are JSON-encoded.
  assertEquals(
    formatToolArgs(JSON.stringify({ path: "/a", n: 7, flag: true })),
    "n=7 flag=true",
  );
});

Deno.test("formatToolArgs: invalid JSON falls back to the raw string, truncated past 80", () => {
  assertEquals(formatToolArgs("not json at all"), "not json at all");
  const out = formatToolArgs("y".repeat(100));
  assertEquals(out.length, 80); // 77-char head + "..."
  assertEquals(out.endsWith("..."), true);
});
