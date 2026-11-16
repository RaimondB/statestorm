import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, send } from "../src/engine.ts";

// ADR 0015: a list of value objects as a field — a set, one row per key, changed by `put:`.
const MODEL = `
context: T
values:
  Instruction: { kind: string, detail: string }
aggregates:
  Order:
    creators: [Plan]
    data:
      instructions: { type: [Instruction], key: kind }
    initial: open
    states:
      open:
        on:
          Plan: {}
          Instruct:
            takes: Instruction
            put: { instructions: { kind: command.kind, detail: command.detail } }
          Replace: { assign: { instructions: command.rows } }
`;
const model = loadModel(MODEL);
const rows = (w: ReturnType<typeof createWorld>) => w.aggregates["Order#O1"]!.data.instructions;

test("put adds a row, replaces the row with the same key, and a repeat changes nothing", () => {
  const w = createWorld(model);
  send(w, "Order#O1.Plan", {});
  assert.deepEqual(rows(w), [], "empty to begin with");
  send(w, "Order#O1.Instruct", { kind: "pin", detail: "1111" });
  send(w, "Order#O1.Instruct", { kind: "room_of_choice", detail: "kitchen" });
  send(w, "Order#O1.Instruct", { kind: "pin", detail: "1111" });
  assert.deepEqual(rows(w), [{ kind: "pin", detail: "1111" }, { kind: "room_of_choice", detail: "kitchen" }], "the repeat is the same row");
  send(w, "Order#O1.Instruct", { kind: "pin", detail: "2222" });
  assert.deepEqual(rows(w), [{ kind: "pin", detail: "2222" }, { kind: "room_of_choice", detail: "kitchen" }], "same kind: replaced in place");
  assert.equal(model.findings.length, 0, "no accumulation warning: put cannot grow on a repeat");
});

test("a list replaced whole must be rows of the value, one per key", () => {
  const w = createWorld(model);
  send(w, "Order#O1.Plan", {});
  send(w, "Order#O1.Replace", { rows: [{ kind: "pin", detail: "1" }, { kind: "pin", detail: "2" }] });
  const err = w.log.filter((e) => e.kind === "finding" && e.severity === "error").map((e) => (e as { message: string }).message);
  assert.match(err[0]!, /two rows with the same kind/);
  assert.deepEqual(rows(w), [], "not applied");
  send(w, "Order#O1.Replace", { rows: [{ kind: "pin", detail: "1" }] });
  assert.deepEqual(rows(w), [{ kind: "pin", detail: "1" }]);
});

test("the loader refuses a list without a key, a put into anything else, a row that is not the value, and growing it by assign", () => {
  assert.throws(() => loadModel(MODEL.replace("{ type: [Instruction], key: kind }", "{ type: [Instruction] }")), /needs `key:`/);
  assert.throws(() => loadModel(MODEL.replace("{ type: [Instruction], key: kind }", "{ type: [Nope], key: kind }")), /`Nope` is not one/);
  assert.throws(() => loadModel(MODEL.replace("put: { instructions:", "put: { other:")), /put goes into a list field/);
  assert.throws(() => loadModel(MODEL.replace("{ kind: command.kind, detail: command.detail }", "{ kind: command.kind }")), /detail is missing/);
  assert.throws(() => loadModel(MODEL.replace("assign: { instructions: command.rows }", "assign: { instructions: \"instructions + command.rows\" }")), /change one row with `put:`/);
});
