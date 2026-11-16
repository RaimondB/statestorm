import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel, type Model } from "@statestorm/kernel";
import { parseScenario } from "@statestorm/scenarios";
import { buildOverview, byNote, overviewConfig, spoken, toneOf, withEventsMode, type Box } from "../src/overview.ts";
import { actionsOf, play } from "../src/session.ts";

const examples = new URL("../../examples/", import.meta.url);
const load = (name: string) => loadModel(readFileSync(new URL(`models/${name}.yaml`, examples), "utf8"));
const scenario = (path: string) => parseScenario(readFileSync(new URL(`scenarios/${path}`, examples), "utf8"));
const fifo = { kind: "fifo" } as const;

function run(model: Model, path: string, atFrame?: (n: number) => number) {
  const sc = scenario(path);
  const r = play(model, actionsOf(sc), sc.schedule ?? fifo, sc.given.at);
  const i = atFrame ? atFrame(r.frames.length) : r.frames.length - 1;
  const { config, errors } = overviewConfig(model);
  return { overview: buildOverview(model, r.frames[i]!, r.world.log, config), errors, run: r };
}

const find = (boxes: Box[], key: string): Box | undefined => {
  for (const b of boxes) {
    if (b.key === key) return b;
    const hit = find(b.groups.flatMap((g) => g.children), key);
    if (hit) return hit;
  }
  return undefined;
};

const lab = load("lab");

test("the request: a route over a sequence of steps over their tasks", () => {
  const { overview, errors } = run(lab, "lab/01-two-tubes-to-the-lab.yaml");
  assert.deepEqual(errors, []);
  assert.deepEqual(overview.roots.map((r) => r.key), ["Request#R1"]);
  const route = overview.roots[0]!.groups[0]!.children[0]!;
  assert.equal(route.key, "Route#R1-LAB1");
  assert.equal(route.label, "to LAB1");
  assert.deepEqual(route.groups.map((g) => [g.rel, g.mode, g.children.length]),
    [["tasks", "band", 2], ["steps", "sequence", 4]], "the route's own tasks as a band, its steps in a row");
  assert.deepEqual(route.summaries, [], "its links are plan, omitted — not a tally");
  assert.deepEqual(overview.top.map((b) => [b.key, b.label, b.path.join("."), b.tone, b.family]),
    [["PatientView#R1", "what the patient sees · R1", "results_ready", "done", "purple"]],
    "what the patient sees sits on top, above the request, in a colour of its own");
  assert.deepEqual(route.groups[1]!.children.map((c) => c.label), ["at CLIN1", "CLIN1 → LAB1 · courier 7", "chemistry at LAB1", "haematology at LAB1"]);
  const inbound = find(overview.roots, "SiteTask#R1-CLIN1-inbound")!;
  assert.equal(inbound.label, "inbound");
  assert.deepEqual(inbound.summaries, [{
    rel: "handlings", total: 2, finals: 2,
    byState: [{ state: "completed", count: 2, tone: "done", items: [
      { key: "Sample#S1", label: "S1" }, { key: "Sample#S2", label: "S2" },
    ] }],
  }], "handlings are folded, not drawn, and named by the sample each was about");
  assert.deepEqual(overview.side.map((s) => s.key), ["Sample#S1", "Sample#S2"], "what is scanned is in the side lane");
  assert.deepEqual(overview.others, [], "deviations and links are omitted by the model's own `omit`");
});

test("an event raised by something not drawn sits under the deepest boxes it changed", () => {
  const { overview } = run(lab, "lab/01-two-tubes-to-the-lab.yaml");
  const under = (key: string) => (overview.stickies[key] ?? []).map((s) => `${s.event}×${s.count}`);
  assert.deepEqual(under("SiteTask#R1-CLIN1-inbound"), ["Collected×2"]);
  // The handover: one scan per sample, under both tasks it completed — and not under the steps
  // above them, nor the route's own band task.
  assert.deepEqual(under("SiteTask#R1-CLIN1-outbound"), ["Packed×2", "PickedUp×2"]);
  assert.deepEqual(under("TransferTask#R1-C1-pickup"), ["PickedUp×2"]);
  assert.deepEqual(under("SiteVisit#R1-CLIN1"), []);
  assert.deepEqual(under("RouteTask#R1-LAB1-collect"), []);
  // One department's tasks hear only the sample in their tube.
  assert.deepEqual(under("AnalysisTask#R1-CHEM-run"), ["Queued×1", "Analysed×1"]);
});

