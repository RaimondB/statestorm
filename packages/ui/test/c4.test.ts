import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { c4Of, loadModel } from "@statestorm/kernel";
import { along, c4LabelOf, layoutC4, wrap } from "../src/c4.ts";
import type { C4View } from "@statestorm/kernel";
import { estimate } from "../src/chart-layout.ts";

const lab = loadModel(readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8"));
const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) =>
  p.x >= b.x - 0.5 && p.y >= b.y - 0.5 && p.x <= b.x + b.width + 0.5 && p.y <= b.y + b.height + 0.5;

test("the container diagram lays a system's containers inside its boundary, and its neighbours outside (ADR 0036)", async () => {
  const laid = await layoutC4(c4Of(lab, "container", { systems: ["Lab"], contexts: [] }));
  const lab_ = laid.boundaries.find((b) => b.name === "Lab")!;
  for (const n of laid.nodes) {
    const box = { x: n.x, y: n.y, width: n.width, height: n.height };
    const within = inside({ x: box.x, y: box.y }, lab_) && inside({ x: box.x + box.width, y: box.y + box.height }, lab_);
    assert.equal(within, n.boundary === "Lab", `${n.name} ${n.boundary ? "inside" : "outside"} the boundary`);
  }
  // Every edge is routed, from one of its boxes to the other — across the boundary too.
  for (const e of laid.edges) {
    assert.ok(e.points.length >= 2, `${e.from} → ${e.to} is routed`);
    const near = (p: { x: number; y: number }, id: string) => {
      const n = laid.nodes.find((x) => x.id === id)!;
      return inside(p, { x: n.x - 2, y: n.y - 2, width: n.width + 4, height: n.height + 4 });
    };
    assert.ok(near(e.points[0]!, e.from) && near(e.points[e.points.length - 1]!, e.to), `${e.from} → ${e.to} starts at its sender and ends at its receiver`);
    if (e.label) assert.ok(inside({ x: e.label.x, y: e.label.y }, { x: 0, y: 0, width: laid.width, height: laid.height }), "its label on the page");
  }
  // Upstream above, as on the map: every part hears the sample's part.
  const y = (name: string) => laid.nodes.find((n) => n.name === name)!.y;
  assert.ok(y("Logistics") < y("Bench") && y("Logistics") < y("Ordering"));
});

test("a box's note wraps to its width and stops after three lines; an edge's label names the first of what crosses it, and how many more", () => {
  assert.deepEqual(wrap("the request and its route", 1000, estimate), ["the request and its route"]);
  const long = wrap("one two three four five six seven eight nine ten eleven twelve thirteen", 60, estimate);
  assert.equal(long.length, 3);
  assert.match(long[2]!, /…$/);
  const edge = c4Of(lab, "container", { systems: [], contexts: ["Testing"] }).edges.find((e) => e.from === "subsystem:Lab/Logistics")!;
  assert.match(c4LabelOf(edge), /^SiteDescribed \+\d+$/);
});

test("many neighbours wrap into rows of four, and each label sits on its own edge near its neighbour (ADR 0036)", async () => {
  // A focus nine systems send to, and two it tells: one row of nine was as wide as all of them.
  const senders = Array.from({ length: 9 }, (_, i) => `system:Sender ${i + 1}`), told = ["system:Told 1", "system:Told 2"];
  const edge = (from: string, to: string, what: string) => ({ from, to, events: [what, `${what}Again`], commands: [], patterns: [], policies: [], downstream: [to],
    heard: [what, `${what}Again`], sends: [], unplaced: { events: [], commands: [], policies: [] } });
  const view: C4View = {
    diagram: "context", focus: { systems: ["Hub"], contexts: [] },
    nodes: [{ id: "system:Hub", name: "Hub", kind: "system", focus: true },
      ...[...senders, ...told].map((id) => ({ id, name: id.slice(7), kind: "system" as const, focus: false }))],
    boundaries: [],
    edges: [...senders.map((s, i) => edge(s, "system:Hub", `Sent${i}`)), ...told.map((t, i) => edge("system:Hub", t, `Told${i}`))],
  };
  const laid = await layoutC4(view);
  const rows = new Map<number, number>();
  for (const n of laid.nodes.filter((x) => x.name.startsWith("Sender"))) rows.set(Math.round(n.y), (rows.get(Math.round(n.y)) ?? 0) + 1);
  assert.deepEqual([...rows.values()].sort(), [1, 4, 4], "nine senders in rows of four, four and one");
  const hub = laid.nodes.find((n) => n.name === "Hub")!;
  assert.ok(laid.nodes.filter((n) => n.name.startsWith("Sender")).every((n) => n.y + n.height < hub.y), "every sender above the hub");
  assert.ok(laid.nodes.filter((n) => n.name.startsWith("Told")).every((n) => n.y > hub.y + hub.height), "those it tells below");
  const boxes = [...laid.nodes, ...laid.edges.map((e) => e.label!)];
  for (const e of laid.edges) {
    const l = e.label!;
    assert.match(l.text, /^(Sent|Told)\d \+1$/);
    const line = e.from === "system:Hub" ? [...e.points].reverse() : e.points;
    const onLine = Array.from({ length: 600 }, (_, d) => along(line, d * 2)).some((p) => Math.hypot(l.x - 2 - p.x, l.y + 8 - p.y) < 1);
    assert.ok(onLine, `${e.from} → ${e.to}: its label starts on its own line`);
    const over = boxes.filter((b) => b !== l && l.x < b.x + b.width && b.x < l.x + l.width && l.y < b.y + b.height && b.y < l.y + l.height);
    assert.deepEqual(over, [], `${l.text} covers no box and no other label`);
  }
  assert.ok(laid.width < 1300, `as wide as four boxes, not nine (${Math.round(laid.width)})`);
});
