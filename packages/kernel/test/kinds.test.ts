import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, send, stateOf } from "../src/engine.ts";

// A batch (aggregate) owns items (entities), each about one unit (an aggregate that is scanned).
const MODEL = `
context: T
aggregates:
  Unit:
    creators: [Register]
    initial: here
    states:
      here:
        on:
          Register: {}
          Scan: { emit: [ Scanned: { unit: "\${id}" } ] }
  Batch:
    creators: [Plan]
    children:
      items: { type: Item, via: command.batch }
    data: { note: { type: string } }
    initial: open
    states:
      open:
        on:
          Plan:
            send: { for_each: command.units, to: "Item#\${id}-\${item}.Expect", with: { batch: "\${id}", unit: "\${item}" } }
          Pick:
            send: { to: "Item#\${id}-\${command.unit}.Pick" }
          Close:
            send: { children: items, command: Close }
        on_children:
          items.all_final: { target: done }
      done: { final: true }
  Item:
    kind: entity
    creators: [Expect]
    references:
      unit: { type: Unit, via: command.unit }
    initial: waiting
    states:
      waiting:
        on:
          Expect: {}
          Seen: { target: seen }
          Pick: { target: seen }
          Close: { target: closed }
      seen:
        on:
          Close: { target: closed }
      closed: { final: true }
policies:
  route:
    on: Scanned
    for_each_referrer: Item.unit
    command: "\${item}.Seen"
`;

test("an owner creates its entities with send, and the whole step settles at once", () => {
  const m = loadModel(MODEL);
  const w = createWorld(m, "2026-01-01T09:00:00Z", { kind: "fifo" }, { frames: true });
  send(w, "Unit#U1.Register");
  const before = w.frames!.length;
  send(w, "Batch#A.Plan", { units: ["U1", "U2"] });
  assert.equal(stateOf(w, "Item#A-U1"), "waiting");
  assert.equal(stateOf(w, "Item#A-U2"), "waiting");
  // "you sent" plus one step: the items were created inside the batch's step, not after it.
  assert.equal(w.frames!.length - before, 2);
});