test("every box knows its active state, and how it reads", () => {
  const mid = run(lab, "lab/01-two-tubes-to-the-lab.yaml", (n) => Math.floor(n / 2)).overview;
  const tones = new Set<string>();
  const walk = (b: Box) => { tones.add(b.tone); b.groups.forEach((g) => g.children.forEach(walk)); };
  mid.roots.forEach(walk);
  assert.ok(tones.has("active") && tones.has("done") && tones.has("neutral"), [...tones].join(","));
  assert.equal(toneOf(["failed"], true), "failed");
  assert.equal(toneOf(["partially_completed"], true), "partial");
  assert.equal(toneOf(["in_progress", "storing"], false), "active");
  assert.equal(spoken("StabilityExpired"), "Stability Expired");
});

test("sales needs no configuration: an order over its lines, events under what raised them", () => {
  const sales = load("sales");
  const { overview, errors } = run(sales, "sales/01-happy-path.yaml");
  assert.deepEqual(errors, []);
  assert.deepEqual(overview.roots.map((r) => r.key), ["Order#A1", "Warehouse#main", "Shipment#A1"]);
  const order = overview.roots[0]!;
  assert.deepEqual(order.groups.map((g) => [g.rel, g.mode, g.children.length]), [["lines", "row", 2]]);
  assert.ok((overview.stickies["Order#A1"] ?? []).some((s) => s.event === "OrderPaid"));
  assert.ok((overview.stickies["OrderLine#A1-widget"] ?? []).some((s) => s.event === "LineShipped"));
  assert.deepEqual(overview.side, []);
});

test("claims needs no configuration either", () => {
  const claims = load("claims");
  const { overview } = run(claims, "claims/01-fast-track.yaml");
  assert.deepEqual(overview.roots.map((r) => [r.key, r.path.join("."), r.tone]), [["Claim#S1", "closed", "done"], ["Payment#S1", "sent", "done"]]);
});

test("a misspelt name in the overview is an error, not a quietly missing box", () => {
  const text = readFileSync(new URL("models/lab.yaml", examples), "utf8");
  const model = loadModel(text.replace("sequence: [Route.steps]", "sequence: [Route.stpes]").replace("roots: [Request]", "roots: [Reqest]"));
  const { errors } = overviewConfig(model);
  assert.deepEqual(errors, [
    "overview.roots: there is no aggregate called `Reqest`",
    "overview.sequence: Route has no relation called `stpes`",
  ]);
  const typo = loadModel(text.replace('"*Planned"', '"*Planed"'));
  assert.deepEqual(overviewConfig(typo).errors, ["overview.events.hide: `*Planed` matches no event the model raises"]);
});

test("colour follows the family: a route's tasks are green, a site's tasks blue, a department's teal", () => {
  const { overview } = run(lab, "lab/01-two-tubes-to-the-lab.yaml");
  const colour = (key: string) => { const b = find(overview.roots, key)!; return `${b.family}/${b.tint}`; };
  assert.equal(colour("Request#R1"), "navy/0");
  assert.equal(colour("Route#R1-LAB1"), "green/0", "Route beats its ancestor Step");
  assert.equal(colour("RouteTask#R1-LAB1-collect"), "green/1");
  assert.equal(colour("SiteVisit#R1-CLIN1"), "blue/0");
  assert.equal(colour("CourierRun#R1-C1"), "blue/0");
  assert.equal(colour("SiteTask#R1-CLIN1-inbound"), "blue/1");
  assert.equal(colour("Analysis#R1-CHEM"), "teal/0");
  assert.equal(colour("AnalysisTask#R1-CHEM-run"), "teal/1");
  const bad = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8").replace("Step: blue ", "Step: bleu "));
  assert.deepEqual(overviewConfig(bad).errors, ["overview.color.Step: `bleu` — expected one of navy, green, blue, teal, purple, amber, grey"]);
});

