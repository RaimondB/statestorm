import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "@statestorm/kernel";
import { livesOnOf, livesOnShape, staleLivesOn } from "../src/check/endstates.ts";

const model = (coverage: string) => loadModel(`
context: T
aggregates:
  Member:
    creators: [Join]
    initial: active
    states: { active: { on: { Join: {} } } }
${coverage}`);

test("lives_on names each type with its reason; a type the model lacks is stale", () => {
  const m = model("coverage:\n  lives_on: { Member: a member never finishes, Ghost: gone }\n");
  assert.deepEqual(livesOnOf(m), { Member: "a member never finishes", Ghost: "gone" });
  assert.deepEqual(staleLivesOn(m), ["Ghost"]);
  assert.equal(livesOnShape(m), undefined);
});

test("lives_on written as a list is said as the wrong shape, not read as types `0`, `1`", () => {
  const m = model("coverage:\n  lives_on: [Member]\n");
  assert.deepEqual(livesOnOf(m), {});
  assert.deepEqual(staleLivesOn(m), []);
  assert.match(livesOnShape(m) ?? "", /lives_on: \{ Member: <why> \}` — not a list/);
});
