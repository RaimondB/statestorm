import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadModel } from "@statestorm/kernel";
import { parseScenario, runScenario } from "@statestorm/scenarios";
import { buildFlow, flowConfig } from "../src/flow.ts";
import { eventNames, overviewConfig } from "../src/overview.ts";
import { assignScenarios, compareDrawings, issuesMarkdown, parseDrawing, parseIssues, statusesTold } from "../src/check/drawings.ts";
import { coverage } from "../src/check/coverage.ts";
import { contributions } from "../src/check/contribution.ts";
import { unanswered } from "../src/check/unanswered.ts";
import { staticChecks } from "../src/check/statics.ts";
import { crossings } from "../src/check/roles.ts";
import { fileURLToPath } from "node:url";
import { readScenario, scenarioFiles } from "@statestorm/scenarios/files";

const examples = new URL("../../examples/", import.meta.url);
const lab = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8"));
const drawingDir = new URL("drawings/lab/", examples);
const scenarioDir = new URL("scenarios/lab/", examples);

const TINY = `
context: T
aggregates:
  Order:
    creators: [Place]
    children: { lines: { type: Line, via: command.order } }
    data: { kind: { type: string } }
    initial: open
    states:
      open:
        on:
          Place: { assign: { kind: command.kind }, emit: [ Placed: { order: "\${id}" } ] }
          Ship#express: { guard: kind == 'expres', target: shipped }
          Ship: { target: shipped }
      shipped: { final: true }
      lost: {}
  Line:
    kind: entity
    creators: [Add]
    initial: here
    states:
      here: { on: { Add: {} } }
policies:
  on_paid: { on: Paid, command: "Order#\${event.order}.Ship" }
`;

test("static checks: a policy on an event nobody raises, a state nothing enters, an entity nothing creates, a value never held (MC-2)", () => {
  const f = staticChecks(loadModel(TINY), [{ ref: "Order#O1.Place", payload: { kind: "express" } }]);
  const has = (check: string, where: string) => f.some((x) => x.check === check && x.where.includes(where));
  assert.ok(has("unraised", "on_paid on Paid"));
  assert.ok(has("unentered", "Order.lost") && f.find((x) => x.where === "Order.lost")!.severity === "warning");
  assert.ok(has("uncreated", "Line"));
  assert.ok(has("never-holds", "Ship#express"), "kind is only ever 'express' — 'expres' is a misspelling");
  assert.ok(has("unheard", "Placed"));
});

test("coverage counts rules taken and states reached over the runs, and says when an ignore is stale (MC-3)", () => {
  const model = loadModel(TINY.replace("policies:", "coverage: { ignore: { Order.lost: a state for later, Nope: stale } }\npolicies:"));
  const sc = parseScenario("scenario: s\nwhen:\n  - send: { Order#O1.Place: { kind: normal } }\n");
  const report = coverage(model, [runScenario(model, sc).world.log]);
  const order = report.types.find((t) => t.type === "Order")!;
  assert.ok(order.rules.untaken.some((u) => u.id.includes("Ship")));
  assert.deepEqual(order.states.unreached.map((u) => [u.path, u.ignored]).sort(), [["lost", "a state for later"], ["shipped", undefined]]);
  assert.deepEqual(report.stale, ["Nope"]);
});

test("each scenario's own reach: the rules, states and drawn arrows no other scenario covers (MC-16)", () => {
  const model = loadModel(TINY);
  const placed = parseScenario("scenario: a\nwhen:\n  - send: { Order#O1.Place: { kind: normal } }\n", "a.yaml");
  const shipped = parseScenario("scenario: b\nwhen:\n  - send: { Order#O1.Place: { kind: normal } }\n  - send: Order#O1.Ship\n", "b.yaml");
  const runs = [placed, shipped].map((sc) => ({ file: sc.file!, log: runScenario(model, sc).world.log }));
  const [a, b] = contributions(model, runs, new Map([["a.yaml", new Set(["d: X -> Y"])], ["b.yaml", new Set(["d: X -> Y", "d: Y -> Z"])]]));
  assert.deepEqual([a!.rules, a!.states, a!.arrows], [[], [], []], "a only does what b does too");
  assert.deepEqual(b!.rules, ["Order.open on Ship"]);
  assert.deepEqual(b!.states, ["Order.shipped"]);
  assert.deepEqual(b!.arrows, ["d: Y -> Z"]);
});

