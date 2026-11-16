import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAYOUT, MIN, resize, restore, toggle } from "../src/layout.ts";

const screen = { width: 1600, height: 1000 };

test("a drag sets the size, within the panel's minimum and what the window leaves", () => {
  assert.equal(resize(DEFAULT_LAYOUT, "inspect", 500, screen).inspect, 500);
  assert.equal(resize(DEFAULT_LAYOUT, "inspect", 150, screen).inspect, MIN.inspect, "too narrow is clamped up");
  const greedy = resize(DEFAULT_LAYOUT, "inspect", 5000, screen);
  assert.equal(greedy.inspect, 1600 - 320 - DEFAULT_LAYOUT.side, "the centre keeps its 320px");
  assert.ok(resize(DEFAULT_LAYOUT, "trace", 5000, screen).trace <= 1000 - 200 - 160);
});

test("dragging a panel nearly shut collapses it, and it reopens at the size it had", () => {
  const shut = resize({ ...DEFAULT_LAYOUT, inspect: 420 }, "inspect", 40, screen);
  assert.equal(shut.inspectOpen, false);
  assert.equal(shut.inspect, 420, "the last real size is kept");
  assert.deepEqual(toggle(shut, "inspect"), { ...shut, inspectOpen: true });
  assert.equal(resize(shut, "inspect", 300, screen).inspectOpen, true, "dragging it open again opens it");
});

test("a stored layout from anywhere is made safe", () => {
  assert.deepEqual(restore(null), DEFAULT_LAYOUT);
  assert.deepEqual(restore("not json"), DEFAULT_LAYOUT);
  const r = restore(JSON.stringify({ side: 10, trace: 400, inspectOpen: false, extra: 1 }));
  assert.equal(r.side, MIN.side);
  assert.equal(r.trace, 400);
  assert.equal(r.inspectOpen, false);
  assert.equal((r as unknown as Record<string, unknown>).extra, undefined);
});
