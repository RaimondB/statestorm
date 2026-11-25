import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextMap, loadModel } from "@statestorm/kernel";
import { endsOf, layoutMap } from "../src/context-map.ts";

const lab = loadModel(readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8"));

test("the map lays upstream above downstream, and draws each edge the way its messages travel (ADR 0035)", async () => {
  const laid = await layoutMap(contextMap(lab, "subsystem", "Lab"));
  const node = (id: string) => laid.nodes.find((n) => n.id === id)!;
  // The sample's part is the one every other part hears: above them.
  assert.ok(node("Logistics").y < node("Bench").y, "Logistics above Bench");
  assert.ok(node("Logistics").y < node("Ordering").y, "Logistics above Ordering");
  // Bench sends Logistics a command: laid out from Logistics down, drawn from Bench up to it.
  const ask = laid.edges.find((e) => e.from === "Bench" && e.to === "Logistics")!;
  const start = ask.points[0]!, end = ask.points[ask.points.length - 1]!;
  assert.ok(Math.abs(start.y - node("Bench").y) < Math.abs(start.y - (node("Logistics").y + node("Logistics").height)) + 1, "starts at Bench");
  assert.ok(end.y <= node("Logistics").y + node("Logistics").height + 1, "ends at Logistics, where the arrowhead is");
  assert.deepEqual(endsOf(ask).map((x) => x.text), ["D", "U"], "D at Bench's end, U at Logistics'");
  const heard = laid.edges.find((e) => e.from === "Logistics" && e.to === "Bench")!;
  assert.deepEqual(endsOf(heard).map((x) => x.text), ["U", "D"]);
  assert.deepEqual(endsOf(laid.edges.find((e) => e.from === "Scanners")!), [], "an outside system's edge: nothing known, nothing drawn");
});

test("an edge is drawn as what crosses it, apart (ADR 0038): events heard, commands sent, what unplaced policies carry", async () => {
  const { drawnEdges } = await import("../src/context-map.ts");
  const edge = {
    from: "Shop", to: "Warehouse", events: ["Placed"], commands: ["Ledger.Note", "Receipt.Print"], patterns: ["customer-supplier"], policies: ["pick", "note", "receipt"],
    downstream: ["Warehouse"], heard: ["Placed"], sends: ["Ledger.Note"], unplaced: { events: ["Placed"], commands: ["Receipt.Print"], policies: ["receipt"] },
  };
  const drawn = drawnEdges([edge]);
  assert.deepEqual(drawn.map((d) => [d.kind, d.events, d.commands]), [
    ["event", ["Placed"], []], ["command", [], ["Ledger.Note"]], ["unplaced", ["Placed"], ["Receipt.Print"]],
  ]);
  assert.deepEqual(drawn.map((d) => d.patterns.length), [1, 0, 0], "the declared pattern once");
  assert.deepEqual(drawn[2]!.downstream, [], "placed nowhere: nobody known to depend");
  // In a model not placing yet, an event is drawn with what it became — one orange edge, as before.
  const notYet = { ...edge, sends: [], unplaced: { events: [], commands: [], policies: [] }, commands: ["Receipt.Print"] };
  assert.deepEqual(drawnEdges([notYet]).map((d) => [d.kind, d.commands]), [["event", ["Receipt.Print"]]]);
});

test("a pair is laid out and labelled once; what crosses it runs as strands beside that route (ADR 0038)", async () => {
  const { strandsOf, endsOf, STRAND_GAP } = await import("../src/context-map.ts");
  const edge = {
    from: "Shop", to: "Warehouse", events: ["Placed"], commands: ["Ledger.Note"], patterns: [], policies: ["pick", "note"],
    downstream: ["Warehouse"], heard: ["Placed"], sends: ["Ledger.Note"], unplaced: { events: [], commands: [], policies: [] },
  };
  const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const label = { x: 40, y: -8, width: 50, height: 16, text: "Placed +1" };
  const s = strandsOf(edge, route, label);
  assert.deepEqual(s.map((e) => e.kind), ["event", "command"]);
  assert.deepEqual(s.map((e) => e.points.map((p) => p.y)), [[-STRAND_GAP / 2, -STRAND_GAP / 2], [STRAND_GAP / 2, STRAND_GAP / 2]], "side by side along the one route");
  assert.deepEqual(s.map((e) => e.points.map((p) => p.x)), [[0, 100], [0, 100]]);
  assert.deepEqual(s.map((e) => e.label?.text), ["Placed +1", undefined], "one label for the pair, where it always was");
  assert.deepEqual(s.map((e) => endsOf(e).length), [2, 0], "U and D once");
  assert.deepEqual(strandsOf({ ...edge, sends: [], commands: [] }, route).map((e) => e.points), [route], "one kind: on the route itself");
});
