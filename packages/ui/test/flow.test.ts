import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { loadModel, type Model } from "@statestorm/kernel";
import { parseScenario } from "@statestorm/scenarios";
import { buildFlow, flowConfig, layoutFlow, NODE, trailOf } from "../src/flow.ts";
import { overviewConfig } from "../src/overview.ts";
import { actionsOf, play } from "../src/session.ts";
import { fileURLToPath } from "node:url";
import { readScenario } from "@statestorm/scenarios/files";

const examples = new URL("../../examples/", import.meta.url);
const load = (name: string) => loadModel(readFileSync(new URL(`models/${name}.yaml`, examples), "utf8"));
const fifo = { kind: "fifo" } as const;
const runsOf = (model: Model, name: string) => {
  const dir = new URL(`scenarios/${name}/`, examples);
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((f) => {
    const sc = readScenario(fileURLToPath(new URL(f, dir)));
    return play(model, actionsOf(sc), fifo, sc.given.at);
  });
};
const lab = load("lab");

function behind(l: ReturnType<typeof layoutFlow>): string[] {
  return l.edges.flatMap((e) => l.nodes.filter((n) => n.id !== e.from && n.id !== e.to && e.points.some((p, i) => {
    if (i === 0) return false;
    const q = e.points[i - 1]!;
    return Math.min(p[0], q[0]) < n.x + NODE.w && Math.max(p[0], q[0]) > n.x && Math.min(p[1], q[1]) < n.y + NODE.h && Math.max(p[1], q[1]) > n.y;
  })).map((n) => `${e.from} → ${e.to} runs behind ${n.event}`));
}

function board(model: Model, name: string) {
  const { flow, errors } = flowConfig(model);
  const runs = runsOf(model, name);
  return { errors, flow, runs, graph: buildFlow(model, overviewConfig(model).config, flow, runs.map((r) => r.world.log)) };
}

test("the arrows are what followed what for each sample, in every scenario", () => {
  const { errors, graph } = board(lab, "lab");
  assert.deepEqual(errors, []);
  assert.deepEqual(graph.lanes, ["Clinic / sender", "Transport", "Lab"]);
  assert.equal(graph.nodes.find((n) => n.event === "PickedUp")!.lane, "Transport", "the transport has a lane of its own");
  const ev = (id: string) => id.slice(0, id.indexOf("@"));
  const has = (a: string, b: string) => graph.edges.some((e) => ev(e.from) === a && ev(e.to) === b);
  for (const [a, b] of [
    ["Collected", "Packed"], ["Packed", "PickedUp"], ["PickedUp", "Delivered"], ["Delivered", "Received"],
    ["Received", "Queued"], ["Queued", "Analysed"], ["Analysed", "Released"],
    ["PickedUp", "Missing"], ["Missing", "Delivered"], ["Received", "Haemolysed"], ["Delivered", "Rejected"], ["Received", "Packed"],
  ]) assert.ok(has(a!, b!), `${a} → ${b}`);
  assert.equal(graph.nodes.find((n) => n.event === "Received")!.lane, "Lab");
  assert.deepEqual(graph.left, [], "every sample event has a lane");
});

test("an event's colour is what it did: a deviation holds things for a decision, progress completes something", () => {
  const { graph } = board(lab, "lab");
  const tone = (e: string) => graph.nodes.find((n) => n.event === e)?.tone;
  // A deviation status puts the sample's steps on hold until a person confirms or resolves it.
  for (const e of ["Haemolysed", "Missing"]) assert.equal(tone(e), "held", e);
  for (const e of ["Received", "PickedUp", "Released"]) assert.equal(tone(e), "done", e);
  // Rejected on receipt is no deviation: it fails the step at once.
  assert.equal(tone("Rejected"), "failed");
  for (const e of ["Packed", "Queued"]) assert.equal(tone(e), "active", e);
});

