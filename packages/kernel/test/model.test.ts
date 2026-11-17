import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel, parseDuration } from "../src/model.ts";

const wrap = (body: string) => `context: T\naggregates:\n${body}`;

test("durations", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("14d"), 14 * 86_400_000);
  assert.throws(() => parseDuration("soon"), /not a duration/);
});

test("a composite must name its initial substate (ADR 0005 §8)", () => {
  assert.throws(
    () => loadModel(wrap("  A:\n    creators: [X]\n    initial: a\n    states:\n      a:\n        states:\n          b: {}\n")),
    /must declare `initial`/,
  );
});

test("creators must be declared, so a typo is not an implicit create", () => {
  assert.throws(() => loadModel(wrap("  A:\n    initial: a\n    states:\n      a: {}\n")), /declare `creators`/);
});

test("a policy cannot raise events (ADR 0003)", () => {
  assert.throws(
    () => loadModel(`context: T
aggregates:
  A: { creators: [X], initial: a, states: { a: { on: { X: { emit: [Happened] } } } } }
policies:
  p:
    initial: s
    states:
      s: { on: { Happened: { emit: [Nope] } } }
`),
    /does not raise events/,
  );
});

test("a child quantifier must be one of the known forms", () => {
  assert.throws(
    () => loadModel(wrap("  A:\n    creators: [X]\n    initial: a\n    states:\n      a:\n        on_children:\n          lines.most_of_them: {}\n")),
    /is not a child quantifier/,
  );
});

test("a relation needs `via`, because correlation is never guessed", () => {
  assert.throws(
    () => loadModel(wrap("  A:\n    creators: [X]\n    children:\n      lines: { type: B }\n    initial: a\n    states:\n      a: {}\n")),
    /needs `via`/,
  );
});

// ---------------------------------------------------------------- why: (ADR 0016)

const WHY = `context: T
packages:
  P: { types: [A], why: [R1] }
aggregates:
  Base:
    abstract: true
    creators: [X]
    initial: a
    states:
      a:
        why: [R2]
        on:
          X: { why: [R3], target: b }
      b: { final: true }
  A:
    extends: Base
    why: [R4]
    states:
      a:
        why: [R5]
        on:
          Y: { why: [R6, TP-2] }
policies:
  short: { on: Done, command: "A#1.Y", why: [R7] }
  long:
    why: [R8]
    initial: ready
    states:
      ready:
        why: [R9]
        on:
          Done: { command: "A#1.Y", why: [R10] }
`;

test("why: is carried on a package, a type, a state, a rule and a policy, and never run (ADR 0016)", () => {
  const m = loadModel(WHY);
  assert.deepEqual(m.packages[0]!.why, ["R1"]);
  assert.deepEqual(m.aggregates.A!.why, ["R4"]);
  assert.deepEqual(m.aggregates.A!.states.a!.why, ["R5"]);
  assert.deepEqual(m.aggregates.A!.states.a!.on.Y![0]!.why, ["R6", "TP-2"]);
  assert.deepEqual(m.policies.short!.why, ["R7"]);
  assert.deepEqual(m.policies.long!.why, ["R8"]);
  assert.deepEqual(m.policies.long!.states.ready!.why, ["R9"]);
  assert.deepEqual(m.policies.long!.states.ready!.on.Done![0]!.why, ["R10"]);
});

test("why: stays where it was written — an inherited rule keeps its own, an inherited state's is not copied (ADR 0016)", () => {
  const m = loadModel(WHY);
  const x = m.aggregates.A!.states.a!.on.X![0]!;
  assert.deepEqual([x.why, x.inheritedFrom], [["R3"], "Base"]);
  assert.deepEqual(m.aggregates.Base!.states.a!.why, ["R2"]);
  assert.deepEqual(m.aggregates.A!.states.a!.why, ["R5"]);
  assert.equal(m.aggregates.A!.states.b!.why, undefined);
});

test("why: is a list of ids — anything else is refused at load (ADR 0016)", () => {
  const bad = (why: string) => () => loadModel(wrap(`  A:\n    creators: [X]\n    initial: a\n    states:\n      a:\n        on:\n          X: { why: ${why} }\n`));
  for (const why of ["R3", "[]", "[12]", "['two words']"]) assert.throws(bad(why), /why: a list of the ids/, why);
  assert.throws(() => loadModel(WHY.replace("why: [R1]", "why: R1")), /packages\.P\.why/);
});

test("a data field named like the instance's own id, type or state is a load error — it would never be read", () => {
  for (const name of ["id", "type", "state"]) {
    assert.throws(() => loadModel(`
context: T
aggregates:
  Site:
    creators: [Register]
    data: { ${name}: { type: string } }
    initial: known
    states: { known: { on: { Register: {} } } }
`), new RegExp(`Site\\.data\\.${name}: \`${name}\` is the instance's own`));
  }
});
