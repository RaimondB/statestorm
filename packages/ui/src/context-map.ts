/**
 * The context map laid out (ADR 0018 §4): the kernel derives who talks to whom; this places the
 * nodes and routes the edges with ELK, top to bottom — upstream above: an edge is laid out from its
 * upstream end when one end is known to depend on the other (ADR 0035), and drawn the way its
 * messages travel.
 */
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { ContextMap, MapEdge, MapNode } from "@statestorm/kernel";
import { estimate, type Measure } from "./chart-layout.ts";

export const MAP = { pad: 12, line: 16, minW: 120 };

export interface PlacedNode extends MapNode { x: number; y: number; width: number; height: number; lines: string[] }
/** ADR 0038: an edge as drawn — events heard (orange, dashed), commands sent (blue, solid), or what policies placed nowhere carry (red). */
export type EdgeKind = "event" | "command" | "unplaced";
export interface DrawnEdge extends MapEdge { kind: EdgeKind }
export interface PlacedEdge extends DrawnEdge { points: { x: number; y: number }[]; label?: { x: number; y: number; width: number; height: number; text: string } }

/**
 * ADR 0038: one map edge drawn as what crosses it, apart — the events heard (and what an unplaced
 * policy's event became, in a model not placing yet), the commands sent, and what unplaced policies
 * carry. The declared patterns go with the first; who depends on whom with each, but the unplaced.
 */
export function drawnEdges(edges: MapEdge[]): DrawnEdge[] {
  return edges.flatMap((e) => {
    const out: DrawnEdge[] = [];
    const became = e.commands.filter((c) => !e.sends.includes(c) && !e.unplaced.commands.includes(c));
    if (e.heard.length) out.push({ ...e, kind: "event", events: e.heard, commands: became });
    if (e.sends.length) out.push({ ...e, kind: "command", events: [], commands: e.sends, patterns: out.length ? [] : e.patterns });
    if (e.unplaced.policies.length) out.push({ ...e, kind: "unplaced", events: e.unplaced.events, commands: e.unplaced.commands, policies: e.unplaced.policies, downstream: [], patterns: out.length ? [] : e.patterns });
    return out.length ? out : [{ ...e, kind: "event" }];
  });
}

/** Laid out against the way it travels: its one downstream end is where its messages start (a command sent from there). */
const upward = (e: MapEdge) => e.downstream.length === 1 && e.downstream[0] === e.from;
export interface MapLayout { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[] }

/** What a node says under its name: its kind, who owns it, which systems it spans or holds, its library. */
export function linesOf(n: MapNode): string[] {
  const kind = n.kind === "external" ? "«external system»" : n.kind === "subsystem" ? "«sub-system»" : n.kind === "context" ? "«bounded context»" : n.kind === "domain" ? "«domain»" : "«system»";
  return [
    kind,
    ...(n.team ? [`team: ${n.team}`] : []),
    ...(n.spans ? [`spans ${n.spans.join(", ")}`] : []),
    ...(n.holds?.length ? [n.holds.join(", ")] : []),
    ...(n.library?.length ? [`library: ${n.library.join(", ")}`] : []),
    ...(n.unmodelled ? ["not modelled yet"] : []),
  ];
}

/** An edge's label: its patterns, and how much crosses it — the full lists are in its tooltip. */
export function labelOf(e: MapEdge): string {
  const counts = [e.events.length ? `${e.events.length} event${e.events.length === 1 ? "" : "s"}` : "", e.commands.length && !e.events.length ? `${e.commands.length} command${e.commands.length === 1 ? "" : "s"}` : ""].filter(Boolean);
  return [...e.patterns.map((p) => `«${p}»`), counts.join(" · ")].filter(Boolean).join(" ");
}

export async function layoutMap(map: ContextMap, measure: Measure = estimate): Promise<MapLayout> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const drawn = drawnEdges(map.edges);
  const sized = map.nodes.map((n) => {
    const lines = linesOf(n);
    const width = Math.max(MAP.minW, measure(n.id, "title") + 2 * MAP.pad, ...lines.map((l) => measure(l, "label") + 2 * MAP.pad));
    return { ...n, lines, width, height: MAP.pad * 2 + MAP.line * (1 + lines.length) };
  });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "POLYLINE",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "48",
      "elk.spacing.edgeLabel": "6",
      "elk.edgeLabels.inline": "false",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
    },
    children: sized.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: drawn.map((e, i): ElkExtendedEdge => {
      const text = labelOf(e);
      return { id: `e${i}`, sources: [upward(e) ? e.to : e.from], targets: [upward(e) ? e.from : e.to], labels: text ? [{ id: `l${i}`, text, width: measure(text, "label") + 8, height: 16 }] : [] };
    }),
  };
  const out = await elk.layout(graph);
  const at = new Map((out.children ?? []).map((c) => [c.id, c]));
  const nodes: PlacedNode[] = sized.map((n) => ({ ...n, x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 }));
  const edges: PlacedEdge[] = drawn.map((e, i) => {
    const laid = (out.edges ?? []).find((x) => x.id === `e${i}`) as ElkExtendedEdge | undefined;
    const s = laid?.sections?.[0];
    const laidOut = s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint] : [];
    const points = upward(e) ? laidOut.reverse() : laidOut;
    const l = laid?.labels?.[0];
    return { ...e, points, ...(l && l.text ? { label: { x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0, text: l.text } } : {}) };
  });
  return { width: out.width ?? 0, height: out.height ?? 0, nodes, edges };
}

/**
 * Where an edge's U and D sit (ADR 0035): a little inside each end, along its first and last
 * segment — the upstream end U, the downstream end D; both D when each depends on the other.
 */
export function endsOf(e: PlacedEdge): { x: number; y: number; text: "U" | "D" }[] {
  if (e.downstream.length === 0 || e.points.length < 2) return [];
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = Math.min(22, len / 3);
    return { x: a.x + ((b.x - a.x) / len) * d, y: a.y + ((b.y - a.y) / len) * d };
  };
  const first = near(e.points[0]!, e.points[1]!), last = near(e.points[e.points.length - 1]!, e.points[e.points.length - 2]!);
  return [
    { ...first, text: e.downstream.includes(e.from) ? "D" : "U" },
    { ...last, text: e.downstream.includes(e.to) ? "D" : "U" },
  ];
}
