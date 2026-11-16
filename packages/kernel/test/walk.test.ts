import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, send, type World } from "../src/engine.ts";
import { ModelError } from "../src/types.ts";

// ADR 0026: a route's stops and the hops between them, published as two lists in no particular
// order; each step that is one follows the step before it — two in a row, in the route's order.
const model = loadModel(`
context: T
values:
  Stop: { at: number, name: string, step: string }
  Hop: { at: number, name: string, step: string }
aggregates:
  Route:
    creators: [Publish]
    initial: published
    states:
      published:
        on:
          Publish:
            takes: { stops: [Stop], hops: [Hop] }
            emit: [ Published: { route: "\${id}", stops: "\${command.stops}", hops: "\${command.hops}" } ]
  Link:
    creators: [Plan]
    data: { before: { type: string }, after: { type: string } }
    initial: planned
    states:
      planned:
        on:
          Plan: { assign: { before: command.before, after: command.after } }
policies:
  link_steps:
    on: Published
    for_each: [event.stops, event.hops]
    order: at
    where: "item.step != ''"
    pairs: true
    command: "Link#\${event.route}-\${previous.name}-\${item.name}.Plan"
    with: { before: "\${previous.step}", after: "\${item.step}" }
`);

function links(w: World): string[] {
  return w.log.filter((e) => e.kind === "created" && e.instance.startsWith("Link#")).map((e) => (e as { instance: string }).instance).sort();
}

test("a walk merges its lists, goes in the order of a field, keeps what `where` holds for, two in a row", () => {
  const w = createWorld(model);
  send(w, "Route#R1.Publish", {
    // a first stop, a place that is no step, a second stop — in no order
    stops: [{ at: 6, name: "stop2", step: "D2" }, { at: 2, name: "stop1", step: "D1" }, { at: 4, name: "place", step: "" }],
    // the hop out to the place is no step; the drive is one
    hops: [{ at: 5, name: "drive", step: "L1" }, { at: 3, name: "out", step: "" }],
  });
  assert.deepEqual(links(w), ["Link#R1-drive-stop2", "Link#R1-stop1-drive"]);
  assert.ok(!w.log.some((e) => e.kind === "finding"));
});

test("an item without the order's number is loud, not walked out of order", () => {
  const loose = loadModel(`
context: T
aggregates:
  Route:
    creators: [Publish]
    initial: p
    states: { p: { on: { Publish: { emit: [ Published: { route: "\${id}", stops: "\${command.stops}" } ] } } } }
  Link: { creators: [Plan], initial: planned, states: { planned: { on: { Plan: {} } } } }
policies:
  link_steps:
    on: Published
    for_each: event.stops
    order: at
    pairs: true
    command: "Link#\${previous.name}-\${item.name}.Plan"
`);
  const w = createWorld(loose);
  send(w, "Route#R2.Publish", { stops: [{ at: 1, name: "a" }, { at: "two", name: "b" }] });
  assert.equal(links(w).length, 0);
  const said = w.log.filter((e) => e.kind === "finding" && e.severity === "error").map((e) => (e as { message: string }).message);
  assert.ok(said.some((m) => /an item has no number `at` to walk in order by/.test(m)), said.join("\n"));
});

test("one item is no pair; a walk's keys without for_each are a mistake said at load", () => {
  const w = createWorld(model);
  send(w, "Route#R3.Publish", { stops: [{ at: 1, name: "a", step: "A" }], hops: [] });
  assert.equal(links(w).length, 0);
  assert.throws(() => loadModel(`
context: T
aggregates:
  A: { creators: [Go], initial: a, states: { a: { on: { Go: { emit: [ E ] } } } } }
policies:
  p: { on: E, pairs: true, command: "A#x.Go" }
`), (e: unknown) => e instanceof ModelError && /there is no `for_each`/.test(e.message));
});
