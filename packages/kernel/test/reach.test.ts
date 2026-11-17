import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/model.ts";
import { createWorld, eventsOf, send, stateOf } from "../src/engine.ts";

// ADR 0028: a run names the place it goes to by id only. A place is a clinic or a lab, and the run
// asks it without knowing which: the command to the abstract type reaches the one instance that has
// the id, whichever subtype it is.
const model = loadModel(`
context: T
aggregates:
  Place:
    abstract: true
    data: { kind: { type: string } }
    initial: known
    states:
      known:
        on:
          Describe: { emit: [ PlaceDescribed: { run: "\${command.run}", place: "\${id}", kind: "\${kind}" } ] }
  Clinic:
    extends: Place
    creators: [Register]
    states:
      known:
        on:
          Register: { assign: { kind: "'clinic'" } }
  Lab:
    extends: Place
    creators: [Register]
    states:
      known:
        on:
          Register: { assign: { kind: "'lab'" } }
  Run:
    creators: [Plan]
    data: { to: { type: string } }
    initial: planned
    states:
      planned:
        on:
          Plan: { assign: { to: command.to }, emit: [ RunPlanned: { run: "\${id}", to: "\${command.to}" } ] }
policies:
  ask_destination:
    on: RunPlanned
    command: "Place#\${event.to}.Describe"
    with: { run: "\${event.run}" }
`);

test("a command to an abstract type reaches the instance of whichever subtype has the id", () => {
  const w = createWorld(model);
  send(w, "Clinic#C1.Register");
  send(w, "Lab#L1.Register");
  send(w, "Run#R1.Plan", { to: "C1" });
  send(w, "Run#R2.Plan", { to: "L1" });
  const described = eventsOf(w).filter((e) => e.event === "PlaceDescribed").map((e) => e.payload);
  assert.deepEqual(described, [{ run: "R1", place: "C1", kind: "clinic" }, { run: "R2", place: "L1", kind: "lab" }]);
  // The log names the instance it reached, not the abstract type.
  assert.ok(w.log.some((e) => e.kind === "command" && e.instance === "Clinic#C1" && e.name === "Describe"));
  assert.ok(!w.log.some((e) => e.kind === "finding"));
});

test("no subtype with the id: the command is unhandled, and nothing is created", () => {
  const w = createWorld(model);
  send(w, "Place#X9.Describe", { run: "R1" });
  const miss = w.log.find((e) => e.kind === "unhandled");
  assert.ok(miss && /no Clinic or Lab has the id `X9`/.test(miss.reason));
  assert.equal(Object.keys(w.aggregates).length, 0);
});

test("two subtypes with the id: reaching it is an error, and neither is told", () => {
  const w = createWorld(model);
  send(w, "Clinic#P1.Register");
  send(w, "Lab#P1.Register");                   // legal: each type has its own ids (ADR 0009 §3)
  send(w, "Run#R1.Plan", { to: "P1" });
  assert.ok(w.log.some((e) => e.kind === "finding" && e.severity === "error" && /Clinic#P1 and Lab#P1 share the id `P1`/.test(e.message)));
  assert.ok(!eventsOf(w).some((e) => e.event === "PlaceDescribed"));
});

test("an abstract type is still never created through itself", () => {
  const w = createWorld(loadModel(`
context: T
aggregates:
  Place:
    abstract: true
    creators: [Register]
    initial: known
    states: { known: { on: { Register: {} } } }
  Clinic: { extends: Place }
`));
  send(w, "Place#P1.Register");
  assert.ok(w.log.some((e) => e.kind === "finding" && e.severity === "error" && /is abstract and has no instances/.test(e.message)));
});
