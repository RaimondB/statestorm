import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel, stateOf } from "@statestorm/kernel";
import { emptyForm, fromPayload, payloadShape, toPayload } from "../src/payload.ts";
import { play } from "../src/session.ts";

const examples = new URL("../../examples/", import.meta.url);
const sales = loadModel(readFileSync(new URL("models/sales.yaml", examples), "utf8"));
const claims = loadModel(readFileSync(new URL("models/claims.yaml", examples), "utf8"));
const fifo = { kind: "fifo" } as const;

// Order lines as objects: the case where a row has columns.
const lines = loadModel(`
context: T
aggregates:
  Order:
    creators: [Place]
    children: { lines: { type: Line, via: command.orderId } }
    initial: open
    states:
      open:
        on:
          Place: { emit: [ Placed: { orderId: "\${id}", lines: "\${command.lines}" } ] }
  Line:
    creators: [Create]
    data: { sku: { type: string }, qty: { type: number } }
    initial: open
    states:
      open: { on: { Create: { assign: { sku: command.sku, qty: command.qty } } } }
policies:
  fan:
    on: Placed
    for_each: event.lines
    command: "Line#\${event.orderId}-\${item.sku}.Create"
    with: { orderId: "\${event.orderId}", sku: "\${item.sku}", qty: "\${item.qty}" }
`);

test("a field an event carries into a fan-out is a list, and the fan-out names the child", () => {
  assert.deepEqual(payloadShape(sales, "Order", "Place"), [
    { kind: "scalar", name: "total", type: "number" },
    { kind: "list", name: "items", child: "OrderLine", policy: "explode_order_into_lines", columns: [], rowType: "string" },
  ]);
});

test("a row with columns takes each column's type from the child command it feeds", () => {
  assert.deepEqual(payloadShape(lines, "Order", "Place")[0], {
    kind: "list", name: "lines", child: "Line", policy: "fan", rowType: "any",
    columns: [{ name: "sku", type: "string" }, { name: "qty", type: "number" }],
  });
});

test("scalar types come from arithmetic, comparisons, typed assignments and identities", () => {
  assert.deepEqual(payloadShape(sales, "Order", "Pay").map((f) => [f.name, f.kind === "scalar" && f.type]).sort(),
    [["amount", "number"], ["paymentId", "string"]]);
  assert.deepEqual(payloadShape(claims, "Claim", "DocumentsReceived").map((f) => [f.name, f.kind === "scalar" && f.type]).sort(),
    [["batchId", "string"], ["count", "number"]], "a keyed, additive command: the key is an identity");
  assert.deepEqual(payloadShape(sales, "OrderLine", "Create").map((f) => [f.name, f.kind === "scalar" && f.type]).sort(),
    [["orderId", "string"], ["sku", "string"]], "orderId is read by the parent's via:, and is an id");
  assert.deepEqual(payloadShape(sales, "Order", "Cancel"), []);
});

test("blank rows and blank fields are left out, and blank fields are reported", () => {
  const shape = payloadShape(sales, "Order", "Place");
  const { payload, missing } = toPayload(shape, { total: "", items: [{ "": "widget" }, { "": "  " }, { "": "gizmo" }] });
  assert.deepEqual(payload, { items: ["widget", "gizmo"] });
  assert.deepEqual(missing, ["total"]);
});

test("a typed cell that does not parse is an error, not a silent string", () => {
  const shape = payloadShape(lines, "Order", "Place");
  assert.throws(() => toPayload(shape, { lines: [{ sku: "w", qty: "two" }] }), /lines row 1 qty must be a number/);
});

test("the grid's rows become real children, with typed data", () => {
  const shape = payloadShape(lines, "Order", "Place");
  const { payload } = toPayload(shape, { lines: [{ sku: "w", qty: "2" }, { sku: "g", qty: "5" }] });
  const run = play(lines, [{ kind: "send", ref: "Order#A.Place", payload }], fifo);
  assert.deepEqual(run.world.aggregates["Line#A-g"]!.data, { sku: "g", qty: 5 });
  assert.equal(stateOf(run.world, "Line#A-w"), "open");
});

test("YAML and form round-trip, so switching editors keeps what was typed", () => {
  const shape = payloadShape(lines, "Order", "Place");
  const payload = { lines: [{ sku: "w", qty: 2 }] };
  assert.deepEqual(toPayload(shape, fromPayload(shape, payload)).payload, payload);
  assert.deepEqual(emptyForm(shape), { lines: [{}] });
});

const lab = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8"));

test("a field only ever compared with fixed names is a choice, not free text", () => {
  const event = payloadShape(lab, "Sample", "Scan").find((f) => f.name === "event");
  // Which choices, not their order: that follows whichever rule names them first.
  assert.ok(event?.kind === "scalar" && event.type === "string");
  assert.deepEqual(event.kind === "scalar" && [...(event.options ?? [])].sort(), [
    "Collected", "Packed", "PickedUp", "Delivered", "Received", "Rejected", "Queued", "Analysed", "Released", "Haemolysed", "Missing",
  ].sort());
});

test("a list passed on whole through several hops — through sends inside the aggregate — is still found, and its rows are sample ids", () => {
  const samples = payloadShape(lab, "SiteVisit", "Plan").find((f) => f.name === "samples");
  assert.equal(samples?.kind, "list");
  assert.ok(samples?.kind === "list" && samples.refersTo === "Sample" && samples.child === "SiteHandling" && samples.columns.length === 0);
  // Rows of a declared value object (TubeRow), in its order and with its types; inference adds
  // what a declaration cannot say — that `sample` is the id of a Sample.
  const tubes = payloadShape(lab, "Route", "Plan").find((f) => f.name === "tubes");
  assert.ok(tubes?.kind === "list", "the route's tubes are a grid");
  assert.deepEqual(tubes.kind === "list" && tubes.columns, [
    { name: "sample", type: "string", refersTo: "Sample" },
    { name: "tube", type: "string" },
  ]);
  const plan = payloadShape(lab, "Route", "Plan");
  assert.deepEqual(plan.filter((f) => f.kind === "scalar").map((f) => `${f.name}${f.kind === "scalar" && f.optional ? "?" : ""}`),
    ["request", "lab", "priority?", "route?"], "declared: which fields may be left out — and a route, being a step, may sit in another (ADR 0009)");
  const runSamples = payloadShape(lab, "CourierRun", "Plan").find((f) => f.name === "samples");
  assert.ok(runSamples?.kind === "list" && runSamples.refersTo === "Sample");
});
