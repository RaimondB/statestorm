import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { outOfScope, parseAgenda, resolveScenario, stepsOf } from "../src/agenda.ts";

const LAB = new URL("../../examples/", import.meta.url);
const files = readdirSync(new URL("scenarios/lab/", LAB)).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort();

test("a scenario is named by its number or its whole file name", () => {
  assert.equal(resolveScenario("03", files), "03-missing-on-delivery-then-found");
  assert.equal(resolveScenario("03-missing-on-delivery-then-found.yaml", files), "03-missing-on-delivery-then-found");
  assert.equal(resolveScenario("99", files), undefined);
});

test("the lab's agenda reads: its items in order, each scenario a step in the agenda's view", () => {
  const { agenda, errors } = parseAgenda(readFileSync(new URL("agendas/lab/ward-review.yaml", LAB), "utf8"), "ward-review.yaml", files);
  assert.deepEqual(errors, []);
  assert.equal(agenda!.name, "ward-review");
  assert.equal(agenda!.date, "2026-11-20");
  assert.deepEqual(agenda!.items.map((i) => i.scenarios.length), [2, 3, 1]);
  const steps = stepsOf(agenda!);
  assert.equal(steps.length, 6);
  assert.deepEqual(steps[2], { item: 1, at: 0, file: "02-haemolysed-at-the-lab", view: "overview" });
  assert.deepEqual(agenda!.items[1]!.questions, ["Q-1"]);
});

test("what is wrong is said, and the rest still reads", () => {
  const { agenda, errors } = parseAgenda([
    "title: T", "colour: red", "view: nowhere",
    "items:", "  - title: A", "    scenarios: [01, 99]", "  - scenarios: []",
  ].join("\n"), "x.yaml", files);
  assert.ok(errors.some((e) => e.includes("unknown key `colour`")));
  assert.ok(errors.some((e) => e.includes("view `nowhere`")));
  assert.ok(errors.some((e) => e.includes("no scenario `99`")));
  assert.ok(errors.some((e) => e.includes("item 2: no title")));
  assert.ok(errors.some((e) => e.includes("no scenarios")));
  assert.deepEqual(agenda!.items[0]!.scenarios, ["01-two-tubes-to-the-lab"]);
  assert.equal(agenda!.view, "overview");
});

test("a scenario outside the agenda's scope is a warning", () => {
  const { agenda } = parseAgenda("title: T\nscope: [phase-1]\nitems:\n  - title: A\n    scenarios: [01, 02]\n", "x.yaml", files);
  const w = outOfScope(agenda!, (f) => (f.startsWith("01") ? ["happy", "phase-1"] : ["deviation", "phase-4"]));
  assert.equal(w.length, 1);
  assert.match(w[0]!, /02-haemolysed-at-the-lab carries none of the agenda's scope \(phase-1\) — tagged deviation, phase-4/);
});
