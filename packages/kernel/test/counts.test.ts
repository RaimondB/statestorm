import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, send, stateOf } from "../src/engine.ts";

// ADR 0010: a parent that ends three ways once every child is final, decided by how many
// children ended which way.
const model = loadModel(`
context: T
aggregates:
  Task:
    creators: [Open]
    children: { items: { type: Item, via: command.task } }
    initial: open
    states:
      open:
        on: { Open: {} }
        on_children:
          items.all_final#done:    { guard: items.in.failed == 0, target: done }
          items.all_final#failed:  { guard: items.in.done == 0, target: failed }
          items.all_final#partial: { target: partly }
      done: { final: true }
      failed: { final: true }
      partly: { final: true }
  Item:
    creators: [Make]
    initial: waiting
    states:
      waiting: { on: { Make: {}, Pass: { target: done }, Fail: { target: failed } } }
      done: { final: true }
      failed: { final: true }
`);

function run(outcomes: ("Pass" | "Fail")[]) {
  const w = createWorld(model);
  send(w, "Task#t.Open");
  outcomes.forEach((_, i) => send(w, `Item#i${i}.Make`, { task: "t" }));
  outcomes.forEach((o, i) => send(w, `Item#i${i}.${o}`));
  return stateOf(w, "Task#t");
}

test("variants of one child trigger, decided by per-state counts", () => {
  assert.equal(run(["Pass", "Pass"]), "done");
  assert.equal(run(["Fail", "Fail"]), "failed");
  assert.equal(run(["Pass", "Fail"]), "partly");
});

test("the trigger is watched once however many variants it has", () => {
  assert.equal(model.aggregates.Task!.allChildTriggers.length, 1);
  const w = createWorld(model);
  send(w, "Task#t.Open");
  send(w, "Item#i0.Make", { task: "t" });
  send(w, "Item#i0.Pass");
  assert.equal(w.log.filter((e) => e.kind === "tally").length, 1);
});

test("a misspelt state in a count is an error the guard reports, not a quiet zero", () => {
  const bad = loadModel(`
context: T
aggregates:
  P:
    creators: [Open]
    children: { items: { type: I, via: command.p } }
    initial: open
    states:
      open:
        on: { Open: {} }
        on_children:
          items.all_final: { guard: items.in.faild == 0, target: done }
      done: { final: true }
  I: { creators: [Make], initial: a, states: { a: { on: { Make: {}, End: { target: b } } }, b: { final: true } } }
`);
  const w = createWorld(bad);
  send(w, "P#p.Open");
  send(w, "I#i.Make", { p: "p" });
  send(w, "I#i.End");
  assert.equal(stateOf(w, "P#p"), "open");
  assert.ok(w.log.some((e) => e.kind === "rejected" && e.chain.some((r) => /items\.in\.faild/.test(r.error ?? ""))),
    "the rejection chain names the dead reference");
});