test("a command from outside to an entity is refused; the aggregate passes it on", () => {
  const m = loadModel(MODEL);
  const w = createWorld(m);
  send(w, "Batch#A.Plan", { units: ["U1"] });
  send(w, "Item#A-U1.Pick");
  assert.equal(stateOf(w, "Item#A-U1"), "waiting");
  const f = w.log.find((e) => e.kind === "finding" && e.severity === "error");
  assert.ok(f && f.kind === "finding" && /Item#A-U1 is an entity of Batch#A — commands go to its aggregate/.test(f.message));
  send(w, "Batch#A.Pick", { unit: "U1" });
  assert.equal(stateOf(w, "Item#A-U1"), "seen");
});

test("routing by reference reaches each aggregate once, for the entities the event is about", () => {
  const m = loadModel(MODEL);
  const w = createWorld(m);
  send(w, "Unit#U1.Register");
  send(w, "Batch#A.Plan", { units: ["U1", "U2"] });
  send(w, "Batch#B.Plan", { units: ["U1"] });
  const mark = w.log.length;
  send(w, "Unit#U1.Scan");
  const after = w.log.slice(mark);
  const to = after.filter((e) => e.kind === "command" && e.name === "Seen").map((e) => e.kind === "command" ? e.instance : "");
  assert.deepEqual(to.sort(), ["Batch#A", "Batch#B"], "one command per aggregate, not one per item");
  assert.equal(stateOf(w, "Item#A-U1"), "seen");
  assert.equal(stateOf(w, "Item#B-U1"), "seen");
  assert.equal(stateOf(w, "Item#A-U2"), "waiting", "not about U2");
  // A second scan finds nobody inside who answers: said once, by the aggregate.
  send(w, "Unit#U1.Scan");
  const ignored = w.log.filter((e) => e.kind === "ignored");
  assert.deepEqual(ignored.map((e) => e.instance).sort(), ["Batch#A", "Batch#B"]);
});

test("send to every child of a relation, and the roll-up settles in the same step", () => {
  const m = loadModel(MODEL);
  const w = createWorld(m, "2026-01-01T09:00:00Z", { kind: "random", seed: 3 });
  send(w, "Batch#A.Plan", { units: ["U1", "U2", "U3"] });
  send(w, "Batch#A.Close");
  assert.deepEqual(["Item#A-U1", "Item#A-U2", "Item#A-U3"].map((k) => stateOf(w, k)), ["closed", "closed", "closed"]);
  assert.equal(stateOf(w, "Batch#A"), "done");
});

test("the loader holds the line: owned entities, sends inside, no policy commanding an entity", () => {
  const bad = (from: string, to: string, why: RegExp) => assert.throws(() => loadModel(MODEL.replace(from, to)), why);
  bad("      items: { type: Item, via: command.batch }\n", "", /Item is an entity, and no relation owns it/);
  assert.throws(() => loadModel(MODEL.replace("for_each_referrer: Item.unit\n    command: \"${item}.Seen\"", "command: \"Item#A-U1.Seen\"")),
    /commands Item, an entity — commands go to its aggregate \(Batch\)/);
  bad('send: { to: "Item#${id}-${command.unit}.Pick" }', 'send: { to: "Unit#${command.unit}.Scan" }', /Unit is an aggregate — raise an event/);
  bad("send: { children: items, command: Close }", "send: { children: lines, command: Close }", /Batch has no relation called that/);
  bad("    kind: entity\n", "    kind: thing\n", /`kind` is aggregate or entity/);
});

test("a reference into another aggregate's entity is a warning: point at the root", () => {
  const m = loadModel(MODEL.replace("policies:", `  Label:
    creators: [Print]
    references:
      item: { type: Item, via: command.item }
    initial: printed
    states:
      printed: { on: { Print: {} } }
policies:`));
  assert.ok(m.findings.some((f) => f.severity === "warning" && /Label.references.item points at Item, an entity of Batch/.test(f.message)));
});

test("a subtype has its supertype's kind", () => {
  const model = (kind: string) => `
context: T
aggregates:
  Holder:
    creators: [Make]
    children: { parts: { type: Part, via: command.holder } }
    initial: a
    states: { a: { on: { Make: {} } } }
  Part:
    abstract: true
    kind: entity
    creators: [Make]
    initial: a
    states: { a: { on: { Make: {} } } }
  Bolt:
    extends: Part
    ${kind}
`;
  assert.equal(loadModel(model("")).aggregates.Bolt!.role, "entity");
  assert.throws(() => loadModel(model("kind: aggregate")), /a subtype has its supertype's kind/);
});

// ---------------------------------------------------------------- value objects (§8)

const VALUES = `
context: T
values:
  Address: { street: string, city: string }
  Row: { sku: string, qty: number, note: string? }
aggregates:
  Order:
    creators: [Place]
    data:
      shipTo: { type: Address }
    initial: open
    states:
      open:
        on:
          Place:
            takes: { customer: string, lines: [Row], shipTo: Address }
            assign: { shipTo: command.shipTo }
          Move:
            assign: { shipTo: command.to }
`;

test("a value object is a named set of fields: a field's type, and the shape of a payload's rows", () => {
  const m = loadModel(VALUES);
  assert.deepEqual(Object.keys(m.values), ["Address", "Row"]);
  assert.deepEqual(m.values.Row!.fields.note, { type: "string", optional: true, list: false });
  assert.equal(m.aggregates.Order!.data.shipTo!.type, "value");
  const w = createWorld(m);
  send(w, "Order#1.Place", { customer: "c", lines: [{ sku: "a", qty: 2 }], shipTo: { street: "Main 1", city: "Utrecht" } });
  assert.deepEqual(w.aggregates["Order#1"]!.data.shipTo, { street: "Main 1", city: "Utrecht" });
});

test("a command that does not carry what its rule takes changes nothing, and says what is wrong", () => {
  const m = loadModel(VALUES);
  const w = createWorld(m);
  send(w, "Order#2.Place", { customer: "c", lines: [{ sku: "a", qty: "two" }, { qty: 1 }], shipTo: { street: "x", city: "y" } });
  const f = w.log.find((e) => e.kind === "finding" && e.severity === "error");
  assert.ok(f && f.kind === "finding");
  assert.match(f.message, /does not carry what it takes: lines\[0\]\.qty should be a number, not "two"; lines\[1\]\.sku is missing/);
  assert.equal(w.aggregates["Order#2"]!.data.shipTo, null, "not applied");
});

test("a value object is exactly its fields — assigning anything else is refused", () => {
  const m = loadModel(VALUES);
  const w = createWorld(m);
  send(w, "Order#3.Place", { customer: "c", lines: [], shipTo: { street: "x", city: "y" } });
  send(w, "Order#3.Move", { to: { street: "x", town: "z" } });
  assert.deepEqual(w.aggregates["Order#3"]!.data.shipTo, { street: "x", city: "y" });
  assert.ok(w.log.some((e) => e.kind === "finding" && /shipTo.town is not a field of Address; shipTo.city is missing/.test(e.message)));
});

test("the loader checks value objects: known types, lists only in payloads", () => {
  assert.throws(() => loadModel(VALUES.replace("city: string }", "city: Town }")), /`Town` is not number, string, boolean or a value object/);
  assert.throws(() => loadModel(VALUES.replace("city: string }", "city: [string] }")), /a list is a payload's, never a field's/);
  assert.throws(() => loadModel(VALUES.replace("lines: [Row]", "lines: [Line]")), /`Line` is not number, string, boolean or a value object/);
  assert.throws(() => loadModel(VALUES.replace("shipTo: { type: Address }", "shipTo: { type: Adress }")), /type must be number, string, boolean or a value object \(Address, Row\)/);
});

// ---------------------------------------------------------------- packages (ADR 0013)

test("packages group types by name; every name is checked, and a type has one package", () => {
  const withPackages = (p: string) => MODEL.replace("aggregates:", `packages:\n${p}\naggregates:`);
  const m = loadModel(withPackages("  Batches: { note: what is planned together, types: [Batch, Item] }\n  Units: [Unit]"));
  assert.deepEqual(m.packages, [{ name: "Batches", note: "what is planned together", types: ["Batch", "Item"] }, { name: "Units", types: ["Unit"] }]);
  assert.throws(() => loadModel(withPackages("  Batches: [Batch, Itme]")), /packages.Batches: there is no type called `Itme`/);
  assert.throws(() => loadModel(withPackages("  A: [Batch]\n  B: [Batch]")), /packages.B: `Batch` is already in package A/);
  assert.deepEqual(loadModel(MODEL).packages, []);
});
