// Tests for the list picker — navigation, windowing, and select/cancel.

import { SessionPicker } from "../src/tui/picker.ts";
import { k } from "./helpers.ts";
import { assertEquals } from "@std/assert";

function picker(n: number): SessionPicker {
  return new SessionPicker(Array.from({ length: n }, (_, i) => `item ${i}`));
}

Deno.test("SessionPicker: starts on the first item", () => {
  const p = picker(3);
  assertEquals(p.selected, 0);
  assertEquals(p.count, 3);
});

Deno.test("SessionPicker: down/up move the selection, clamped at the ends", () => {
  const p = picker(3);
  p.handle(k("arrow", "down"));
  assertEquals(p.selected, 1);
  p.handle(k("arrow", "down"));
  assertEquals(p.selected, 2);
  p.handle(k("arrow", "down")); // last item — clamps
  assertEquals(p.selected, 2);
  p.handle(k("arrow", "up"));
  assertEquals(p.selected, 1);
  p.handle(k("arrow", "up"));
  p.handle(k("arrow", "up")); // first item — clamps
  assertEquals(p.selected, 0);
});

Deno.test("SessionPicker: home/end jump to the edges", () => {
  const p = picker(5);
  p.handle(k("end"));
  assertEquals(p.selected, 4);
  p.handle(k("home"));
  assertEquals(p.selected, 0);
});

Deno.test("SessionPicker: page up/down move by the viewport height", () => {
  const p = picker(10);
  p.viewportHeight = 3;
  p.handle(k("page", "down"));
  assertEquals(p.selected, 3);
  p.handle(k("page", "down"));
  assertEquals(p.selected, 6);
  p.handle(k("page", "up"));
  assertEquals(p.selected, 3);
});

Deno.test("SessionPicker: enter selects, escape cancels", () => {
  const p = picker(3);
  p.handle(k("arrow", "down"));
  assertEquals(p.handle(k("enter")), "select");
  assertEquals(p.selected, 1); // the chosen index
  assertEquals(p.handle(k("escape")), "cancel");
});

Deno.test("SessionPicker: typing and other keys are ignored", () => {
  const p = picker(3);
  assertEquals(p.handle(k("char", "x")), null);
  assertEquals(p.handle(k("tab")), null);
  assertEquals(p.selected, 0);
});

Deno.test("SessionPicker: visible() windows around the selection as it scrolls", () => {
  const p = picker(10);
  p.viewportHeight = 3;
  // Start: selected 0 → window items 0..2.
  assertEquals(p.visible().map((r) => r.index), [0, 1, 2]);
  // Move down to item 3 → window scrolls to 1..3.
  p.handle(k("end")); // jump to 9
  assertEquals(p.visible().map((r) => r.index), [7, 8, 9]);
  assertEquals(p.visible().filter((r) => r.selected).map((r) => r.index), [9]);
});

Deno.test("SessionPicker: an empty picker stays at index 0 and selects nothing meaningful", () => {
  const p = new SessionPicker([]);
  assertEquals(p.count, 0);
  assertEquals(p.selected, 0);
  p.handle(k("arrow", "down"));
  assertEquals(p.selected, 0);
  assertEquals(p.visible(), []);
});
