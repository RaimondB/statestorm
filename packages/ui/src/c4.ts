/**
 * A part in focus, laid out as C4 draws it (ADR 0036): the kernel says which boxes, boundaries and
 * edges; this places them with ELK — a system's boundary around its boxes, upstream above, each edge
 * drawn the way its messages travel, as on the context map.
 */
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { C4Boundary, C4Node, C4View, MapEdge } from "@statestorm/kernel";
import { estimate, type Box, type Measure } from "./chart-layout.ts";
import type { PlacedEdge } from "./context-map.ts";

export const C4 = { pad: 12, line: 16, minW: 170, noteW: 230, noteLines: 3, boundaryTop: 30, /** Room either side of a name for the ◎ in its corner. */ toggle: 18,
  /** Neighbours side by side in a row, above the focus or below it; more wrap to the next row. */ perRow: 4,
  /** How far along an edge, from the neighbour's end, its label first tries to sit; the step it moves on by while it covers something, and how often. */ labelAt: 30, labelStep: 14, labelTries: 24 };

export interface PlacedC4Node extends C4Node { x: number; y: number; width: number; height: number; lines: string[]; notes: string[] }
export interface PlacedBoundary extends C4Boundary { x: number; y: number; width: number; height: number }
export interface C4Layout { width: number; height: number; nodes: PlacedC4Node[]; boundaries: PlacedBoundary[]; edges: PlacedEdge[] }

/** Laid out against the way it travels: its one downstream end is where its messages start. */
const upward = (e: MapEdge) => e.downstream.length === 1 && e.downstream[0] === e.from;

/** What a box says under its name, in C4's brackets: what it is, and its context and team. */
export function c4LinesOf(n: C4Node): string[] {
  const kind = n.kind === "external" ? "[External system]" : n.kind === "system" ? "[Software system]"
    : n.kind === "context" ? "[Bounded context]" : n.external ? "[External container]" : "[Container]";
  const owner = n.kind === "subsystem" && n.context && n.context !== n.name ? [`${n.context}${n.team ? ` · team ${n.team}` : ""}`]
    : n.team ? [`team ${n.team}`] : [];
  return [kind, ...owner, ...(n.unmodelled ? ["not modelled yet"] : [])];
}

/** A note wrapped to a box's width, cut after a few lines — the whole of it is in the tooltip and the inspector. */
export function wrap(text: string | undefined, width: number, measure: Measure, max = C4.noteLines): string[] {
  if (!text) return [];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, "label") > width) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out.length > max ? [...out.slice(0, max - 1), `${out[max - 1]}…`] : out;
}

/** An edge's label: its patterns, and the first of what crosses it with how many more — the full lists are in its tooltip and the inspector. */
export function c4LabelOf(e: MapEdge): string {
  const said = [...e.events, ...e.commands.filter((c) => !e.events.includes(c)).map((c) => `${c}()`)];
  return [...e.patterns.map((p) => `«${p}»`), [said[0] ?? "", said.length > 1 ? `+${said.length - 1}` : ""].filter(Boolean).join(" ")]
    .filter(Boolean).join(" ");
}

