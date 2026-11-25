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