test("stepping by what the overview shows skips the internal messages, and stops at every change", async () => {
  const { visibleStep, overviewSignature } = await import("../src/overview.ts");
  const sc = scenario("lab/01-two-tubes-to-the-lab.yaml");
  const r = play(lab, actionsOf(sc), fifo, sc.given.at);
  const { config } = overviewConfig(lab);
  const sig = (i: number) => overviewSignature(buildOverview(lab, r.frames[i]!, r.world.log, config));
  const stops: number[] = [];
  for (let i = 0; i < r.frames.length - 1;) { i = visibleStep(lab, config, r, i, 1); stops.push(i); }
  assert.ok(stops.length < r.frames.length / 3, `${stops.length} stops for ${r.frames.length} frames`);
  // Exact: every stop looks different from the frame before, and nothing between stops does.
  let prev = 0;
  for (const s of stops) {
    for (let j = prev + 1; j < s; j++) assert.equal(sig(j), sig(j - 1), `frame ${j} changed but was skipped`);
    if (s !== r.frames.length - 1 || sig(s) !== sig(s - 1)) assert.notEqual(sig(s), sig(s - 1), `stop ${s} shows nothing new`);
    prev = s;
  }
  // And backwards lands on the same stops.
  const back = visibleStep(lab, config, r, stops[5]!, -1);
  assert.equal(back, stops[4]);
});

test("between two stops, exactly the boxes that look different are marked — tallies and events too", async () => {
  const { differences, visibleStep } = await import("../src/overview.ts");
  const sc = scenario("lab/01-two-tubes-to-the-lab.yaml");
  const r = play(lab, actionsOf(sc), fifo, sc.given.at);
  const { config } = overviewConfig(lab);
  const at = (i: number) => buildOverview(lab, r.frames[i]!, r.world.log, config);
  let i = r.phases.find((p) => p.name === "At the clinic")!.frame;
  for (let k = 0; k < 12; k++) {
    const next = visibleStep(lab, config, r, i, 1);
    const d = differences(at(i), at(next));
    assert.ok(d.boxes.size + d.stickies.size > 0, `stop ${next} marks nothing`);
    i = next;
  }
});

test("a tally says how its samples ended, not just that they did", () => {
  const { overview } = run(lab, "lab/05-one-of-two-haemolysed.yaml");
  const runTask = find(overview.roots, "AnalysisTask#R5-CHEM-run")!;
  assert.equal(runTask.tone, "partial");
  assert.deepEqual(runTask.summaries[0]!.byState.map((x) => `${x.state}:${x.count}:${x.tone}`).sort(), ["completed:1:done", "failed:1:failed"]);
});

test("a sample no longer expected reads as not needed, not as done", () => {
  // Too old to run: the run failed, so the report no longer expects the sample.
  const { overview } = run(lab, "lab/04-stability-expired.yaml");
  const report = find(overview.roots, "AnalysisTask#R4-CHEM-report")!;
  assert.deepEqual(report.summaries[0]!.byState.map((x) => `${x.state}:${x.tone}`), ["excluded:skipped"]);
  assert.equal(report.tone, "skipped");
  assert.equal(toneOf(["excluded"], true), "skipped");
});

test("two relations named in the sequence of one type are one row, in the order listed", () => {
  const model = loadModel(`
context: T
aggregates:
  Job:
    creators: [Open]
    children: { stages: { type: Stage, via: command.job }, checks: { type: Check, via: command.job } }
    initial: open
    states: { open: { on: { Open: {} } } }
  Stage: { creators: [Plan], initial: planned, states: { planned: { on: { Plan: {} } } } }
  Check: { creators: [Plan], initial: planned, states: { planned: { on: { Plan: {} } } } }
overview:
  roots: [Job]
  sequence: [Job.stages, Job.checks]
`);
  const sc = parseScenario("scenario: s\nwhen:\n  - send: { Job#J.Open: {} }\n  - send: { Check#J-B.Plan: { job: J } }\n  - send: { Stage#J-A.Plan: { job: J } }\n");
  const r = play(model, actionsOf(sc), fifo);
  const { config, errors } = overviewConfig(model);
  assert.deepEqual(errors, []);
  const job = buildOverview(model, r.frames[r.frames.length - 1]!, r.world.log, config).roots[0]!;
  assert.deepEqual(job.groups.map((g) => [g.mode, g.children.map((c) => c.key)]), [["sequence", ["Stage#J-A", "Check#J-B"]]],
    "one row, not two stacked groups — the stages first, though the check was planned first");
});

