import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { loadModel } from "@statestorm/kernel";
import { parseScenario } from "@statestorm/scenarios";
import { assignScenarios, offDrawing, parseDrawing, tagFindings } from "../src/check/drawings.ts";
import { layoutFlow, type FlowGraph } from "../src/flow.ts";
import { drawingBoard, EXTRA_LANE, referencesOf, scenarioGroups, tagGroups, tagMatches } from "../src/groups.ts";
import { fileURLToPath } from "node:url";
import { readScenario } from "@statestorm/scenarios/files";

const examples = new URL("../../examples/", import.meta.url);
const lab = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8"));

const DRAWING = `
drawing: Inside the hospital
lanes:
  Ward: [Drawn, Walked over, Packed, Sent by tube]
  Lab: [Received, In the queue, Analysed]
outside: [Cancelled request]
names: { Drawn: Collected, Walked over: Delivered, Sent by tube: PickedUp, In the queue: Queued }
paths:
  main: { colour: black }
  cancelled request: { colour: blue, meaning: Cancelled request, scenarios: [39] }
arrows:
  - Drawn -> Walked over
  - Walked over -> Received
  - Received -> In the queue
  - In the queue -> Analysed
  - Packed -> Sent by tube
  - Drawn -> Packed: { open: "Q-2" }
  - Cancelled request -> Drawn: { path: cancelled request, no: "a trigger" }
  - Received -> Analysed: { path: cancelled request }
`;
const d = parseDrawing(lab, DRAWING, "ward.yaml");

test("each scenario is in the group of the drawing it names; the rest on no drawing", () => {
  const walkers = [
    { file: "07-by-tube", drawing: "ward" },
    { file: "08-walked-over", drawing: "ward" },
    { file: "50-other" },
    { file: "51-typo", drawing: "wrad" },
  ];
  assert.deepEqual(scenarioGroups([d], walkers), [
    { id: "ward", title: "Inside the hospital", files: ["07-by-tube", "08-walked-over"] },
    { id: "", title: "On no drawing", files: ["50-other", "51-typo"] },
  ]);
  const drawings = [parseDrawing(lab, DRAWING, "ward.yaml")];
  const { errors, none } = assignScenarios(drawings, walkers);
  assert.deepEqual(drawings[0]!.scenarios, ["07-by-tube", "08-walked-over"]);
  assert.deepEqual(none, ["50-other"]);
  assert.match(errors.join("\n"), /51-typo: drawing `wrad` — there is no such drawing/);
});

test("a drawing that still lists its scenarios is told to let the scenarios name it", () => {
  assert.match(parseDrawing(lab, "drawing: t\nscenarios: [07]\nlanes: {}\narrows: []\n", "t.yaml").errors.join(), /a scenario names its drawing now/);
});

test("every bundled lab scenario names a drawing that exists, so each is in exactly one group", () => {
  const dir = new URL("drawings/lab/", examples);
  const drawings = readdirSync(dir).filter((f) => f.endsWith(".yaml") && f !== "issues.yaml").map((f) => parseDrawing(lab, readFileSync(new URL(f, dir), "utf8"), f));
  for (const dr of drawings) assert.deepEqual(dr.errors, [], dr.file);
  const sdir = new URL("scenarios/lab/", examples);
  const walkers = readdirSync(sdir).filter((f) => f.endsWith(".yaml")).map((f) => ({ file: f.replace(/\.yaml$/, ""), drawing: readScenario(fileURLToPath(new URL(f, sdir)), f).drawing }));
  const { errors, none } = assignScenarios(drawings, walkers);
  assert.deepEqual(errors, []);
  assert.deepEqual(none, []);
  const groups = scenarioGroups(drawings, walkers);
  assert.equal(groups.flatMap((g) => g.files).length, walkers.length);
  assert.ok(groups.every((g) => g.id !== ""));
});

test("per drawing: the arrows its own scenarios walk that it does not draw, and where else they are drawn", () => {
  const other = parseDrawing(lab, `
drawing: Other
lanes: { Lab: [In the queue, Too old to run] }
names: { In the queue: Queued, Too old to run: StabilityExpired }
arrows: [ In the queue -> Too old to run ]
`, "other.yaml");
  const walkers = [{ file: "07-by-tube", drawing: "ward" }, { file: "08-x", drawing: "ward" }, { file: "60-y", drawing: "other" }];
  const pairs: Record<string, string[]> = {
    "07-by-tube": ["Collected Delivered", "Queued StabilityExpired"],
    "08-x": ["Queued StabilityExpired", "Released Received"],
    "60-y": ["Queued StabilityExpired"],
  };
  const issue = (id: string, status: "to confirm" | "done", drawings: string[]) =>
    ({ id, drawings, says: "", should: "", why: "", status, arrows: ["Released Received"] });
  // Raised for this drawing (and not done): said so. Raised for another drawing, or done: not.
  const issues = [issue("D-1", "to confirm", ["ward"]), issue("D-2", "to confirm", ["other"]), issue("D-3", "done", ["ward"])];
  const off = offDrawing([d, other], walkers, (f) => new Set(pairs[f]), issues);
  assert.deepEqual(off.get("ward"), [
    { from: "Queued", to: "StabilityExpired", scenarios: ["07-by-tube", "08-x"], elsewhere: ["other"], raised: [] },
    { from: "Released", to: "Received", scenarios: ["08-x"], elsewhere: [], raised: ["D-1"] },
  ]);
  assert.deepEqual(off.get("other"), []);
});

