/**
 * A part in focus, laid out as C4 draws it (ADR 0036): the kernel says which boxes, boundaries and
 * edges; this places them with ELK — a system's boundary around its boxes, upstream above, each edge
 * drawn the way its messages travel, as on the context map.
 */
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { C4Boundary, C4Node, C4View, MapEdge } from "@statestorm/kernel";
import { estimate, type Measure } from "./chart-layout.ts";
import { strandsOf, type PlacedEdge } from "./context-map.ts";

export const C4 = { pad: 12, line: 16, minW: 170, noteW: 230, noteLines: 3, boundaryTop: 30, /** Room either side of a name for the ◎ in its corner. */ toggle: 18 };

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

/** An edge's label: its patterns, and the first of what crosses it with how many more — kept short, so ELK
 *  places it in the gap between layers, clear of the U and D. The full lists are in its tooltip and the inspector. */
export function c4LabelOf(e: MapEdge): string {
  const said = [...e.events, ...e.commands.filter((c) => !e.events.includes(c)).map((c) => `${c}()`)];
  return [...e.patterns.map((p) => `«${p}»`), [said[0] ?? "", said.length > 1 ? `+${said.length - 1}` : ""].filter(Boolean).join(" ")]
    .filter(Boolean).join(" ");
}

const boundaryId = (name: string) => `boundary:${name}`;

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
      "elk.spacing.edgeLabel": "6",
      "elk.edgeLabels.inline": "false",
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
    edges: view.edges.map((e, i): ElkExtendedEdge => {
      const text = c4LabelOf(e);
      return { id: `e${i}`, sources: [upward(e) ? e.to : e.from], targets: [upward(e) ? e.from : e.to], labels: text ? [{ id: `l${i}`, text, width: measure(text, "label") + 8, height: 16 }] : [] };
    }),
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
  // ADR 0038: each pair laid out and labelled once, as here; what crosses it drawn as strands beside its route.
  const edges: PlacedEdge[] = view.edges.flatMap((e, i) => {
    const laid = laidEdges.find((x) => x.id === `e${i}`);
    const s = laid?.sections?.[0];
    const laidOut = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
    const points = upward(e) ? laidOut.reverse() : laidOut;
    const l = laid?.labels?.[0];
    return strandsOf(e, points, l && l.text ? { x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0, text: l.text } : undefined);
  });
  return { width: out.width ?? 0, height: out.height ?? 0, nodes, boundaries, edges };
}