test("with links between steps, a branching route is laid out by them, not in plan order", () => {
  const { overview, errors } = run(lab, "lab/01-two-tubes-to-the-lab.yaml");
  assert.deepEqual(errors, []);
  const route = find(overview.roots, "Route#R1-LAB1")!;
  const steps = route.groups.find((g) => g.rel === "steps")!;
  assert.deepEqual(steps.layers?.map((l) => l.map((b) => b.key.split("#")[1]).sort()),
    [["R1-CLIN1"], ["R1-C1"], ["R1-CHEM", "R1-HAEM"]], "the two departments side by side, after the courier");
  const linear = run(lab, "lab/02-haemolysed-at-the-lab.yaml").overview;
  const plain = find(linear.roots, "Route#R2-LAB1")!.groups.find((g) => g.rel === "steps")!;
  assert.equal(plain.layers, undefined, "without links, no layers");
  assert.deepEqual(plain.children.map((c) => c.label), ["at CLIN1", "CLIN1 → LAB1 · courier 7", "chemistry at LAB1"], "plan order");
  const bad = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8").replace("before: before, after: after", "before: befor, after: after"));
  assert.deepEqual(overviewConfig(bad).errors, ["overview.follows: Link has no reference `befor`"]);
});

test("plan order never overrules a link: a step linked in later is drawn where its links put it", () => {
  const model = loadModel(`
context: T
aggregates:
  Job:
    creators: [Open]
    children: { stages: { type: Stage, via: command.job }, links: { type: Link, via: command.job } }
    initial: open
    states: { open: { on: { Open: {}, Link: { send: { to: "Link#\${command.link}.Plan", with: { job: "\${id}", before: "\${command.before}", after: "\${command.after}" } } } } } }
  Stage: { creators: [Plan], initial: planned, states: { planned: { on: { Plan: {} } } } }
  Link:
    kind: entity
    creators: [Plan]
    references: { before: { type: Stage, via: command.before }, after: { type: Stage, via: command.after } }
    initial: planned
    states: { planned: { on: { Plan: {} } } }
overview:
  roots: [Job]
  sequence: [Job.stages]
  omit: [Link]
  follows: { type: Link, before: before, after: after }
`);
  // A, B, C planned in a line; D comes later, between A and B: A → D → B. C, linked to nothing,
  // follows B in plan order — but not D, though D was planned right after it: that would close a loop.
  const sc = parseScenario(`scenario: s
when:
  - send: { Job#J.Open: {} }
  - send: { Stage#A.Plan: { job: J } }
  - send: { Stage#B.Plan: { job: J } }
  - send: { Stage#C.Plan: { job: J } }
  - send: { Stage#D.Plan: { job: J } }
  - send: { Job#J.Link: { link: AD, before: A, after: D } }
  - send: { Job#J.Link: { link: DB, before: D, after: B } }
`);
  const r = play(model, actionsOf(sc), fifo);
  const { config, errors } = overviewConfig(model);
  assert.deepEqual(errors, []);
  const job = buildOverview(model, r.frames[r.frames.length - 1]!, r.world.log, config).roots[0]!;
  const stages = job.groups.find((g) => g.rel === "stages")!;
  assert.deepEqual(stages.layers?.map((l) => l.map((b) => b.key)), [["Stage#A"], ["Stage#D"], ["Stage#B"], ["Stage#C"]]);
});

test("the patient's view is on top from the moment the request is created", () => {
  const sc = scenario("lab/01-two-tubes-to-the-lab.yaml");
  const r = play(lab, actionsOf(sc), fifo, sc.given.at);
  const { config } = overviewConfig(lab);
  const first = r.frames.findIndex((f) => Object.keys(f.instances).includes("PatientView#R1"));
  const firstScan = r.world.log.find((e) => e.kind === "command" && e.name === "Scan")!;
  assert.ok(first >= 0 && r.frames[first]!.seq < firstScan.seq, "it exists before the first scan");
  const top = buildOverview(lab, r.frames[first]!, r.world.log, config).top;
  assert.deepEqual(top.map((b) => b.path.join(".")), ["journey.ordered"]);
});

