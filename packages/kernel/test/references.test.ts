import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, send, stateOf, type World } from "../src/engine.ts";
import { ModelError } from "../src/types.ts";

// The shape ADR 0007 exists for: a unit scanned somewhere must reach every handling that
// points at it, while the unit itself knows nothing about them.
const model = loadModel(`
context: T
aggregates:
  Unit:
    creators: [Register]
    initial: known
    states:
      known:
        on:
          Register: {}
          Scan:
            idempotency: command.scanId
            emit: [ Scanned: { node: "\${command.node}" } ]
  Handling:
    creators: [Expect]
    references:
      unit: { type: Unit, via: command.unit }
    data: { node: { type: string } }
    initial: expected
    states:
      expected:
        on:
          Expect: { assign: { node: command.node } }
          Scanned:
            guard: command.node == node
            target: done
      done: { final: true }
policies:
  route:
    on: Scanned
    for_each_referrer: Handling.unit
    command: "\${item}.Scanned"
    with: { node: "\${event.node}" }
`);

function world(): World {
  const w = createWorld(model);
  send(w, "Unit#U1.Register");
  send(w, "Unit#U2.Register");
  send(w, "Handling#here-U1.Expect", { unit: "U1", node: "here" });
  send(w, "Handling#there-U1.Expect", { unit: "U1", node: "there" });
  send(w, "Handling#here-U2.Expect", { unit: "U2", node: "here" });
  return w;
}

test("the kernel indexes references the other way round; the unit holds nothing", () => {
  const w = world();
  assert.deepEqual(w.referrers["Unit#U1"]!.map((r) => r.key), ["Handling#here-U1", "Handling#there-U1"]);
  assert.deepEqual(w.aggregates["Unit#U1"]!.refs, {});
  assert.equal(w.aggregates["Handling#here-U1"]!.refs.unit, "Unit#U1");
});

test("a scan reaches every handling pointing at that unit, and only those", () => {
  const w = world();
  send(w, "Unit#U1.Scan", { scanId: "s1", node: "here" });
  assert.equal(stateOf(w, "Handling#here-U1"), "done");
  assert.equal(stateOf(w, "Handling#there-U1"), "expected", "the guard decides what the scan means to it");
  assert.equal(stateOf(w, "Handling#here-U2"), "expected", "another unit's handling is never even asked");
});

test("a referrer with no answer ignores the broadcast — logged, but not as a refusal", () => {
  const w = world();
  send(w, "Unit#U1.Scan", { scanId: "s1", node: "here" });
  const ignored = w.log.filter((e) => e.kind === "ignored");
  assert.deepEqual(ignored.map((e) => e.kind === "ignored" && e.instance), ["Handling#there-U1"]);
  assert.ok(!w.log.some((e) => e.kind === "rejected" || e.kind === "unhandled"));
  const first = ignored[0]!;
  assert.ok(first.kind === "ignored" && first.chain?.[0]?.values.includes('node="there"'), "why it did not apply is kept");
});

test("a scan of a unit nobody points at reaches no one, and says so", () => {
  const w = createWorld(model);
  send(w, "Unit#U9.Register");
  send(w, "Unit#U9.Scan", { scanId: "s1", node: "here" });
  const said = w.log.filter((e) => e.kind === "finding" && e.severity === "warning" && /nothing points at it/.test(e.message));
  assert.equal(said.length, 1);
});

test("a unit that one kind of referrer points at, and another does not, raises nothing", () => {
  const two = loadModel(`
context: T
aggregates:
  Unit:
    creators: [Go]
    initial: a
    states: { a: { on: { Go: { emit: [ E ] } } } }
  A: { creators: [Go], references: { u: { type: Unit, via: command.u } }, initial: a, states: { a: { on: { Go: {}, E: { target: b } } }, b: {} } }
  B: { creators: [Go], references: { u: { type: Unit, via: command.u } }, initial: a, states: { a: { on: { Go: {} } } } }
policies:
  to_a: { on: E, for_each_referrer: A.u, command: "\${item}.E" }
  to_b: { on: E, for_each_referrer: B.u, command: "\${item}.E" }
`);
  const w = createWorld(two);
  send(w, "A#a1.Go", { u: "U1" });
  send(w, "Unit#U1.Go");
  assert.equal(stateOf(w, "A#a1"), "b");
  assert.ok(!w.log.some((e) => e.kind === "finding"), "B not pointing at U1 is normal, not a no-op");
});