type Point = { x: number; y: number };
/** The point `d` along a polyline from its first point — its last, if the line is shorter. */
export function along(points: Point[], d: number): Point {
  let left = d;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= left && len > 0) return { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
    left -= len;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

const boundaryId = (name: string) => `boundary:${name}`;

/**
 * Hidden edges that wrap a long row of neighbours (laid out, never drawn): of the neighbours laid above
 * the focus, every one after the first few is pushed a row nearer to it; below, a row further away.
 * Without them every neighbour that only sends to the focus sits in one row, as wide as all of them.
 */
export function rowBreaks(view: C4View, perRow = C4.perRow): ElkExtendedEdge[] {
  const from = (e: MapEdge) => (upward(e) ? e.to : e.from), to = (e: MapEdge) => (upward(e) ? e.from : e.to);
  const free = view.nodes.filter((n) => !n.boundary && !n.focus);
  const above = free.filter((n) => view.edges.some((e) => from(e) === n.id) && !view.edges.some((e) => to(e) === n.id));
  const below = free.filter((n) => view.edges.some((e) => to(e) === n.id) && !view.edges.some((e) => from(e) === n.id));
  const out: ElkExtendedEdge[] = [];
  for (const row of [above, below]) for (let i = 0; i + perRow < row.length; i++) out.push({ id: `row${out.length}`, sources: [row[i]!.id], targets: [row[i + perRow]!.id] });
  return out;
}

export async function layoutC4(view: C4View, measure: Measure = estimate): Promise<C4Layout> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const sized = view.nodes.map((n) => {
    const lines = c4LinesOf(n);
    const notes = wrap(n.note, C4.noteW, measure);
    const width = Math.max(C4.minW, measure(n.name, "title") + 2 * C4.pad + 2 * C4.toggle, ...[...lines, ...notes].map((l) => measure(l, "label") + 2 * C4.pad));
    return { ...n, lines, notes, width, height: C4.pad * 2 + C4.line * (1 + lines.length + notes.length) + (notes.length ? 4 : 0) };
  });
  const leaf = (n: (typeof sized)[number]): ElkNode => ({ id: n.id, width: n.width, height: n.height });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.edgeRouting": "POLYLINE",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "48",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
    },
    children: [
      ...view.boundaries.map((b): ElkNode => ({
        id: boundaryId(b.name),
        layoutOptions: { "elk.padding": `[top=${C4.boundaryTop + 10},left=18,bottom=18,right=18]` },
        // Wide enough for its own label, whatever it holds.
        width: measure(`${b.name} [${b.external ? "External system" : "Software system"}]`, "title") + 40,
        children: sized.filter((n) => n.boundary === b.name).map(leaf),
      })),
      ...sized.filter((n) => !n.boundary).map(leaf),
    ],
    // No labels for ELK: in a layered layout each label is a box of its own in the layer between, and a
    // focus with many neighbours grew several times wider for them. They are placed after (below).
    edges: [
      ...view.edges.map((e, i): ElkExtendedEdge => ({ id: `e${i}`, sources: [upward(e) ? e.to : e.from], targets: [upward(e) ? e.from : e.to] })),
      ...rowBreaks(view),
    ],
  };
  const out = await elk.layout(graph);
  const at = new Map<string, ElkNode>();
  const walk = (ns: ElkNode[] | undefined) => { for (const c of ns ?? []) { at.set(c.id, c); walk(c.children); } };
  walk(out.children);
  const nodes: PlacedC4Node[] = sized.map((n) => ({ ...n, x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 }));
  const boundaries: PlacedBoundary[] = view.boundaries.map((b) => {
    const laid = at.get(boundaryId(b.name));
    return { ...b, x: laid?.x ?? 0, y: laid?.y ?? 0, width: laid?.width ?? 0, height: laid?.height ?? 0 };
  });
  // With hierarchy, ELK keeps an edge in the node that holds both its ends.
  const laidEdges: ElkExtendedEdge[] = [];
  const edgesOf = (n: ElkNode) => { laidEdges.push(...((n.edges ?? []) as ElkExtendedEdge[])); for (const c of n.children ?? []) edgesOf(c); };
  edgesOf(out);
  // A label sits on its edge a little way from the neighbour's end, where the edges of different
  // neighbours are still apart. Where it would cover a label already placed, or a box, it moves on
  // along its line, a step at a time.
  const focused = new Set(view.nodes.filter((n) => n.focus).map((n) => n.id));
  const taken: Box[] = nodes.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
  const overlaps = (a: Box) => taken.some((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height);
  const edges: PlacedEdge[] = view.edges.map((e, i) => {
    const laid = laidEdges.find((x) => x.id === `e${i}`);
    const s = laid?.sections?.[0];
    const laidOut = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
    const points = upward(e) ? laidOut.reverse() : laidOut;
    const text = c4LabelOf(e);
    if (!text || points.length < 2) return { ...e, points };
    const fromNeighbour = !focused.has(e.from) || focused.has(e.to);
    const line = fromNeighbour ? points : [...points].reverse();
    const width = measure(text, "label") + 8;
    const at = (k: number) => { const p = along(line, C4.labelAt + C4.labelStep * k); return { x: p.x + 2, y: p.y - 8, width, height: 16 }; };
    let label = at(0);
    for (let k = 1; k <= C4.labelTries && overlaps(label); k++) label = at(k);
    taken.push(label);
    return { ...e, points, label: { ...label, text } };
  });
  // A label near the right edge may reach past what ELK laid out: the page grows to hold it.
  const width = Math.max(out.width ?? 0, ...edges.map((e) => (e.label ? e.label.x + e.label.width + 12 : 0)));
  return { width, height: out.height ?? 0, nodes, boundaries, edges };
}