test("without an instance of the root type, what exists is drawn — and a step is never in the side lane", () => {
  const sc = parseScenario(`
scenario: part of a route, no request
given:
  send:
    - Sample#S1.Register: { request: X }
    - SiteVisit#X-CLIN1.Plan: { route: X-LAB1, site: CLIN1, samples: [S1] }
`);
  const r = play(lab, actionsOf(sc), fifo, sc.given.at);
  const { config } = overviewConfig(lab);
  const o = buildOverview(lab, r.frames[r.frames.length - 1]!, r.world.log, config);
  assert.deepEqual(o.roots.map((b) => b.key), ["SiteVisit#X-CLIN1"], "not an empty picture");
  assert.deepEqual(o.side.map((i) => i.key), ["Sample#S1"], "the sample is pointed at; the step has a parent type");
  assert.deepEqual(find(o.roots, "SiteVisit#X-CLIN1")!.groups[0]!.children.map((c) => c.label), ["inbound", "outbound"]);
});

test("a route that links only its last step keeps the rest in plan order", () => {
  const { overview } = run(lab, "lab/06-referred-to-the-reference-lab.yaml");
  const route = find(overview.roots, "Route#R6-REF1")!;
  const steps = route.groups.find((g) => g.rel === "steps")!;
  assert.deepEqual(steps.layers?.map((l) => l.map((b) => b.key.split("#")[1])),
    [["R6-CLIN1"], ["R6-C1"], ["R6-LAB1"], ["R6-C2"], ["R6-SPEC"]]);
});

test("which sample an event happened to, and how each sample ended, is named — not just counted", () => {
  const { overview } = run(lab, "lab/05-one-of-two-haemolysed.yaml");
  const runTask = find(overview.roots, "AnalysisTask#R5-CHEM-run")!;
  assert.deepEqual(runTask.summaries[0]!.byState.map((x) => `${x.tone}:${x.items.map((i) => i.label).join(",")}`).sort(),
    ["done:S6", "failed:S7"], "S6 was analysed, S7 haemolysed");
  const stickies = overview.stickies["AnalysisTask#R5-CHEM-run"]!;
  assert.deepEqual(stickies.map((st) => `${st.event}:${st.badges.map((b) => b.label).join(",")}`), ["Haemolysed:S7", "Analysed:S6"]);
  // Confirmed is a state of the status that was reported, not an event of its own.
  assert.deepEqual(stickies.find((st) => st.event === "Haemolysed")!.statuses!.map((g) => `${g.state}:${g.tone}:${g.badges.map((b) => b.label)}`),
    ["confirmed:failed:S7"]);
});

test("a deviation's pending, resolved or confirmed is the substatus of the status that reported it", () => {
  const sc = scenario("lab/03-missing-on-delivery-then-found.yaml");
  const r = play(lab, actionsOf(sc), fifo, sc.given.at);
  const { config } = overviewConfig(lab);
  const at = (i: number) => buildOverview(lab, r.frames[i]!, r.world.log, config);
  const missing = (o: ReturnType<typeof at>) => (o.stickies["TransferTask#R3-C1-deliver"] ?? []).find((s) => s.event === "Missing");
  const found = r.phases.find((p) => p.name === "Found")!.frame;
  assert.deepEqual(missing(at(found))!.statuses!.map((g) => `${g.state}:${g.tone}:${g.badges.map((b) => b.label)}`), ["pending:held:S4"]);
  const end = at(r.frames.length - 1);
  assert.deepEqual(missing(end)!.statuses!.map((g) => `${g.state}:${g.tone}`), ["resolved:done"]);
  const events = Object.values(end.stickies).flat().map((s) => s.event);
  assert.ok(!events.some((e) => /^Deviation/.test(e)), "no separate Deviation… stickies");
  assert.ok(!end.others.some((i) => /Deviation/.test(i.machine)) && !end.side.some((i) => /Deviation/.test(i.machine)), "nor deviation boxes");
});

