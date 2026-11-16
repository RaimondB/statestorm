import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "../src/model.ts";
import { advance, createWorld, fork, send, stateOf, type Schedule } from "../src/engine.ts";

const model = loadModel(readFileSync(new URL("../../examples/models/sales.yaml", import.meta.url), "utf8"));
const states = (w: ReturnType<typeof createWorld>) => Object.keys(w.aggregates).sort().map((k) => `${k}=${stateOf(w, k)}`);

for (const schedule of [{ kind: "fifo" }, { kind: "duplicate" }, { kind: "random", seed: 3 }] as Schedule[]) {
  test(`a forked world runs on exactly as the original would, and leaves it untouched (${schedule.kind})`, () => {
    const run = (w: ReturnType<typeof createWorld>) => {
      send(w, "Order#A1.Pay", { paymentId: "p1", amount: 100 });
      advance(w, 31 * 86_400_000);
    };
    const original = createWorld(model, "2026-01-01T09:00:00Z", schedule);
    send(original, "Order#A1.Place", { total: 100, items: ["widget", "gizmo"] });
    const at = { log: original.log.length, states: states(original), timers: original.timers.length };
    const branch = fork(original);
    run(branch);
    // The original did not move.
    assert.equal(original.log.length, at.log);
    assert.deepEqual(states(original), at.states);
    assert.equal(original.timers.length, at.timers);
    // Running the original on gives what the branch got — the same log, step for step.
    run(original);
    assert.deepEqual(branch.log, original.log);
    assert.deepEqual(states(branch), states(original));
  });
}
