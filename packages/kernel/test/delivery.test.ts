import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, runToQuiescence, send, stateOf } from "../src/engine.ts";

const accumulator = (withKey: boolean) => loadModel(`
context: T
aggregates:
  Account:
    creators: [Open]
    data: { balance: { type: number, default: 0 } }
    initial: open
    states:
      open:
        on:
          Open: {}
          Deposit:
            ${withKey ? "idempotency: command.txId" : ""}
            assign: { balance: balance + command.amount }
`);

test("an accumulator without a key is applied twice under redelivery", () => {
  const world = createWorld(accumulator(false), "2026-01-01T09:00:00Z", { kind: "duplicate" });
  send(world, "Account#1.Open");
  send(world, "Account#1.Deposit", { txId: "t1", amount: 10 });
  assert.equal(world.aggregates["Account#1"]!.data.balance, 20, "the hazard is real, not theoretical");
});

test("a declared identity makes the same delivery idempotent", () => {
  const world = createWorld(accumulator(true), "2026-01-01T09:00:00Z", { kind: "duplicate" });
  send(world, "Account#1.Open");
  send(world, "Account#1.Deposit", { txId: "t1", amount: 10 });
  assert.equal(world.aggregates["Account#1"]!.data.balance, 10);
  assert.ok(world.log.some((e) => e.kind === "duplicate"), "the repeat is recorded, not hidden");
});

test("two different payments are not mistaken for a redelivery", () => {
  const world = createWorld(accumulator(true));
  send(world, "Account#1.Open");
  send(world, "Account#1.Deposit", { txId: "t1", amount: 10 });
  send(world, "Account#1.Deposit", { txId: "t2", amount: 10 });
  assert.equal(world.aggregates["Account#1"]!.data.balance, 20);
});

test("the accumulator lint fires, and a declared identity silences it", () => {
  assert.match(accumulator(false).findings[0]!.message, /accumulates/);
  assert.deepEqual(accumulator(true).findings, []);
});

test("a random schedule is reproducible from its seed", () => {
  const model = loadModel(`
context: T
aggregates:
  A:
    creators: [Go]
    initial: a
    states:
      a: { on: { Go: { emit: [One, Two, Three] } } }
policies:
  p1: { on: One,   command: "A#2.Go" }
  p2: { on: Two,   command: "A#3.Go" }
  p3: { on: Three, command: "A#4.Go" }
`);
  const run = (seed: number) => {
    const w = createWorld(model, "2026-01-01T09:00:00Z", { kind: "random", seed });
    w.budget = 60;
    send(w, "A#1.Go");
    return w.log.map((e) => `${e.kind}:${"instance" in e ? e.instance : ""}`).join("|");
  };
  assert.equal(run(7), run(7), "same seed, same trace");
  const seeds = new Set([run(1), run(2), run(3), run(4), run(5)]);
  assert.ok(seeds.size > 1, "different seeds really do interleave differently");
});

test("a predicate quantifier is picked up on entry, so a late parent still acts", () => {
  const model = loadModel(`
context: T
aggregates:
  Parent:
    creators: [Start]
    children: { kids: { type: Kid, via: command.parentId } }
    initial: early
    states:
      early: { on: { Start: {}, Open: { target: watching } } }
      watching:
        on_children:
          kids.all_final: { target: done }
      done: { final: true }
  Kid:
    creators: [Create]
    initial: busy
    states:
      busy: { on: { Create: {}, Finish: { target: finished } } }
      finished: { final: true }
`);
  const world = createWorld(model);
  send(world, "Parent#1.Start");
  send(world, "Kid#k1.Create", { parentId: "1" });
  send(world, "Kid#k1.Finish");
  assert.equal(stateOf(world, "Parent#1"), "early", "nothing fires while the parent is elsewhere");
  send(world, "Parent#1.Open");
  assert.equal(stateOf(world, "Parent#1"), "done", "entering the state evaluates the condition");
});

test("a predicate fires once per occupancy and re-arms on re-entry", () => {
  const model = loadModel(`
context: T
aggregates:
  Parent:
    creators: [Start]
    children: { kids: { type: Kid, via: command.parentId } }
    initial: watching
    states:
      watching:
        on:
          Start: {}
          Leave: { target: away }
        on_children:
          kids.all_final: { emit: [AllDone] }
      away: { on: { Return: { target: watching } } }
  Kid:
    creators: [Create]
    initial: busy
    states:
      busy: { on: { Create: {}, Finish: { target: finished } } }
      finished: { final: true }
`);
  const world = createWorld(model);
  send(world, "Parent#1.Start");
  send(world, "Kid#k1.Create", { parentId: "1" });
  send(world, "Kid#k1.Finish");
  const count = () => world.log.filter((e) => e.kind === "event" && e.event === "AllDone").length;
  assert.equal(count(), 1);
  runToQuiescence(world);
  assert.equal(count(), 1, "it does not re-fire while the state stays occupied");
  send(world, "Parent#1.Leave");
  send(world, "Parent#1.Return");
  assert.equal(count(), 2, "re-entry re-arms it, like a timer");
});

test("an edge trigger driving a state change is linted", () => {
  const model = loadModel(`
context: T
aggregates:
  Parent:
    creators: [Start]
    children: { kids: { type: Kid, via: command.parentId } }
    initial: watching
    states:
      watching:
        on: { Start: {} }
        on_children:
          kids.first_entering(finished): { target: moved }
      moved: {}
  Kid:
    creators: [Create]
    initial: busy
    states:
      busy: { on: { Create: {}, Finish: { target: finished } } }
      finished: { final: true }
`);
  assert.match(model.findings[0]!.message, /is a moment, not a condition/);
});

test("a policy can dedup a redelivered event by its identity too", () => {
  const model = loadModel(`
context: T
aggregates:
  A:
    creators: [Go]
    initial: a
    states:
      a: { on: { Go: { emit: [Happened: { ref: "\${command.ref}" }] } } }
  Counter:
    creators: [Bump]
    data: { n: { type: number, default: 0 } }
    initial: c
    states:
      c: { on: { Bump: { assign: { n: n + 1 }, idempotency: command.ref } } }
policies:
  react:
    correlate: event.ref
    initial: s
    states:
      s:
        on:
          Happened:
            idempotency: event.ref
            command: "Counter#one.Bump"
            with: { ref: "\${event.ref}" }
`);
  const world = createWorld(model, "2026-01-01T09:00:00Z", { kind: "duplicate" });
  send(world, "A#1.Go", { ref: "r1" });
  assert.equal(world.aggregates["Counter#one"]!.data.n, 1);
  assert.ok(world.log.some((e) => e.kind === "duplicate" && e.instance === "react#r1"));
});
