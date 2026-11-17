import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScenario } from "../src/run.ts";

// ADR 0029: scenarios that start from the same places include one shared set-up, written once.
const files: Record<string, string> = {
  "given/places.yaml": `
include: [clinics.yaml]
send:
  - Lab#LAB1.Register: { name: central lab }
`,
  "given/clinics.yaml": `
send:
  - Clinic#CLIN1.Register: { name: north clinic }
`,
  "given/loop.yaml": "include: [loop.yaml]\n",
  "given/odd.yaml": "at: 2026-01-01T00:00:00Z\nsend: []\n",
};
const read = (p: string) => files[p];

const scenario = (given: string) => `
scenario: s
given:
${given}
when: []
then: []
`;

test("the included set-ups' sends come first, each one's own includes before it, then the scenario's", () => {
  const sc = parseScenario(scenario(`  include: [given/places.yaml]\n  send:\n    - Request#R1.Create: { patient: P1 }`), "01.yaml", read);
  assert.deepEqual(sc.given.send.map((s) => s.ref), ["Clinic#CLIN1.Register", "Lab#LAB1.Register", "Request#R1.Create"]);
  assert.deepEqual(sc.given.include, ["given/places.yaml"]);
});

test("a path is the scenarios folder's, and may not leave it", () => {
  assert.throws(() => parseScenario(scenario(`  include: [../elsewhere.yaml]`), "01.yaml", read), /leaves the scenarios folder/);
  assert.throws(() => parseScenario(scenario(`  include: [given/none.yaml]`), "01.yaml", read), /no `given\/none.yaml`/);
  assert.throws(() => parseScenario(scenario(`  include: [given/places]`), "01.yaml", read), /a shared set-up is a .yaml file/);
});

test("a set-up that includes itself, or holds more than sends, is an error that says where", () => {
  assert.throws(() => parseScenario(scenario(`  include: [given/loop.yaml]`), "01.yaml", read), /given\/loop.yaml → given\/loop.yaml/);
  assert.throws(() => parseScenario(scenario(`  include: [given/odd.yaml]`), "01.yaml", read), /given\/odd.yaml: `at:` — a shared set-up holds only/);
});

test("read without its folder's files, a scenario that includes says so", () => {
  assert.throws(() => parseScenario(scenario(`  include: [given/places.yaml]`), "01.yaml"), /read without its folder's files/);
});
