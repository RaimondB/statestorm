import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "@statestorm/kernel";
import { parseScenario } from "@statestorm/scenarios";
import { buildOverview, overviewConfig, withEventsMode, type Box } from "../src/overview.ts";
import { buildJourney, stationsOf, type Station } from "../src/journey.ts";
import { actionsOf, play } from "../src/session.ts";
import { fileURLToPath } from "node:url";
import { readScenario } from "@statestorm/scenarios/files";

// ADR 0024, on the lab example: a request over its route, the route's steps laid out by which follows
// which, its own tasks end to end in a band, the samples on the side.
const examples = new URL("../../examples/", import.meta.url);
const lab = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8"));
const journeyOf = (name: string, mode?: "statuses" | "requests" | "all") => {
  const sc = readScenario(fileURLToPath(new URL(`scenarios/lab/${name}.yaml`, examples)));
  const r = play(lab, actionsOf(sc), sc.schedule ?? { kind: "fifo" }, sc.given.at);
  const frame = r.frames[r.frames.length - 1]!;
  const base = overviewConfig(lab).config;
  const config = mode ? withEventsMode(base, mode) : base;
  const o = buildOverview(lab, frame, r.world.log, config);
  return { o, j: buildJourney(lab, frame, r.world.log, config, o), log: r.world.log };
};
const boxes = (b: Box): Box[] => [b, ...b.groups.flatMap((g) => g.children.flatMap(boxes))];

test("each root is a line; every box of the overview is a station on it, in the overview's order (ADR 0024)", () => {
  const { o, j } = journeyOf("01-two-tubes-to-the-lab");
  assert.deepEqual(j.lines.map((l) => l.key), o.roots.map((r) => r.key));
  const line = j.lines[0]!;
  assert.equal(line.depth, 0);
  assert.deepEqual(new Set(stationsOf(line).map((s) => s.key)), new Set(o.roots.flatMap(boxes).map((b) => b.key)), "nothing lost, nothing added");
  // A route's own tasks, end to end, are a strip on its station; its steps are the line going on.
  const route = stationsOf(line).find((s) => s.machine === "Route")!;
  assert.ok(route.band.length > 0, "the route's tasks as a strip");
  assert.ok(route.tracks.some((t) => t.kind === "line" && !t.inner), "its steps on the line");
});

test("under each station, the events received there in order, each about whom and when; the latest is now", () => {
  const { o, j, log } = journeyOf("01-two-tubes-to-the-lab");
  const all = j.lines.flatMap(stationsOf);
  const rows = all.flatMap((s) => s.rows);
  assert.ok(rows.length > 0);
  for (const s of all) {
    assert.deepEqual(s.rows.map((r) => r.seq), [...s.rows.map((r) => r.seq)].sort((a, b) => a - b), `${s.key}: in order`);
    // The same events as the overview puts on that box — the Journey adds no rule of its own.
    assert.deepEqual(new Set(s.rows.map((r) => r.event)), new Set((o.stickies[s.key] ?? []).map((x) => x.event)), `${s.key}: the overview's events`);
  }
  for (const r of rows) {
    assert.ok(r.badges.length > 0, `${r.event}: about someone`);
    assert.equal(r.at, log.find((e) => e.seq === r.seq)!.at, "its clock is the log's");
  }
  assert.equal(j.now, Math.max(...rows.flatMap((r) => r.seqs)));
  assert.deepEqual(j.units.map((u) => u.label).sort(), ["S1", "S2"], "the samples, to follow one at a time");
});

test("what runs side by side is a branch", () => {
  // Two tubes collected at once: their steps run side by side, and the line joins again after.
  const { o, j } = journeyOf("01-two-tubes-to-the-lab");
  const layer = o.roots.flatMap(boxes).flatMap((b) => b.groups.flatMap((g) => g.layers ?? [])).find((l) => l.length > 1)!;
  const branch = j.lines.flatMap(stationsOf).flatMap((s: Station) => s.tracks).find((t) => t.kind === "branch");
  assert.ok(branch && branch.kind === "branch");
  assert.deepEqual(branch.columns.map((c) => c[0]!.key), layer.map((b) => b.key), "one column per box of the layer");
});

test("journey.together: the lines that share a value are one group — one customer's orders", () => {
  const model = loadModel(`
context: T
aggregates:
  Order:
    creators: [Create]
    data: { salesOrder: { type: string, default: "" } }
    initial: open
    states:
      open:
        on:
          Create: { takes: { salesOrder: string }, assign: { salesOrder: command.salesOrder } }
overview:
  roots: [Order]
  journey:
    label: { Order: "\${salesOrder} · \${id}" }
    together: salesOrder
`);
  const { config, errors } = overviewConfig(model);
  assert.deepEqual(errors, []);
  const r = play(model, [
    { kind: "send", ref: "Order#D1.Create", payload: { salesOrder: "SO-1" } },
    { kind: "send", ref: "Order#R1.Create", payload: { salesOrder: "SO-1" } },
    { kind: "send", ref: "Order#D2.Create", payload: { salesOrder: "SO-2" } },
  ], { kind: "fifo" });
  const frame = r.frames[r.frames.length - 1]!;
  const j = buildJourney(model, frame, r.world.log, config, buildOverview(model, frame, r.world.log, config));
  assert.deepEqual(j.lines.map((l) => [l.id, l.together, l.label]), [["D1", "SO-1", "SO-1 · D1"], ["R1", "SO-1", "SO-1 · R1"], ["D2", "SO-2", "SO-2 · D2"]]);
  assert.deepEqual(overviewConfig(loadModel(`context: T\naggregates:\n  Order: { creators: [Create], initial: open, states: { open: { on: { Create: {} } } } }\noverview: { journey: { together: salesOrder } }\n`)).errors,
    ["overview.journey.together: no aggregate has a field called `salesOrder`"]);
});
