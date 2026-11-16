import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "../src/model.ts";
import { advance, createWorld, send } from "../src/engine.ts";

const model = loadModel(readFileSync(new URL("../../examples/models/sales.yaml", import.meta.url), "utf8"));

test("frames are off unless asked for", () => {
  const world = createWorld(model);
  send(world, "Order#A1.Place", { total: 100, items: ["widget"] });
  assert.equal(world.frames, undefined);
});

test("one frame per input, plus the empty world and the moment a command is sent", () => {
  const world = createWorld(model, undefined, undefined, { frames: true });
  send(world, "Order#A1.Place", { total: 100, items: ["widget"] });
  const frames = world.frames!;
  assert.equal(frames[0]!.step, "nothing has happened yet");
  assert.equal(frames[1]!.step, "you sent Order#A1.Place");
  assert.deepEqual(frames[1]!.inflight.map((m) => m.to), ["Order#A1"], "the command is in flight, not yet handled");
  assert.deepEqual(frames[1]!.instances, {});
  assert.equal(frames.at(-1)!.inflight.length, 0, "the last frame is quiescent");
  assert.equal(frames.at(-1)!.seq, world.log.length);
});

test("messages in flight are part of the frame: the cascade is visible mid-way", () => {
  const world = createWorld(model, undefined, undefined, { frames: true });
  send(world, "Order#A1.Place", { total: 100, items: ["widget", "gizmo"] });
  const afterPlace = world.frames![2]!;
  assert.equal(afterPlace.instances["Order#A1"]!.config[0]!.join("."), "fulfilling.awaiting_payment");
  assert.deepEqual(
    afterPlace.inflight.map((m) => m.text),
    ["OrderPlaced → explode_order_into_lines", "OrderPlaced → reserve_stock_when_placed"],
  );
});

test("an earlier frame does not change when the run moves on (time travel is sound)", () => {
  const world = createWorld(model, undefined, undefined, { frames: true });
  send(world, "Order#A1.Place", { total: 100, items: ["widget"] });
  const before = world.frames!.at(-1)!;
  const frozen = JSON.stringify(before);
  send(world, "Order#A1.Pay", { paymentId: "p1", amount: 100 });
  advance(world, 31 * 86_400_000);
  assert.equal(JSON.stringify(before), frozen);
  assert.equal(before.instances["Order#A1"]!.data.paid, 0);
});

test("an instance nothing touched is shared with the previous frame, not copied", () => {
  const world = createWorld(model, undefined, undefined, { frames: true });
  send(world, "Order#A1.Place", { total: 100, items: ["widget"] });
  const a = world.frames!.at(-1)!;
  send(world, "Order#B1.Place", { total: 50, items: ["gizmo"] });
  const b = world.frames!.at(-1)!;
  assert.equal(a.instances["Order#A1"], b.instances["Order#A1"]);
});

test("deadlines are visible as pending timers, and a clock jump that fires one is its own frame", () => {
  const world = createWorld(model, undefined, undefined, { frames: true });
  send(world, "Order#A1.Place", { total: 100, items: ["widget"] });
  assert.deepEqual(world.frames!.at(-1)!.timers.map((t) => `${t.state} ${t.label}`).sort(),
    ["fulfilling 30d", "fulfilling.awaiting_payment 14d"]);
  const count = world.frames!.length;
  advance(world, 15 * 86_400_000);
  const steps = world.frames!.slice(count).map((f) => f.step);
  assert.equal(steps[0], "the clock reached the 14d deadline of Order#A1");
  assert.equal(steps.at(-1), "the clock moved on");
});