// A board as buildFlow gives it: ids are `event@board lane`.
const shown = (edges: [string, string, number][]): FlowGraph => {
  const ids = [...new Set(edges.flatMap(([a, b]) => [a, b]))];
  return {
    lanes: [...new Set(ids.map((i) => i.split("@")[1]!))],
    nodes: ids.map((id) => ({ id, event: id.split("@")[0]!, lane: id.split("@")[1]!, count: 1, tone: "done" as const })),
    edges: edges.map(([from, to, count]) => ({ from, to, count })),
    left: [],
  };
};

test("a drawing laid over the runs: drawn and shown, a gap, decided, and what the model would change", () => {
  const runs = shown([
    ["Collected@Ward", "Delivered@Ward", 2],
    ["Delivered@Ward", "Received@Lab", 2],
    ["Received@Lab", "Queued@Lab", 2],
    ["Queued@Lab", "Analysed@Lab", 1],
    ["Queued@Lab", "StabilityExpired@Lab", 1],     // not drawn: a change
    ["Collected@Ward", "Packed@Ward", 1],          // decided open, shown anyway
  ]);
  const board = drawingBoard(d, runs, true);
  const mark = (from: string, to: string) => board.edges.find((e) => e.from === from && e.to === to)?.mark;
  assert.equal(mark("Collected@Ward", "Delivered@Ward"), "drawn");
  assert.equal(mark("Packed@Ward", "PickedUp@Ward"), "missing");
  assert.equal(mark("Collected@Ward", "Packed@Ward"), "anyway");
  assert.equal(mark("Queued@Lab", "StabilityExpired@Lab"), "proposed");
  // The drawing's own words; a status it has no box for comes along, marked extra, in its lane.
  assert.equal(board.nodes.find((n) => n.id === "Collected@Ward")?.label, "Drawn");
  assert.equal(board.nodes.find((n) => n.event === "StabilityExpired")?.extra, true);
  assert.equal(board.outside, 1);
  assert.deepEqual(board.lanes, ["Ward", "Lab"]);
  // Not the drawing's own runs: a drawn arrow they do not show is no gap.
  assert.equal(drawingBoard(d, runs, false).edges.find((e) => e.from === "Packed@Ward")?.mark, "unwalked");
  // An extra status in a lane the drawing does not have goes to a lane of its own.
  const other = drawingBoard(d, shown([["Collected@Ward", "Missing@Transport", 1]]), true);
  assert.equal(other.nodes.find((n) => n.event === "Missing")?.lane, EXTRA_LANE);
  assert.equal(other.lanes.at(-1), EXTRA_LANE);
  // A path that names its own scenarios is judged by those, when the drawing's own runs are shown.
  const onPath = (b: ReturnType<typeof drawingBoard>) => b.edges.find((e) => e.from === "Received@Lab" && e.to === "Analysed@Lab")?.mark;
  assert.equal(onPath(board), "missing");
  assert.equal(onPath(drawingBoard(d, runs, true, [], { "cancelled request": shown([["Received@Lab", "Analysed@Lab", 1]]) })), "drawn");
  // It lays out like any board, the drawn-only boxes in their place, not dropped to the bottom.
  const layout = layoutFlow(board);
  const y = (id: string) => layout.nodes.find((n) => n.id === id)!.y;
  assert.ok(y("PickedUp@Ward") > y("Packed@Ward"));
});

test("tags: every haemolysed sample together, the kinds first; one kind each, and a happy path per drawing (MC-15)", () => {
  const walkers = [
    { file: "02-x", drawing: "ward", tags: ["deviation", "haemolysed"] },
    { file: "03-x", drawing: "ward", tags: ["deviation", "haemolysed", "missing"] },
    { file: "50-y", drawing: "ward", tags: ["happy", "deviation"] },
    { file: "51-z", drawing: "ward" },
  ];
  assert.deepEqual(tagGroups(walkers).map((g) => [g.id, g.files.length]), [["#deviation", 3], ["#happy", 1], ["#haemolysed", 2], ["#missing", 1]]);
  const findings = tagFindings([d], walkers);
  assert.match(findings.join("\n"), /50-y: tag it happy or deviation — not both/);
  assert.match(findings.join("\n"), /51-z: tag it happy or deviation — it has neither/);
  assert.equal(findings.filter((f) => f.includes("no happy path")).length, 0, "50-y is tagged happy, even if wrongly");
  assert.match(tagFindings([d], walkers.slice(0, 2)).join("\n"), /ward.yaml: no happy path among its 2 scenarios/);
});

test("tags: a reference to an outside list (WOM-12) is grouped by its prefix, in number order, led by every one of them", () => {
  const walkers = [
    { file: "02-x", tags: ["deviation", "haemolysed", "WOM-10", "LFMT-280"] },
    { file: "03-x", tags: ["happy", "WOM-2"] },
    { file: "04-x", tags: ["happy"] },
  ];
  assert.deepEqual(tagGroups(walkers).map((g) => [g.title, g.section, g.files]), [
    ["deviation", "kind", ["02-x"]],
    ["happy", "kind", ["03-x", "04-x"]],
    ["haemolysed", "topic", ["02-x"]],
    ["LFMT-*", "LFMT", ["02-x"]],
    ["LFMT-280", "LFMT", ["02-x"]],
    ["WOM-*", "WOM", ["02-x", "03-x"]],
    ["WOM-2", "WOM", ["03-x"]],
    ["WOM-10", "WOM", ["02-x"]],
  ]);
  assert.ok(tagMatches(["WOM-10"], "WOM-*") && !tagMatches(["WOM-10"], "WOM-1") && !tagMatches(["WOMBAT"], "WOM-*"));
  assert.deepEqual(referencesOf(["deviation", "WOM-10", "WOM-2", "x-y"]), ["WOM-2", "WOM-10"]);
});
