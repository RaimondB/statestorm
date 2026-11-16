import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel, stateOf } from "@statestorm/kernel";
import { parseScenario, runScenario } from "@statestorm/scenarios";
import { actionsOf, commandsOf, continueFrom, fireableTypes, frameOfEntry, play, typeToFire, type Action } from "../src/session.ts";

const examples = new URL("../../examples/", import.meta.url);
const model = loadModel(readFileSync(new URL("models/sales.yaml", examples), "utf8"));
const fifo = { kind: "fifo" } as const;

const actions: Action[] = [
  { kind: "send", ref: "Order#A1.Place", payload: { total: 100, items: ["widget"] } },
  { kind: "send", ref: "Order#A1.Pay", payload: { paymentId: "p1", amount: 100 } },
];

test("every frame knows the action that produced it", () => {
  const run = play(model, actions, fifo);
  assert.equal(run.actionOf.length, run.frames.length);
  assert.equal(run.actionOf[0], -1, "the empty world belongs to no action");
  assert.ok(run.actionOf.includes(0) && run.actionOf.includes(1));
  assert.deepEqual([...run.actionOf].sort((a, b) => a - b), run.actionOf, "monotonic");
});

test("replaying a scenario's steps reaches the state the headless runner reaches", () => {
  const scenario = parseScenario(
    readFileSync(new URL("scenarios/sales/01-happy-path.yaml", examples), "utf8"),
  );
  const run = play(model, actionsOf(scenario), fifo);
  const headless = runScenario(model, scenario).world;
  assert.equal(JSON.stringify(run.world.log), JSON.stringify(headless.log));
  assert.equal(stateOf(run.world, "Order#A1"), "completed");
});

test("acting while scrubbed back forks at the end of that frame's action", () => {
  const run = play(model, actions, fifo);
  const midPlace = run.actionOf.indexOf(0) + 1;
  const next: Action = { kind: "send", ref: "Order#A1.Cancel", payload: {} };
  const forked = continueFrom(actions, run, midPlace, next);
  assert.deepEqual(forked, [actions[0], next], "the payment is dropped, the placement kept whole");
  assert.equal(stateOf(play(model, forked, fifo).world, "Order#A1"), "cancelled");
  assert.deepEqual(continueFrom(actions, run, 0, next), [next], "from the empty world");
});

test("a log entry maps to the frame that wrote it", () => {
  const run = play(model, actions, fifo);
  for (const e of run.world.log) {
    const i = frameOfEntry(run, e.seq);
    assert.ok(run.frames[i]!.seq >= e.seq);
    assert.ok(i === 0 || run.frames[i - 1]!.seq < e.seq);
  }
});

test("a send to a malformed ref is reported, not thrown at the UI", () => {
  const run = play(model, [{ kind: "send", ref: "nonsense", payload: {} }], fifo);
  assert.equal(run.error?.action, 0);
  assert.match(run.error!.message, /not a command/);
});

test("the fire panel offers creators first, then every command the chart handles", () => {
  assert.deepEqual(commandsOf(model.aggregates.Order!), ["Place", "Cancel", "Pay"]);
});

test("phases mark where a part of the run begins, and change nothing", () => {
  const withPhases: Action[] = [
    { kind: "phase", name: "Planning" },
    actions[0]!,
    { kind: "phase", name: "Execution" },
    actions[1]!,
  ];
  const run = play(model, withPhases, fifo);
  const plain = play(model, actions, fifo);
  assert.equal(JSON.stringify(run.world.log), JSON.stringify(plain.world.log));
  assert.deepEqual(run.phases.map((p) => p.name), ["Planning", "Execution"]);
  assert.equal(run.phases[0]!.frame, 0);
  const placeSettled = run.actionOf.lastIndexOf(1);
  assert.equal(run.phases[1]!.frame, placeSettled, "Execution starts where planning settled");
});

test("switching models resets a fire target that is abstract, or an entity, in the new one", () => {
  const lab = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8"));
  const types = fireableTypes(lab);
  assert.ok(types.length > 0);
  assert.equal(typeToFire(lab, "Step"), types[0], "Step is abstract in lab — no instance to address");
  assert.equal(typeToFire(lab, "RouteTask"), types[0], "RouteTask is an entity — reached through its aggregate");
  assert.equal(typeToFire(lab, "Order"), types[0], "a type lab does not have");
  assert.equal(typeToFire(lab, "Request"), "Request", "a type that can be fired at stays chosen");
  assert.equal(typeToFire(model, "Order"), "Order");
});
