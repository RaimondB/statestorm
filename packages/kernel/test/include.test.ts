import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { modelFiles, ROOT } from "../src/include.ts";

// ADR 0019: a model in parts. A shop: the root names the context and includes the selling part,
// which includes the shipping part from a folder of its own.
const ROOT_TEXT = `
context: Shop
include: [model/selling.yaml]
overview: { roots: [Order] }
`;
const SELLING = `
include: [shipping/shipment.yaml]
aggregates:
  Thing:
    abstract: true
    initial: new
    states:
      new:
        on:
          Archive: { target: archived }
      archived: { final: true }
  Order:
    extends: Thing
    creators: [Place]
    states:
      new:
        on:
          Place: { emit: [ Placed: { order: "\${id}" } ] }
packages:
  Selling: [Thing, Order]
`;
const SHIPMENT = `
aggregates:
  Shipment:
    extends: Thing
    creators: [Prepare]
    states:
      new:
        on:
          Prepare: {}
policies:
  ship:
    on: Placed
    command: "Shipment#\${event.order}.Prepare"
packages:
  Shipping: [Shipment]
systems:
  Shop: { packages: [Selling] }
  Warehouse: { packages: [Shipping] }
relations:
  - { upstream: Shop, downstream: Warehouse, pattern: customer-supplier }
`;
const FILES = { [ROOT]: ROOT_TEXT, "model/selling.yaml": SELLING, "model/shipping/shipment.yaml": SHIPMENT };

test("a model in parts is one model: types, inheritance and policies across files, packages in the order read", () => {
  const m = loadModel(ROOT_TEXT, FILES);
  assert.deepEqual(Object.keys(m.aggregates).sort(), ["Order", "Shipment", "Thing"]);
  assert.deepEqual(m.aggregates.Shipment!.ancestors, ["Thing"], "a part's type refines one declared in another part");
  assert.ok(m.policies.ship);
  assert.deepEqual(m.packages.map((p) => p.name), ["Selling", "Shipping"]);
  assert.deepEqual(m.systems!.relations.map((r) => r.pattern), ["customer-supplier"]);
  assert.equal(m.sources!["aggregates.Shipment"], "model/shipping/shipment.yaml");
  assert.equal(m.sources!["policies.ship"], "model/shipping/shipment.yaml");
});

test("modelFiles follows the includes, each relative to the file that names it", () => {
  const disk: Record<string, string> = { ...FILES, "model/unrelated.yaml": "x: 1" };
  assert.deepEqual(Object.keys(modelFiles((p) => disk[p])).sort(), [ROOT, "model/selling.yaml", "model/shipping/shipment.yaml"]);
  assert.throws(() => modelFiles((p) => (p === "model/shipping/shipment.yaml" ? undefined : disk[p])),
    /model\/selling.yaml: include: `model\/shipping\/shipment.yaml` — no such file/);
});

test("a name declared twice says both files; the whole model's sections stay in model.yaml", () => {
  const twice = { ...FILES, "model/shipping/shipment.yaml": SHIPMENT.replace("  Shipment:", "  Order:\n    creators: [X]\n    initial: a\n    states: { a: {} }\n  Shipment:") };
  assert.throws(() => loadModel(ROOT_TEXT, twice), /aggregates.Order: declared in model\/selling.yaml and in model\/shipping\/shipment.yaml/);
  assert.throws(() => loadModel(ROOT_TEXT, { ...FILES, "model/selling.yaml": `context: Other\n${SELLING}` }),
    /model\/selling.yaml: `context` belongs in model.yaml/);
  assert.throws(() => loadModel(ROOT_TEXT, { ...FILES, "model/selling.yaml": `${SELLING}\nscreens: {}\n` }),
    /model\/selling.yaml: unknown section `screens`/);
});

test("a part included twice, in a circle, missing, or outside the model's folder is refused", () => {
  assert.throws(() => loadModel(ROOT_TEXT, { ...FILES, "model/shipping/shipment.yaml": `include: [../selling.yaml]\n${SHIPMENT}` }), /includes itself — model.yaml → model\/selling.yaml → model\/shipping\/shipment.yaml → model\/selling.yaml/);
  assert.throws(() => loadModel(`${ROOT_TEXT.replace("include: [model/selling.yaml]", "include: [model/selling.yaml, model/shipping/shipment.yaml]")}`, FILES), /is included twice/);
  assert.throws(() => loadModel(ROOT_TEXT), /model.yaml: include: `model\/selling.yaml` — no such file/);
  assert.throws(() => loadModel("context: X\ninclude: [../elsewhere.yaml]\n", {}), /leaves the model's folder/);
});

test("an error in a part names the part", () => {
  const broken = { ...FILES, "model/shipping/shipment.yaml": SHIPMENT.replace("    creators: [Prepare]", "    creators: [Prepare]\n    initial: nowhere") };
  assert.throws(() => loadModel(ROOT_TEXT, broken), /Shipment: the initial state is inherited from Thing \(`new`\) and cannot change \(in model\/shipping\/shipment.yaml\)$/);
  // One file: said as before.
  assert.throws(() => loadModel("context: X\naggregates:\n  A:\n    creators: [P]\n    initial: z\n    states: { a: { on: { P: {} } } }\n"), / A: `initial` must name a top-level state$/);
});