test("under redelivery a broadcast is still harmless: a repeat lands where nothing answers", () => {
  const w = createWorld(model, undefined, { kind: "duplicate" });
  send(w, "Unit#U1.Register");
  send(w, "Handling#here-U1.Expect", { unit: "U1", node: "here" });
  send(w, "Unit#U1.Scan", { scanId: "s1", node: "here" });
  assert.equal(stateOf(w, "Handling#here-U1"), "done");
  assert.ok(w.log.some((e) => e.kind === "duplicate"), "the scan's own key caught the repeated scan");
});

test("a fan-out to a reference that does not exist is a load error, not a quiet nothing", () => {
  assert.throws(() => loadModel(`
context: T
aggregates:
  Unit: { creators: [Go], initial: a, states: { a: { on: { Go: { emit: [ E ] } } } } }
policies:
  p: { on: E, for_each_referrer: Unit.nope, command: "\${item}.Go" }
`), (e: unknown) => e instanceof ModelError && /no reference called `nope`/.test(e.message));
  assert.throws(() => loadModel(`
context: T
aggregates:
  Unit: { creators: [Go], initial: a, references: { u: { type: Unit } }, states: { a: {} } }
`), /needs `via`/);
});

test("two parent relations reading the same field are a load error: a child could never choose", () => {
  assert.throws(() => loadModel(`
context: T
aggregates:
  A: { creators: [Go], children: { ts: { type: T, via: command.p } }, initial: x, states: { x: {} } }
  B: { creators: [Go], children: { ts: { type: T, via: command.p } }, initial: x, states: { x: {} } }
  T: { creators: [Go], initial: x, states: { x: {} } }
`), /T is declared as children by A.ts and B.ts, both `via: command.p`/);
});

test("with different fields, the creating command picks its parent — exactly one, or it says so", () => {
  const m = loadModel(`
context: T
aggregates:
  A: { creators: [Go], children: { ts: { type: T, via: command.a } }, initial: x, states: { x: { on: { Go: {} } } } }
  B: { creators: [Go], children: { ts: { type: T, via: command.b } }, initial: x, states: { x: { on: { Go: {} } } } }
  T: { creators: [Go], initial: x, states: { x: { on: { Go: {} } } } }
`);
  const w = createWorld(m);
  send(w, "T#t1.Go", { b: "1" });
  assert.deepEqual(w.aggregates["T#t1"]!.parent, { rel: "ts", key: "B#1" });
  send(w, "T#t2.Go", { a: "1", b: "1" });
  send(w, "T#t3.Go", {});
  const errors = w.log.flatMap((e) => (e.kind === "finding" && e.severity === "error" ? [e.message] : []));
  assert.match(errors[0]!, /T#t2: the creating command names more than one parent/);
  assert.match(errors[1]!, /T#t3: cannot correlate to a parent/);
  assert.equal(w.aggregates["T#t2"]!.parent, undefined, "an ambiguous child is linked to neither, not to a guess");
});

test("a fan-out can name the instance pointed at, when it is not the raiser (§8)", () => {
  const m = loadModel(`
context: T
aggregates:
  Unit: { creators: [Go], initial: a, states: { a: { on: { Go: {} } } } }
  Leg:
    creators: [Go]
    references: { unit: { type: Unit, via: command.unit } }
    initial: a
    states:
      a: { on: { Go: {}, Done: { target: b, emit: [ LegDone: { unit: "\${unit}" } ] } } }
      b: {}
  Order:
    creators: [Go]
    references: { unit: { type: Unit, via: command.unit } }
    initial: a
    states:
      a: { on: { Go: {}, LegDone: { target: b } } }
      b: {}
policies:
  mirror:
    on: LegDone
    for_each_referrer: { via: Order.unit, of: "\${event.unit}" }
    command: "\${item}.LegDone"
`);
  const w = createWorld(m);
  send(w, "Unit#U1.Go");
  send(w, "Leg#l1.Go", { unit: "U1" });
  send(w, "Order#o1.Go", { unit: "U1" });
  send(w, "Order#o2.Go", { unit: "U2" });
  send(w, "Leg#l1.Done");
  assert.equal(stateOf(w, "Order#o1"), "b", "the order pointing at U1 follows the leg");
  assert.equal(stateOf(w, "Order#o2"), "a");
  assert.throws(() => loadModel(`
context: T
aggregates:
  Unit: { creators: [Go], initial: a, states: { a: { on: { Go: { emit: [ E ] } } } } }
  O: { creators: [Go], references: { u: { type: Unit, via: command.u } }, initial: a, states: { a: {} } }
policies:
  p: { on: E, for_each_referrer: { via: O.u }, command: "\${item}.Go" }
`), /needs `of`/);
});