test("a command nobody answered is said once per kind, a repeat and an asserted refusal are not (MC-17)", () => {
  const model = loadModel(TINY);
  const sc = parseScenario("scenario: s\nwhen:\n  - send: { Order#O1.Place: { kind: normal } }\n  - send: Order#O1.Ship\n  - send: Order#O1.Ship\n  - send: Order#O2.Ship\n", "s.yaml");
  const found = unanswered([{ file: sc.file!, log: runScenario(model, sc).world.log }]);
  assert.deepEqual(found.map((u) => `${u.kind} ${u.type}.${u.name} in ${u.where}`).sort(), ["unhandled Order.Ship in no such instance", "unhandled Order.Ship in shipped"]);
  assert.deepEqual(found[0]!.scenarios, ["s"]);
  const once = parseScenario("scenario: d\nwhen:\n  - send: { Order#O1.Place: { kind: normal } }\n  - send: Order#O1.Ship\n", "d.yaml");
  assert.deepEqual(unanswered([{ file: "d.yaml", log: runScenario(model, once, { kind: "duplicate" }).world.log }]), [], "a redelivered command is expected to find nothing to do");
  const refusing = loadModel(TINY.replace("Ship: { target: shipped }", "Ship: { guard: kind == 'normal', target: shipped }"));
  const odd = parseScenario("scenario: r\nwhen:\n  - send: { Order#O1.Place: { kind: odd } }\n  - send: Order#O1.Ship\n", "r.yaml");
  const log = runScenario(refusing, odd).world.log;
  assert.equal(unanswered([{ file: "r.yaml", log }])[0]!.kind, "rejected");
  assert.deepEqual(unanswered([{ file: "r.yaml", log }], new Set(["Order#O1 Ship"])), [], "a refusal a scenario asserts is the point of it");
});

test("a drawing reads in the drawing's own words, and a word the model does not know is an import error (MC-12)", () => {
  const text = `
drawing: d
lanes:
  Lab: [Received, Lost, Teleported]
  Courier: [Delivered @ Courier]
  Desk: [Delivered @ Desk]
outside: [Cancelled request]
names: { Lost: Missing }
paths:
  cancelled request: { colour: blue, later: C-1 }
arrows:
  - Received -> Lost
  - Received -> Delivered @ Desk: { open: Q-1 }
  - Cancelled request -> Received: { path: cancelled request }
  - Cancelled request -> Lost
  - Nowhere -> Lost
`;
  const d = parseDrawing(lab, text, "d.yaml");
  assert.deepEqual(d.boxes.map((b) => `${b.label}/${b.lane}/${b.event}`), [
    "Received/Lab/Received", "Lost/Lab/Missing", "Delivered/Courier/Delivered", "Delivered/Desk/Delivered",
  ]);
  assert.deepEqual(d.arrows.map((a) => a.decision.kind), ["model", "open", "later", "model"]);
  assert.equal(d.errors.length, 3);
  assert.match(d.errors.join("\n"), /`Teleported` \(lane Lab\) is no status of the model/);
  assert.match(d.errors.join("\n"), /`Cancelled request -> Lost` starts or ends outside the model.s statuses/);
  assert.match(d.errors.join("\n"), /`Nowhere` is in no lane and not outside/);
});

test("the lab's drawings import cleanly, and each is compared with its own scenarios (MC-12)", () => {
  const drawings = readdirSync(drawingDir).filter((f) => f.endsWith(".yaml") && f !== "issues.yaml").map((f) => parseDrawing(lab, readFileSync(new URL(f, drawingDir), "utf8"), f));
  assert.deepEqual(drawings.flatMap((d) => d.errors), []);
  const parsed = readdirSync(scenarioDir).filter((f) => f.endsWith(".yaml")).sort().map((f) => readScenario(fileURLToPath(new URL(f, scenarioDir)), f));
  assignScenarios(drawings, parsed.map((sc) => ({ file: sc.file!, drawing: sc.drawing })));
  const runs = parsed.map((sc) => ({ file: sc.file!, log: runScenario(lab, sc).world.log }));
  const graphOf = (prefixes?: string[]) => buildFlow(lab, overviewConfig(lab).config, flowConfig(lab).flow,
    runs.filter((r) => prefixes === undefined || prefixes.some((p) => r.file.startsWith(p))).map((r) => r.log));
  const report = compareDrawings(drawings, graphOf);
  const ward = report.drawings.find((r) => r.drawing.file === "hospital-ward.yaml")!;
  assert.deepEqual(ward.drawing.scenarios, ["07-by-tube-from-the-ward", "08-walked-over-next-door"]);
  assert.deepEqual(ward.missing.map((a) => `${a.from} -> ${a.to}`), [], "every arrow it draws is walked by its own scenarios");
  assert.ok(!ward.shownAnyway.length);
  const lab_ = report.drawings.find((r) => r.drawing.file === "sample-to-result.yaml")!;
  assert.ok(!lab_.drawing.scenarios!.some((f) => f.startsWith("07")), "a ward's tube is not this drawing's");
  assert.deepEqual(lab_.missing, [], "the arrow decided `no` is not missed");
});