// A root with its tasks, and something apart from it: enough for the overview's attributes, its stage
// order, the lane of exceptions and a box taken over.
const outside = loadModel(`
overview:
  roots: [Plan]
  hide: [Row]
  exceptions: { types: [Stray], title: Apart }
  attributes: [why]
  attributesWhileOpen: [waiting]
  takenOver: into
  label: { Task: "\${kind}" }
aggregates:
  Plan:
    creators: [Open]
    children: { tasks: { type: Task, via: command.plan, classify: { by: stage, values: [start, final] } } }
    initial: open
    states: { open: { on: { Open: {} } } }
  Stray:
    creators: [Arrive]
    children: { tasks: { type: Task, via: command.stray, classify: { by: stage, values: [start, final] } } }
    initial: open
    states: { open: { on: { Arrive: {} } } }
  Task:
    creators: [AddToPlan, AddToStray]
    data: { kind: { type: string }, stage: { type: string }, into: { type: string, default: "" } }
    children: { rows: { type: Row, via: command.task } }
    initial: open
    states:
      open:
        on:
          AddToPlan: { assign: { kind: command.kind, stage: command.stage } }
          AddToStray: { assign: { kind: command.kind, stage: command.stage } }
          Into: { assign: { into: command.into } }
  Row:
    creators: [Add]
    references: { unit: { type: Unit, via: command.unit } }
    data: { why: { type: string, default: "" }, waiting: { type: string, default: "" } }
    initial: open
    states:
      open:
        on:
          Add: { assign: { why: command.why, waiting: "'at_the_desk'" } }
          Happen: { target: done, emit: [ Happened: { unit: "\${unit}", why: "\${why}" } ] }
      done: { final: true }
  Unit:
    creators: [Register]
    initial: here
    states:
      here:
        on:
          Register: {}
`);

const outsideRun = (steps: string) => {
  const sc = parseScenario(`
scenario: outside
given:
  at: 2026-01-01T00:00:00Z
  send:
    - Unit#U1.Register: {}
    - Plan#P.Open: {}
    - Task#final.AddToPlan: { plan: P, kind: closing, stage: final }
    - Row#R1.Add: { task: final, unit: U1, why: "" }
    - Task#start.AddToPlan: { plan: P, kind: opening, stage: start }
    - Row#R2.Add: { task: start, unit: U1, why: "by mistake" }
    - Stray#S.Arrive: {}
    - Task#stray.AddToStray: { stray: S, kind: opening, stage: start }
when:
${steps}
then: []
`);
  const r = play(outside, actionsOf(sc), fifo, sc.given.at);
  const { config, errors } = overviewConfig(outside);
  assert.deepEqual(errors, []);
  return buildOverview(outside, r.frames[r.frames.length - 1]!, r.world.log, config);
};

test("a classified relation is drawn in the order of its classes, whenever each was created", () => {
  const o = outsideRun("  - send: { Unit#U1.Register: {} }");
  assert.deepEqual(o.roots[0]!.groups[0]!.children.map((c) => c.key), ["Task#start", "Task#final"]);
});

test("an attribute shows with the unit: from a folded child's data, and from an event", () => {
  const o = outsideRun("  - send: { Unit#U1.Register: {} }");
  const start = find(o.roots, "Task#start")!;
  assert.deepEqual(start.summaries[0]!.byState[0]!.items, [{ key: "Unit#U1", label: "U1", note: "by mistake · at the desk" }], "in plain words");
  const happened = outsideRun("  - send: { Row#R2.Happen: {} }");
  assert.deepEqual(happened.stickies["Task#start"]![0]!.badges, [{ key: "Unit#U1", label: "U1", note: "by mistake" }]);
  const ended = find(happened.roots, "Task#start")!;
  assert.deepEqual(ended.summaries[0]!.byState[0]!.items, [{ key: "Unit#U1", label: "U1", note: "by mistake" }], "an attribute only while open goes when it ends, the other stays");
});

test("an exception is its own lane, titled by the model, not a link, until something else takes it over", () => {
  const o = outsideRun("  - send: { Unit#U1.Register: {} }");
  assert.deepEqual(o.exceptions.map((b) => b.key), ["Stray#S"]);
  assert.equal(overviewConfig(outside).config.exceptionsTitle, "Apart");
  assert.deepEqual(o.others, []);
  const taken = outsideRun("  - send: { Task#stray.Into: { into: \"Task#start\" } }");
  assert.deepEqual(taken.exceptions, [], "with nothing left under it, it is left out");
});

