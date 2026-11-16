import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { advance, createWorld, send, stateOf } from "../src/engine.ts";

// ADR 0014: a deadline read from the instance's own data — a time limit per place, copied
// onto the parcel when it was planned. Parcels are entities of an order (the timer fires
// inside the aggregate's step).
const MODEL = `
context: T
aggregates:
  Order:
    creators: [Plan]
    children:
      parcels: { type: Parcel, via: command.order }
    initial: open
    states:
      open:
        on:
          Plan:
            send: { for_each: command.parcels, to: "Parcel#\${id}-\${item}.Expect", with: { order: "\${id}", holding: "\${command.holding}", remind: "\${command.remind}" } }
          Ready: { send: { to: "Parcel#\${id}-\${command.parcel}.Ready" } }
          Collect: { send: { to: "Parcel#\${id}-\${command.parcel}.Collect" } }
        on_children:
          parcels.all_final: { target: done }
      done: { final: true }
  Parcel:
    kind: entity
    creators: [Expect]
    data:
      holding: { type: string }
      remind:  { type: string }
    initial: expected
    states:
      expected:
        on:
          Expect: { assign: { holding: command.holding, remind: command.remind } }
          Ready: { target: waiting }
      waiting:
        after:
          remind:  { emit: [ Reminded: { parcel: "\${id}" } ] }
          holding: { target: expired }
          1d:      { emit: [ OneDay: {} ] }
        on:
          Collect: { target: collected }
      expired: { final: true }
      collected: { final: true }
`;

const model = loadModel(MODEL);
const DAY = 86_400_000;

test("a deadline named by a field is armed from the instance's value when the state is entered", () => {
  const world = createWorld(model);
  send(world, "Order#O1.Plan", { parcels: ["P1", "P2"], holding: "7d", remind: "5d" });
  advance(world, 2 * DAY);                     // the clock only counts once the parcel is waiting
  send(world, "Order#O1.Ready", { parcel: "P1" });
  advance(world, 5 * DAY);
  const reminded = world.log.filter((e) => e.kind === "event" && e.event === "Reminded");
  assert.equal(reminded.length, 1, "reminded once, five days after it was ready");
  assert.equal(stateOf(world, "Parcel#O1-P1"), "waiting");
  advance(world, 2 * DAY);
  assert.equal(stateOf(world, "Parcel#O1-P1"), "expired");
  assert.equal(stateOf(world, "Parcel#O1-P2"), "expected", "never ready: no clock");
  assert.equal(world.log.filter((e) => e.kind === "event" && e.event === "OneDay").length, 1, "a literal deadline beside them still works");
});

test("leaving the state cancels a field deadline like any other", () => {
  const world = createWorld(model);
  send(world, "Order#O1.Plan", { parcels: ["P1"], holding: "7d", remind: "5d" });
  send(world, "Order#O1.Ready", { parcel: "P1" });
  assert.equal(world.timers.length, 3);
  advance(world, 3 * DAY);
  send(world, "Order#O1.Collect", { parcel: "P1" });
  assert.equal(world.timers.length, 0, "collected: neither the reminder nor the expiry is still due");
  advance(world, 30 * DAY);
  assert.equal(stateOf(world, "Parcel#O1-P1"), "collected");
  assert.equal(world.log.filter((e) => e.kind === "event" && e.event === "Reminded").length, 0);
});

test("a deadline field that does not hold a duration is loud, not never", () => {
  const world = createWorld(model);
  send(world, "Order#O1.Plan", { parcels: ["P1"], holding: "a week", remind: "5d" });
  send(world, "Order#O1.Ready", { parcel: "P1" });
  const errors = world.log.filter((e) => e.kind === "finding" && e.severity === "error");
  assert.equal(errors.length, 1);
  assert.match((errors[0] as { message: string }).message, /holding deadline on waiting is not armed — `holding` is "a week"/);
  advance(world, 30 * DAY);
  assert.equal(stateOf(world, "Parcel#O1-P1"), "waiting", "unarmed, it never fires");
});

test("the loader refuses a deadline that is neither a duration nor a string field", () => {
  assert.throws(() => loadModel(MODEL.replace("holding: { target: expired }", "holdng: { target: expired }")),
    /`after: holdng` is neither a duration .* nor a data field of Parcel/);
  assert.throws(() => loadModel(MODEL.replace("holding: { type: string }", "holding: { type: number }")),
    /names a number field — a deadline field holds a duration such as 7d/);
  assert.throws(() => loadModel(MODEL.replace("1d:      {", "\"1 day\": {")), /is not a duration/);
});