test("an event a lane lists but no scenario ever shows is on the board, marked as never shown", () => {
  // Every status the lab's lanes list is shown by some scenario; list one more that is not.
  const text = readFileSync(new URL("models/lab.yaml", examples), "utf8")
    .replace("Clinic / sender: [Collected, Packed, SiteVisit]", "Clinic / sender: [Collected, Packed, PatientInformed, SiteVisit]");
  const model = loadModel(text);
  const { graph } = board(model, "lab");
  const never = graph.nodes.find((n) => n.event === "PatientInformed")!;
  assert.deepEqual([never.count, never.lane], [0, "Clinic / sender"]);
  assert.ok(!graph.edges.some((e) => e.from === never.id || e.to === never.id));
  const l = layoutFlow(graph);
  const y = (e: string) => l.nodes.find((n) => n.event === e)!.y;
  assert.ok(y("PatientInformed") > Math.max(...l.nodes.filter((n) => n.count > 0).map((n) => n.y)), "drawn below everything that happened");
  assert.deepEqual(board(lab, "lab").graph.nodes.filter((n) => n.count === 0).map((n) => n.id), [],
    "the real lanes: every status they list, some scenario shows");
});

test("a status the lanes do not name is drawn where it moved a step — one status, several lanes", () => {
  const { graph } = board(lab, "lab");
  const lanes = (e: string) => graph.nodes.filter((n) => n.event === e).map((n) => n.lane).sort();
  assert.deepEqual(lanes("Delivered"), ["Clinic / sender", "Transport"], "walked over from next door · by courier or tube");
  assert.ok(graph.nodes.filter((n) => n.event === "Delivered").every((n) => n.id === `Delivered@${n.lane}`));
  assert.deepEqual(graph.left, []);
});

test("a status a step raises about a sample is drawn as the sample's: its stability expiring", () => {
  const { graph } = board(lab, "lab");
  const ev = (id: string) => id.slice(0, id.indexOf("@"));
  const into = (e: string) => graph.edges.filter((x) => ev(x.to) === e).map((x) => ev(x.from)).sort();
  assert.deepEqual(graph.nodes.filter((n) => n.event === "StabilityExpired").map((n) => n.lane), ["Lab"]);
  assert.deepEqual(into("StabilityExpired"), ["Received"], "received, and never queued in time");
});

test("laid out in lanes, top to bottom, nothing on top of anything, loops drawn as loops", () => {
  const { graph } = board(lab, "lab");
  const l = layoutFlow(graph);
  for (const n of l.nodes) {
    const lane = l.lanes.find((x) => x.name === n.lane)!;
    assert.ok(n.x >= lane.x && n.x + NODE.w <= lane.x + lane.width, `${n.event} sits in its lane`);
  }
  for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
    const [a, b] = [l.nodes[i]!, l.nodes[j]!];
    const apart = a.x + NODE.w <= b.x || b.x + NODE.w <= a.x || a.y + NODE.h <= b.y || b.y + NODE.h <= a.y;
    assert.ok(apart, `${a.event} and ${b.event} overlap`);
  }
  // No arrow runs behind a box it does not start or end at — in any example's board.
  for (const name of ["lab", "sales", "claims"]) {
    const lay = layoutFlow(board(load(name), name).graph);
    assert.deepEqual(behind(lay), [], name);
  }
  const rank = (e: string) => l.nodes.find((n) => n.event === e)!.rank;
  assert.ok(rank("Collected") < rank("PickedUp") && rank("PickedUp") < rank("Received"));
  assert.ok(l.edges.some((e) => e.back && e.from === "Received@Lab" && e.to === "Packed@Clinic / sender"),
    "sent on to the reference lab: the sender's steps again — a loop back up");
});