test("a box taken over is no longer drawn, and what happened in it shows on what took it over", () => {
  const sc = parseScenario(`
scenario: taken over
given:
  at: 2026-01-01T00:00:00Z
  send:
    - Unit#U1.Register: {}
    - Plan#P.Open: {}
    - Task#start.AddToPlan: { plan: P, kind: opening, stage: start }
    - Stray#S.Arrive: {}
    - Task#stray.AddToStray: { stray: S, kind: opening, stage: start }
    - Row#R.Add: { task: stray, unit: U1, why: "" }
when:
  - send: { Row#R.Happen: {} }
then: []
`);
  const r = play(outside, actionsOf(sc), fifo, sc.given.at);
  const { config } = overviewConfig(outside);
  const before = buildOverview(outside, r.frames[r.frames.length - 1]!, r.world.log, config);
  assert.ok(before.stickies["Task#stray"]?.some((s) => s.event === "Happened"), "first on the box it happened in");
  const sc2 = parseScenario(`
scenario: taken over
given:
  at: 2026-01-01T00:00:00Z
  send:
    - Unit#U1.Register: {}
    - Plan#P.Open: {}
    - Task#start.AddToPlan: { plan: P, kind: opening, stage: start }
    - Stray#S.Arrive: {}
    - Task#stray.AddToStray: { stray: S, kind: opening, stage: start }
    - Row#R.Add: { task: stray, unit: U1, why: "" }
when:
  - send: { Row#R.Happen: {} }
  - send: { Task#stray.Into: { into: "Task#start" } }
then: []
`);
  const r2 = play(outside, actionsOf(sc2), fifo, sc2.given.at);
  const after = buildOverview(outside, r2.frames[r2.frames.length - 1]!, r2.world.log, config);
  assert.equal(after.stickies["Task#stray"], undefined);
  assert.ok(after.stickies["Task#start"]?.some((s) => s.event === "Happened"), "then on the box that took it over");
});

test("exceptions can be a plain list, with no title", () => {
  const plain = loadModel(`
overview: { exceptions: [Thing] }
aggregates:
  Thing:
    creators: [Make]
    initial: here
    states: { here: { on: { Make: {} } } }
`);
  const { config, errors } = overviewConfig(plain);
  assert.deepEqual(errors, []);
  assert.deepEqual(config.exceptions, ["Thing"]);
  assert.equal(config.exceptionsTitle, undefined);
});

test("the overview's attributes and takenOver name fields that exist", () => {
  const bad = loadModel(`
overview: { attributes: [nope], takenOver: nothing }
aggregates:
  Thing:
    creators: [Make]
    initial: here
    states: { here: { on: { Make: {} } } }
`);
  const { errors } = overviewConfig(bad);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /overview\.attributes.*nope/);
  assert.match(errors[1]!, /overview\.takenOver.*nothing/);
});

test("badges with the same note share a row, the note said once", () => {
  const a = { key: "U#1", label: "1", note: "late" }, b = { key: "U#2", label: "2", note: "late" };
  const c = { key: "U#3", label: "3" }, d = { key: "U#4", label: "4", note: "lost" };
  assert.deepEqual(byNote([a, c, b, d]), [
    { note: "late", items: [a, b] },
    { items: [c] },
    { note: "lost", items: [d] },
  ]);
});

// ADR 0023: a desk asks for a decision about a parcel; only what happens to a parcel is an event of
// the overview, and the ask is a marker on the desk, open until the parcel's decision is taken.
const DESK = `
context: T
aggregates:
  Parcel:
    creators: [Scan]
    initial: here
    states:
      here:
        on:
          Scan: { emit: [ Scanned: { parcel: "\${id}" } ] }
          Decide: { emit: [ Decided: { parcel: "\${id}" } ] }
  Desk:
    creators: [Ask]
    references:
      parcel: { type: Parcel, via: command.parcel }
    initial: open
    states:
      open:
        on:
          Ask: { emit: [ DeskBooked: { desk: "\${id}" }, DecisionAsked: { desk: "\${id}", parcel: "\${command.parcel}" }, Noted: { desk: "\${id}", parcel: "\${command.parcel}" } ] }
overview:
  roots: [Desk]
  side: [Parcel]
  hide: []
  events:
    place: raised
    of: [Parcel]
    asks:
      DecisionAsked: { mark: decision, icon: "?", answered: [Decided] }
`;

