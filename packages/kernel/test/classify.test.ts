import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, send, stateOf } from "../src/engine.ts";

// ADR 0011: an activity whose outcome is decided by its *final* tasks, however many it has.
const model = loadModel(`
context: T
aggregates:
  Activity:
    creators: [Open]
    children:
      tasks: { type: Task, via: command.activity, classify: { by: stage, values: [start, final] } }
    initial: open
    states:
      open:
        on: { Open: {} }
        on_children:
          tasks.all_final#ok:      { guard: tasks.in.failed == 0, target: completed }
          tasks.all_final#failed:  { guard: tasks.stage.final.in.done == 0, target: failed }
          tasks.all_final#partial: { target: partly }
      completed: { final: true }
      failed: { final: true }
      partly: { final: true }
  Task:
    creators: [Make]
    data: { stage: { type: string } }
    initial: waiting
    states:
      waiting: { on: { Make: { assign: { stage: command.stage } }, Pass: { target: done }, Fail: { target: failed } } }
      done: { final: true }
      failed: { final: true }
`);

function run(tasks: [stage: string, outcome: "Pass" | "Fail"][]) {
  const w = createWorld(model);
  send(w, "Activity#a.Open");
  tasks.forEach(([stage], i) => send(w, `Task#t${i}.Make`, { activity: "a", stage }));
  tasks.forEach(([, o], i) => send(w, `Task#t${i}.${o}`));
  return { state: stateOf(w, "Activity#a"), w };
}

test("the final class decides: a start that worked does not save a final that failed", () => {
  assert.equal(run([["start", "Pass"], ["final", "Fail"]]).state, "failed");
  assert.equal(run([["start", "Fail"], ["final", "Pass"]]).state, "partly");
  assert.equal(run([["start", "Pass"], ["final", "Pass"]]).state, "completed");
});

test("several tasks in a class count together", () => {
  assert.equal(run([["start", "Pass"], ["start", "Pass"], ["final", "Fail"], ["final", "Pass"]]).state, "partly");
  assert.equal(run([["start", "Pass"], ["final", "Fail"], ["final", "Fail"]]).state, "failed");
});

test("an empty class is zero, not missing", () => {
  // No final tasks at all: `tasks.stage.final.in.done` is 0, so the rule can be read.
  assert.equal(run([["start", "Fail"]]).state, "failed");
});

test("a class nobody declared is reported once, not counted nowhere in silence", () => {
  const { w } = run([["middle", "Pass"]]);
  const said = w.log.filter((e) => e.kind === "finding" && e.severity === "warning" && /does not declare/.test(e.message));
  assert.equal(said.length, 1);
});

test("classifying by a field the children do not have is a load error", () => {
  assert.throws(() => loadModel(`
context: T
aggregates:
  P: { creators: [Go], children: { ts: { type: C, via: command.p, classify: { by: stag, values: [a] } } }, initial: x, states: { x: {} } }
  C: { creators: [Go], data: { stage: { type: string } }, initial: x, states: { x: {} } }
`), /classified by `stag`, which is not a data field of C/);
});