test("the run you are stepping through lights what has happened, for every sample or for one", () => {
  const { flow, runs } = board(lab, "lab");
  const run = runs.find((r) => r.world.log.some((e) => e.kind === "event" && e.event === "Haemolysed"))!;
  const cfg = overviewConfig(lab).config;
  const end = run.frames[run.frames.length - 1]!.seq;
  const all = trailOf(lab, cfg, flow, run.world.log, end);
  assert.ok([...all.first.keys()].some((id) => id.startsWith("Haemolysed@")) && all.subjects.length >= 1);
  const early = trailOf(lab, cfg, flow, run.world.log, run.frames[5]!.seq);
  assert.ok(early.first.size < all.first.size, "earlier, less has happened");
  const one = trailOf(lab, cfg, flow, run.world.log, end, all.subjects[0]);
  assert.ok(one.first.size <= all.first.size);
});

test("without configuration: a lane per raising type, and misnamed lanes are errors", () => {
  const sales = load("sales");
  const { graph, errors } = board(sales, "sales");
  assert.deepEqual(errors, []);
  assert.ok(graph.lanes.length >= 2 && graph.nodes.length >= 3);
  // Across lanes: what one aggregate's event caused another to raise.
  const across = graph.edges.filter((e) => graph.nodes.find((n) => n.id === e.from)!.lane !== graph.nodes.find((n) => n.id === e.to)!.lane);
  assert.ok(across.length > 0, "an event that made another aggregate act is linked to what that one raised");
  assert.ok(graph.edges.some((e) => e.from.startsWith("OrderPlaced@") && e.to.startsWith("StockReserved@")));
  const bad = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8").replace("Clinic / sender: [Collected,", "Clinic / sender: [Colected,"));
  assert.deepEqual(flowConfig(bad).errors, ["overview.flow.lanes.Clinic / sender: the model raises no event called `Colected`, and has no type called that"]);
});

test("a status the lanes do not name, whose hold reaches the steps through the sample, is drawn where it moved a step", () => {
  const text = readFileSync(new URL("models/lab.yaml", examples), "utf8");
  // Missing named in no lane; the deviation tells the sample, and the sample tells each step (ADR 0035):
  // pending, resolved and confirmed alike.
  const via = (policy: string, event: string, command: string, hub: string, withs: string) => text.indexOf(`  ${policy}:\n`) >= 0
    ? [`  ${policy}:`, "    in: Logistics", `    on: ${event}`, `    command: "Sample#\${event.sample}.${command}"`, `    with: ${withs}`,
      `  ${policy}_steps:`, "    in: target", `    on: ${hub}`].join("\n") : "";
  let hub = text
    .replace("Lab: [Received, Rejected, Haemolysed, Missing,", "Lab: [Received, Rejected, Haemolysed,")
    .replace("          Stop:\n", [
      "          Hold: { emit: [ SampleHeld: { sample: \"${id}\", event: \"${command.event}\", site: \"${command.site}\" } ] }",
      "          Release: { emit: [ SampleReleased: { sample: \"${id}\" } ] }",
      "          Settle: { emit: [ SampleSettled: { sample: \"${id}\", event: \"${command.event}\", site: \"${command.site}\" } ] }",
      "          Stop:", ""].join("\n"));
  for (const [policy, event, command, heard, withs] of [
    ["hold_for_deviation", "DeviationPending", "Hold", "SampleHeld", '{ event: "${event.event}", site: "${event.site}" }'],
    ["release_on_resolve", "DeviationResolved", "Release", "SampleReleased", "{}"],
    ["deviation_to_handlings", "DeviationConfirmed", "Settle", "SampleSettled", '{ event: "${event.event}", site: "${event.site}" }'],
  ] as const) {
    hub = hub.replace(new RegExp(`  ${policy}:\\n    why: \\[R8\\]\\n    in: target\\n    on: ${event}`), via(policy, event, command, heard, withs));
  }
  assert.equal((hub.match(/_steps:\n/g) ?? []).length, 3, "the three routed through the sample");
  const { graph } = board(loadModel(hub), "lab");
  assert.deepEqual(graph.nodes.filter((n) => n.event === "Missing").map((n) => n.lane), ["Transport"], "the courier's run it held");
  assert.deepEqual(graph.left, []);
});