test("events.of shows only what is about the subject; an ask is a marker, open until answered (ADR 0023)", () => {
  const model = loadModel(DESK);
  const { config, errors } = overviewConfig(model);
  assert.deepEqual(errors, []);
  const r = play(model, [
    { kind: "send", ref: "Parcel#P1.Scan", payload: {} },
    { kind: "send", ref: "Desk#D1.Ask", payload: { parcel: "P1" } },
    { kind: "send", ref: "Parcel#P1.Decide", payload: {} },
  ], fifo);
  const asked = r.frames.findIndex((f) => Object.keys(f.instances).includes("Desk#D1"));
  const at = (i: number, mode?: "statuses" | "requests" | "all") => buildOverview(model, r.frames[i]!, r.world.log, mode ? withEventsMode(config, mode) : config);

  const waiting = at(asked);
  assert.deepEqual((waiting.stickies["Desk#D1"] ?? []).map((s) => s.event), ["Noted"], "about the parcel: shown; the desk's own booking: not; the ask: a marker");
  const [mark] = waiting.asks["Desk#D1"] ?? [];
  assert.equal(mark?.mark, "decision");
  assert.deepEqual(mark?.occurrences.map((o) => [o.subject, o.label, o.answer]), [["Parcel#P1", "P1", undefined]], "about P1, and waiting");

  const done = at(r.frames.length - 1);
  assert.equal(done.asks["Desk#D1"]?.[0]?.occurrences[0]?.answer?.event, "Decided", "the parcel's decision answers it");

  assert.deepEqual(at(asked, "statuses").asks, {}, "statuses only: no markers");
  const all = (at(asked, "all").stickies["Desk#D1"] ?? []).map((s) => s.event).sort();
  assert.deepEqual(all, ["DecisionAsked", "DeskBooked", "Noted"], "every event: nothing hidden, the ask an event like any other");

  const shown = loadModel(DESK.replace("    of: [Parcel]\n", "    of: [Parcel]\n    show: [DeskBooked]\n"));
  const r2 = play(shown, [{ kind: "send", ref: "Desk#D1.Ask", payload: { parcel: "P1" } }], fifo);
  assert.ok((buildOverview(shown, r2.frames[r2.frames.length - 1]!, r2.world.log, overviewConfig(shown).config).stickies["Desk#D1"] ?? []).some((s) => s.event === "DeskBooked"), "show: shown whatever of: says");

  const wrong = loadModel(DESK.replace("answered: [Decided]", "answered: [Decide]").replace("of: [Parcel]", "of: [Parcle]"));
  assert.deepEqual(overviewConfig(wrong).errors, [
    "overview.events.of: there is no aggregate called `Parcle`",
    "overview.events.asks.DecisionAsked.answered: no event the model raises is called `Decide`",
  ]);
});

test("ADR 0027: an event is owned by the role that sent it; under a box of another role it is from elsewhere", () => {
  const { overview } = run(lab, "lab/01-two-tubes-to-the-lab.yaml");
  const all = Object.entries(overview.stickies).flatMap(([box, list]) => list.map((s) => ({ box, ...s })));
  // The courier's pick-up completes the clinic's step: Carrying's scan, under a box Collecting works.
  const across = all.filter((s) => s.foreign);
  assert.ok(across.length > 0, "the pick-up shows up under the clinic's step");
  for (const s of across) {
    assert.equal(s.owner?.role, "Carrying");
    assert.equal(s.owner?.sender, "Courier app");
    assert.equal(s.foreign?.boxRole, "Collecting");
    assert.ok(s.box.startsWith("Site"), s.box);
  }
  // Owned: a bench scan under the analysis it moves.
  assert.ok(all.some((s) => s.owner?.role === "Testing" && !s.foreign && s.box.startsWith("Analysis")));
});

test("ADR 0027 §4: an event shows under its own role's task that heard it, though nothing changed there", () => {
  // The courier's pickup task hears PickedUp and stays as it is; the scan still completes the clinic's step.
  const text = readFileSync(new URL("models/lab.yaml", examples), "utf8")
    .replace("PickedUp: { guard: kind == 'pickup' and command.site == site, target: completed }", "PickedUp: { guard: kind == 'pickup' and command.site == site }");
  const heard = loadModel(text);
  const { overview } = run(heard, "lab/01-two-tubes-to-the-lab.yaml");
  const where = Object.entries(overview.stickies).filter(([, list]) => list.some((s) => s.event === "PickedUp")).map(([box]) => box.slice(0, box.indexOf("#")));
  assert.ok(where.some((t) => t.startsWith("Transfer")), `on its own side too: ${where.join(", ")}`);
  assert.ok(where.some((t) => t.startsWith("Site")), `and where it moved the other role's step: ${where.join(", ")}`);
  const own = Object.entries(overview.stickies).filter(([b]) => b.startsWith("Transfer")).flatMap(([, l]) => l).find((s) => s.event === "PickedUp");
  assert.equal(own?.foreign, undefined, "owned there");
});
