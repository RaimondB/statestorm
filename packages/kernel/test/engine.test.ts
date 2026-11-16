import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, send, stateOf } from "../src/engine.ts";

test("an inner handler shadows the outer one, and the trace says which won", () => {
  const model = loadModel(`
context: T
aggregates:
  A:
    creators: [Start]
    initial: new
    states:
      new: { on: { Start: { target: outer } } }
      outer:
        initial: inner
        on: { Poke: { target: outer_won } }
        states:
          inner: { on: { Poke: { target: inner_won } } }
      outer_won: {}
      inner_won: {}
`);
  const world = createWorld(model);
  send(world, "A#1.Start");
  send(world, "A#1.Poke");
  assert.equal(stateOf(world, "A#1"), "inner_won");
  const taken = world.log.find((e) => e.kind === "transition" && e.to === "inner_won");
  assert.match((taken as { via: string }).via, /outer\.inner on Poke/);
});

test("a command bubbles outward when the inner guard refuses", () => {
  const model = loadModel(`
context: T
aggregates:
  A:
    creators: [Start]
    data: { n: { type: number, default: 0 } }
    initial: new
    states:
      new: { on: { Start: { target: outer } } }
      outer:
        initial: inner
        on: { Poke: { target: outer_won } }
        states:
          inner: { on: { Poke: { guard: n > 0, target: inner_won } } }
      outer_won: {}
      inner_won: {}
`);
  const world = createWorld(model);
  send(world, "A#1.Start");
  send(world, "A#1.Poke");
  assert.equal(stateOf(world, "A#1"), "outer_won", "a failed guard does not end the search");
});

test("a command to a missing instance is reported, not quietly created", () => {
  const model = loadModel(`
context: T
aggregates:
  A: { creators: [Start], initial: a, states: { a: { on: { Start: {}, Poke: {} } } } }
`);
  const world = createWorld(model);
  send(world, "A#1.Poke");
  const entry = world.log.find((e) => e.kind === "unhandled");
  assert.ok(entry, "an unhandled entry is written");
  assert.match((entry as { reason: string }).reason, /not one of A's creators/);
  assert.equal(stateOf(world, "A#1"), undefined);
});

test("a cycle is aborted and reported rather than hanging", () => {
  const model = loadModel(`
context: T
aggregates:
  A:
    creators: [Go]
    initial: a
    states:
      a: { on: { Go: { emit: [Pinged] } } }
policies:
  loop: { on: Pinged, command: "A#1.Go" }
`);
  const world = createWorld(model);
  send(world, "A#1.Go");
  const aborted = world.log.find((e) => e.kind === "finding" && /cascade aborted/.test(e.message));
  assert.ok(aborted, "the cascade is aborted");
  assert.equal(world.queue.length, 0);
});

test("an assignment reading a field the command lacks is a finding, and changes nothing", async () => {
  const { loadModel } = await import("../src/model.ts");
  const { createWorld, send, stateOf } = await import("../src/engine.ts");
  const m = loadModel(`
context: T
aggregates:
  A:
    creators: [Go]
    data: { x: { type: string } }
    initial: a
    states:
      a: { on: { Go: {}, Set: { assign: { x: command.x }, target: b } } }
      b: {}
`);
  const w = createWorld(m);
  send(w, "A#1.Go");
  send(w, "A#1.Set", {});                                     // no x
  assert.equal(stateOf(w, "A#1"), "a", "not half-applied");
  const f = w.log.find((e) => e.kind === "finding" && e.severity === "error");
  assert.ok(f && f.kind === "finding" && /was not applied — `x: command.x`: unknown reference `command.x`/.test(f.message));
  send(w, "A#1.Set", { x: "ok" });
  assert.equal(stateOf(w, "A#1"), "b", "and the run carries on");
});

test("an unquoted number or boolean in an assignment is the literal it reads as", async () => {
  const { loadModel } = await import("../src/model.ts");
  const { createWorld, send } = await import("../src/engine.ts");
  const m = loadModel(`
context: T
aggregates:
  A:
    creators: [Go]
    data: { n: { type: number, default: 0 }, ok: { type: boolean, default: false } }
    initial: a
    states:
      a: { on: { Go: { assign: { n: 2, ok: true } } } }
`);
  const w = createWorld(m);
  send(w, "A#1.Go");
  assert.deepEqual(w.aggregates["A#1"]!.data, { n: 2, ok: true });
  assert.throws(() => loadModel(`
context: T
aggregates:
  A:
    creators: [Go]
    initial: a
    states:
      a: { on: { Go: { assign: { n: [1] } } } }
`), /an assignment is an expression/);
});

test("a creating command no rule accepts creates nothing — no instance, no entry, no parent told (ADR 0021)", () => {
  const model = loadModel(`
context: T
aggregates:
  Basket:
    creators: [Open]
    children:
      items: { type: Item, via: command.basket }
    initial: open
    states:
      open:
        on:
          Open: {}
  Item:
    creators: [Add]
    references:
      basket: { type: Basket, via: command.basket }
    initial: added
    states:
      added:
        emit_on_entry: [ ItemSeen: { item: "\${id}" } ]
        on:
          Add: { guard: command.qty > 0 }
`);
  const world = createWorld(model);
  send(world, "Basket#B.Open");
  send(world, "Item#I1.Add", { basket: "B", qty: 0 });
  assert.equal(world.aggregates["Item#I1"], undefined, "refused: never created");
  assert.ok(world.log.some((e) => e.kind === "rejected" && e.instance === "Item#I1" && e.name === "Add"), "the refusal is said, with its guard");
  assert.ok(!world.log.some((e) => e.kind === "created" && e.instance === "Item#I1"));
  assert.ok(!world.log.some((e) => e.kind === "event" && e.event === "ItemSeen"), "no entry action ran");
  assert.equal(world.referrers["Basket#B"]?.length ?? 0, 0, "nothing points at the basket");
  assert.equal(world.children["Basket#B::items"]?.length ?? 0, 0, "the basket has no child");
  // Accepted, it is created as before; and a later, valid Add creates the one refused before.
  send(world, "Item#I1.Add", { basket: "B", qty: 2 });
  assert.equal(stateOf(world, "Item#I1"), "added");
  assert.equal(world.children["Basket#B::items"]?.length, 1);
  // A creator nothing handles in the initial state is unhandled — and creates nothing either.
  const bare = loadModel(`
context: T
aggregates:
  A:
    creators: [Make]
    initial: idle
    states:
      idle: {}
`);
  const w2 = createWorld(bare);
  send(w2, "A#1.Make");
  assert.equal(w2.aggregates["A#1"], undefined);
  assert.match((w2.log.find((e) => e.kind === "unhandled") as { reason: string }).reason, /nothing was created/);
});
