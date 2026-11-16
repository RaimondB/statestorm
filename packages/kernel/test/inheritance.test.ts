import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { activeOf, createWorld, send, stateOf } from "../src/engine.ts";
import { ModelError } from "../src/types.ts";

// A miniature of a real domain's shape: an abstract Activity whose roll-up is written once, two
// subclasses that refine it differently, and a parent that rolls up a mix of them.
const model = loadModel(`
context: T
aggregates:
  Plan:
    creators: [Open]
    children:
      steps: { type: Activity, via: command.plan }
    initial: open
    states:
      open:
        on: { Open: {} }
        on_children:
          steps.all_final: { target: done }
      done: { final: true }

  Activity:
    abstract: true
    creators: [Start]
    data: { label: { type: string } }
    initial: created
    states:
      created:
        on:
          Start: { assign: { label: command.label } }
          Begin: { target: in_progress }
      in_progress:
        on:
          Finish: { target: completed }
      completed: { final: true }

  Visit:
    extends: Activity
    states:
      in_progress:                       # refining an inherited leaf
        initial: arriving
        states:
          arriving: { on: { Arrive: { target: in_progress.on_site } } }
          on_site: {}

  Hop:
    extends: Activity
    data: { carrier: { type: string } }
    states:
      created:
        on:
          Start: { assign: { label: command.label, carrier: command.carrier } }   # overrides
`);

test("a subclass inherits states and rules, and refines an inherited leaf into substates", () => {
  const w = createWorld(model);
  send(w, "Visit#v1.Start", { plan: "P1", label: "x" });
  send(w, "Visit#v1.Begin");
  assert.equal(stateOf(w, "Visit#v1"), "in_progress.arriving");
  send(w, "Visit#v1.Arrive");
  assert.ok(activeOf(w, "Visit#v1").has("in_progress"), "a refined state is still the inherited state");
  send(w, "Visit#v1.Finish");
  assert.equal(stateOf(w, "Visit#v1"), "completed", "the inherited Finish applies from inside the refinement");
});

test("an inherited rule is marked as such, and a subclass rule with the same key overrides it", () => {
  const visitStart = model.aggregates.Visit!.states.created!.on.Start![0]!;
  const hopStart = model.aggregates.Hop!.states.created!.on.Start![0]!;
  assert.equal(visitStart.inheritedFrom, "Activity");
  assert.equal(hopStart.inheritedFrom, undefined);
  assert.deepEqual(Object.keys(hopStart.assign), ["label", "carrier"]);
  assert.deepEqual(model.aggregates.Hop!.ancestors, ["Activity"]);
});

test("a parent rolls up a mix of subclasses through one relation to the abstract type", () => {
  const w = createWorld(model);
  send(w, "Plan#P1.Open");
  send(w, "Visit#v1.Start", { plan: "P1", label: "a" });
  send(w, "Hop#h1.Start", { plan: "P1", label: "b", carrier: "c" });
  assert.deepEqual(w.children["Plan#P1::steps"], ["Visit#v1", "Hop#h1"]);
  for (const k of ["Visit#v1", "Hop#h1"]) { send(w, `${k}.Begin`); send(w, `${k}.Finish`); }
  assert.equal(stateOf(w, "Plan#P1"), "done");
});

test("an abstract type has no instances, and saying so is an error, not a creation", () => {
  const w = createWorld(model);
  send(w, "Activity#a1.Start", { plan: "P1", label: "x" });
  assert.equal(stateOf(w, "Activity#a1"), undefined);
  assert.ok(w.log.some((e) => e.kind === "finding" && e.severity === "error" && /is abstract/.test(e.message)));
});

const base = `
context: T
aggregates:
  Activity:
    abstract: true
    creators: [Go]
    initial: a
    states:
      a: { on: { Go: {} } }
      b: { final: true }
      c:
        initial: c1
        states: { c1: {} }
`;

for (const [what, sub, message] of [
  ["a state beside the inherited ones", "states: { z: {} }", /`z` is not a state of Activity/],
  ["a substate beside an inherited composite's own", "states: { c: { states: { c2: {} } } }", /`c2` is not a state of Activity/],
  ["making an inherited state non-final", "states: { b: { final: false } }", /cannot make an inherited state non-final/],
  ["refining a final state", "states: { b: { initial: x, states: { x: {} } } }", /a final state cannot be refined/],
  ["changing an inherited initial", "states: { c: { initial: c9 } }", /initial substate is inherited/],
  ["changing the initial state", "initial: b", /initial state is inherited/],
] as const) {
  test(`refinement is enforced: ${what} is a load error`, () => {
    assert.throws(() => loadModel(`${base}
  Sub:
    extends: Activity
    ${sub}
`), (e: unknown) => e instanceof ModelError && message.test(e.message));
  });
}

test("only abstract types are extended, and cycles are caught", () => {
  assert.throws(() => loadModel(`
context: T
aggregates:
  A: { creators: [Go], initial: a, states: { a: {} } }
  B: { extends: A }
`), /which is not abstract/);
  assert.throws(() => loadModel(`
context: T
aggregates:
  A: { abstract: true, extends: B, initial: a, states: { a: {} } }
  B: { abstract: true, extends: A, initial: a, states: { a: {} } }
  C: { extends: A, creators: [Go] }
`), /inheritance cycle/);
});

test("a quantifier over a state the children cannot be in is a load error", () => {
  assert.throws(() => loadModel(`
context: T
aggregates:
  P:
    creators: [Go]
    children: { kids: { type: K, via: command.p } }
    initial: a
    states:
      a:
        on_children:
          kids.any(shipd): { target: b }
      b: {}
  K: { creators: [Go], initial: x, states: { x: {}, shipped: {} } }
`), /`shipd` is not a state of K/);
});

// ADR 0009 §3: a relation declared on an abstract parent is shared by every concrete
// parent type, so the child's `via` names the parent by key.
const tasks = loadModel(`
context: T
aggregates:
  Activity:
    abstract: true
    creators: [Go]
    children:
      tasks: { type: Task, via: command.activity }
    initial: open
    states:
      open:
        on: { Go: {} }
        on_children:
          tasks.all_final: { target: done }
      done: { final: true }
  Visit: { extends: Activity }
  Hop:   { extends: Activity }
  Task:
    creators: [Go]
    initial: todo
    states:
      todo: { on: { Go: {}, Do: { target: did } } }
      did: { final: true }
`);

test("one relation on an abstract parent serves every subclass: the key says which parent", () => {
  const w = createWorld(tasks);
  send(w, "Visit#x.Go");
  send(w, "Hop#x.Go");
  send(w, "Task#t1.Go", { activity: "Hop#x" });
  send(w, "Task#t1.Do");
  assert.equal(stateOf(w, "Hop#x"), "done");
  assert.equal(stateOf(w, "Visit#x"), "open", "same id, other type: not the parent");
});

test("a bare id where a key is needed is an error naming the parent types it could be", () => {
  const w = createWorld(tasks);
  send(w, "Task#t1.Go", { activity: "x" });
  const f = w.log.find((e) => e.kind === "finding" && e.severity === "error");
  assert.ok(f && f.kind === "finding" && /must yield the parent's key — one of Visit#…, Hop#…/.test(f.message), f && "message" in f ? f.message : "");
});
