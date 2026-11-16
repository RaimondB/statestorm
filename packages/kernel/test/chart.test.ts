import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { activeRefs, initialConfiguration, isFinalConfiguration, move, pathOf, refOf, resolveEntry } from "../src/chart.ts";

const model = loadModel(`
context: T
aggregates:
  A:
    creators: [Start]
    initial: idle
    states:
      idle: { on: { Start: { target: work } } }
      work:
        initial: one
        states:
          one: { on: { Next: { target: work.two } } }
          two: { final: true }
      done: { final: true }
`);
const A = model.aggregates.A!;

test("entering a composite follows initial down to a leaf", () => {
  assert.deepEqual(resolveEntry(A, pathOf("work")), ["work", "one"]);
  assert.deepEqual(initialConfiguration(A), [["idle"]]);
});

test("a configuration holds every active state, not just the leaf", () => {
  assert.deepEqual([...activeRefs(A, [["work", "one"]])], ["work", "work.one"]);
});

test("a transition between siblings exits only the substate", () => {
  const m = move(A, [["work", "one"]], pathOf("work.one"), "work.two");
  assert.deepEqual(m.exit.map((s) => refOf(s.path)), ["work.one"]);
  assert.deepEqual(m.enter.map((s) => refOf(s.path)), ["work.two"]);
});

test("a transition owned by the composite exits the substate and the composite", () => {
  const m = move(A, [["work", "one"]], pathOf("work"), "done");
  assert.deepEqual(m.exit.map((s) => refOf(s.path)), ["work.one", "work"]);
  assert.deepEqual(m.enter.map((s) => refOf(s.path)), ["done"]);
});

test("entering a composite from outside lands on its initial leaf", () => {
  const m = move(A, [["idle"]], pathOf("idle"), "work");
  assert.deepEqual(m.enter.map((s) => refOf(s.path)), ["work", "work.one"]);
  assert.deepEqual(m.to, ["work", "one"]);
});

test("finality is a property of the root region only (ADR 0005 §6)", () => {
  assert.equal(isFinalConfiguration(A, [["work", "two"]]), false, "a final leaf inside work is not done");
  assert.equal(isFinalConfiguration(A, [["done"]]), true);
});