test("the changes to the drawings are kept as data, checked, and printed for the stakeholders", () => {
  const files = readdirSync(drawingDir).filter((f) => f.endsWith(".yaml") && f !== "issues.yaml");
  const { issues, errors } = parseIssues(readFileSync(new URL("issues.yaml", drawingDir), "utf8"), "issues.yaml", files);
  assert.deepEqual(errors, []);
  assert.equal(issues.length, 3);
  const md = issuesMarkdown(issues, { "hospital-ward": "Samples from inside the hospital" });
  assert.match(md, /## To confirm/);
  assert.match(md, /\*\*L-1\*\* — Samples from inside the hospital/);
  const bad = parseIssues("issues:\n  - { id: X, drawings: [nope], says: a, status: maybe }\n  - { id: X, says: a, should: b }\n", "i.yaml", files);
  assert.equal(bad.errors.length, 4, bad.errors.join("\n"));   // unknown drawing, should missing, bad status, id twice
  const arrows = parseIssues("issues:\n  - { id: Y, says: a, should: b, arrows: [\"Received -> Released\", \"Nope -> Received\", \"not an arrow\"] }\n", "i.yaml", files, ["Received", "Released"]);
  assert.deepEqual(arrows.issues[0]!.arrows, ["Received Released", "Nope Received"]);
  assert.equal(arrows.errors.length, 2, arrows.errors.join("\n"));   // an unknown status, not an arrow
});

test("a path's scenarios are file-name prefixes, also when YAML reads them as numbers", () => {
  const d = parseDrawing(lab, "drawing: t\nlanes: { Lab: [Received] }\npaths: { referral: { colour: orange, scenarios: [06, 09, 27] } }\narrows: []\n", "t.yaml");
  assert.deepEqual(d.paths.referral!.scenarios, ["06", "09", "27"]);
});

test("a proposed scenario closes a gap from the closest run, and says what the model did with it (MC-11)", async () => {
  const { propose, proposalYaml } = await import("../src/check/propose.ts");
  const scenarios = readdirSync(scenarioDir).filter((f) => f.endsWith(".yaml")).sort().map((f) => readScenario(fileURLToPath(new URL(f, scenarioDir)), f));
  // Received, and never queued in time: the next deadline is the step.
  const expiry = propose(lab, scenarios, "Received", "StabilityExpired", ["01"]);
  assert.ok(!("reason" in expiry));
  assert.equal(expiry.scenario, "01-two-tubes-to-the-lab.yaml", "the drawing's own scenario first");
  assert.ok(expiry.steps.every((s) => s.kind === "advance"), "only the clock moves");
  assert.ok(expiry.moved.some((m) => m.includes("AnalysisHandling") && m.includes("failed")));
  // Queued, the tube is on the analyser and no longer ages: nothing makes it expire.
  assert.ok("reason" in propose(lab, scenarios, "Queued", "StabilityExpired"));
  // Missing, then too old: two steps — a person's decision on the pending deviation (resolved:
  // the run expects the sample again, and it ages), and the deadline.
  const back = propose(lab, scenarios, "Missing", "StabilityExpired");
  assert.ok(!("reason" in back));
  const steps = back.steps.map((s) => (s.kind === "send" ? s.ref.slice(s.ref.lastIndexOf(".") + 1) : "advance"));
  assert.deepEqual(steps, ["Resolve", "advance"]);
  // Left pending by its steps, a deviation waits for a person — and only it: what the model's own
  // policies drive (the patient's view, the steps) is not waiting for anyone.
  const pending = propose(lab, scenarios, "Received", "Missing", ["01"]);
  assert.ok(!("reason" in pending));
  assert.equal(pending.awaiting.length, 1);
  assert.match(pending.awaiting[0]!, /^SampleDeviation#/);
  // The file is a scenario that runs, and passes.
  const raw = parseYaml(readFileSync(new URL(back.scenario, scenarioDir), "utf8")) as Record<string, unknown>;
  const text = proposalYaml(back, raw, "a drawing", { from: "Lost in transit", to: "Too old to run" });
  assert.match(text, /^# PROPOSED by the model check/);
  assert.deepEqual(runScenario(lab, parseScenario(text, "proposed.yaml", scenarioFiles(fileURLToPath(scenarioDir)))).failures, []);
});

test("a proposal says what its steps left waiting for a person — not what the model drives itself (MC-11)", async () => {
  const { propose } = await import("../src/check/propose.ts");
  const model = loadModel(`
context: T
aggregates:
  Box:
    creators: [Scan]
    initial: here
    states:
      here:
        on:
          Scan#lost: { guard: command.event == 'Lost', emit: [ Lost: { box: "\${id}" } ] }
          Scan: { guard: command.event == 'Seen', emit: [ Seen: { box: "\${id}" } ] }
  Hold:                                # only a person releases it
    creators: [Open]
    initial: pending
    states:
      pending: { on: { Open: {}, Release: { target: released } } }
      released: { final: true }
  Notice:                              # sent by the model's own policy
    creators: [Open]
    initial: drafted
    states:
      drafted: { on: { Open: {}, Send: { target: sent } } }
      sent: { final: true }
policies:
  hold: { on: Lost, command: "Hold#\${event.box}.Open" }
  notice: { on: Lost, command: "Notice#\${event.box}.Open" }
  send_notice: { on: Seen, command: "Notice#\${event.box}.Send" }
overview: { flow: { of: [Box] } }
`);
  const scenarios = [
    parseScenario("scenario: seen\nwhen:\n  - send: { Box#B1.Scan: { event: Seen } }\n", "01-seen.yaml"),
    parseScenario("scenario: lost\nwhen:\n  - send: { Box#B2.Scan: { event: Lost } }\n", "02-lost.yaml"),
  ];
  const p = propose(model, scenarios, "Seen", "Lost");
  assert.ok(!("reason" in p), JSON.stringify(p));
  assert.deepEqual(p.awaiting, ["Hold#B1"]);
});

test("ADR 0027 §5: the events that move what another role works, the roll-ups left out", () => {
  const dir = new URL("scenarios/lab/", examples);
  const ends = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((f) => {
    const r = runScenario(lab, readScenario(fileURLToPath(new URL(f, dir)), f), { kind: "fifo" });
    return { file: f, world: r.world };
  });
  const found = crossings(lab, ends);
  const pickUp = found.find((c) => c.input === "Sample.Scan PickedUp" && c.moved === "SiteHandling");
  assert.ok(pickUp, "the courier's pick-up completes the clinic's step");
  assert.equal(pickUp.owner, "Carrying");
  assert.equal(pickUp.movedRole, "Collecting");
  assert.ok(pickUp.scenarios.length > 1);
  // The clinic's visit completing because its step did is the same crossing, not one more.
  assert.ok(!found.some((c) => c.moved === "SiteVisit" || c.moved === "SiteTask"), found.map((c) => c.moved).join(", "));
  // Each one is a crossing indeed.
  for (const c of found) assert.notEqual(c.owner, c.movedRole);
});

test("the status that told the customer: a subject's hidden event is its plumbing — it tells for the status it names (ADR 0035)", () => {
  const lab = loadModel(readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8"));
  // Missing confirmed; the deviation tells the sample, the sample tells every step, a step tells the patient.
  const log = [
    { seq: 1, cause: 0, kind: "event", instance: "Sample#S1", event: "Missing", payload: { sample: "S1" } },
    { seq: 2, cause: 1, kind: "event", instance: "SampleDeviation#d1", event: "DeviationConfirmed", payload: { sample: "S1", event: "Missing" } },
    { seq: 3, cause: 2, kind: "event", instance: "Sample#S1", event: "SampleSettled", payload: { sample: "S1", event: "Missing" } },
    { seq: 4, cause: 3, kind: "event", instance: "PatientView#R1", event: "PatientInformed", payload: { about: "a new sample is needed" } },
  ] as unknown as Parameters<typeof statusesTold>[1];
  const statuses = new Set(eventNames(lab));
  assert.deepEqual([...statusesTold(lab, log, "PatientInformed", ["Sample"], statuses, ["SampleSettled"])], ["Missing"]);
  assert.deepEqual([...statusesTold(lab, log, "PatientInformed", ["Sample"], statuses, [])], ["SampleSettled"], "not hidden: the sample's own status");
});
