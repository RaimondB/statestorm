/**
 * Scenarios grouped by the drawing they walk, and a drawing laid over the flow board.
 *
 * Each scenario names the one drawing it walks (`drawing:`, MC-14) — the drawing that should
 * draw every arrow it shows — so each scenario is in one group; one that names none is in a
 * group of its own.
 *
 * `drawingBoard` draws a drawing the way its owners drew it — their lanes, their boxes, their
 * words — with every arrow marked against what a set of scenario runs showed:
 *   drawn     drawn, in the model, and shown
 *   missing   drawn, in the model, not shown by the drawing's own scenarios: a gap
 *   unwalked  drawn, in the model, not shown by the runs chosen (not the drawing's own)
 *   decided   drawn, decided later / open / no, and not shown
 *   anyway    drawn, decided later / open / no — and shown all the same
 *   proposed  shown, not drawn: what the model would change on the drawing
 * Events the runs show next to a drawn box that the drawing has no box for come along as extra
 * boxes — in the lane of the same name, or in "Not on the drawing".
 */
import type { Drawing, DrawingIssue, Walker } from "./check/drawings.ts";
import { nodeId, type FlowEdge, type FlowGraph, type FlowNode } from "./flow.ts";

export interface Group {
  /** The drawing's file without `.yaml`; "" for the scenarios on no drawing. */
  id: string;
  title: string;
  files: string[];
  /** For a tag: `kind`, `topic`, or the prefix of a reference (`WOM` for `WOM-12`). */
  section?: string;
}

/**
 * A tag shaped like an id in a list kept elsewhere — a test case `WOM-12`, a ticket `LFMT-280` —
 * is a reference: it says which outside item a scenario proves, not what it is about.
 */
export const REFERENCE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
/** The tag that stands for every reference with a prefix: `WOM-*`. */
export const anyOf = (prefix: string) => `${prefix}-*`;

/** Whether a scenario's tags match the tag chosen; `WOM-*` matches any `WOM-<n>`. */
export function tagMatches(tags: readonly string[], tag: string): boolean {
  if (!tag.endsWith("-*")) return tags.includes(tag);
  const prefix = tag.slice(0, -2);
  return tags.some((t) => REFERENCE.exec(t)?.[1] === prefix);
}

/** A scenario's references, in number order. */
export const referencesOf = (tags: readonly string[]) => tags.filter((t) => REFERENCE.test(t)).sort(byReference);

function byReference(a: string, b: string): number {
  const [, pa, na] = REFERENCE.exec(a)!;
  const [, pb, nb] = REFERENCE.exec(b)!;
  return pa!.localeCompare(pb!) || Number(na) - Number(nb);
}

/**
 * The scenarios carrying each tag — every cancellation together — as groups, `#tag`: the kinds
 * first, then the topics, then the references by prefix, each prefix led by `WOM-*` and in number
 * order (WOM-2 before WOM-10).
 */
export function tagGroups(walkers: Walker[]): Group[] {
  const tags = [...new Set(walkers.flatMap((w) => w.tags ?? []))];
  const isKind = (t: string) => t === "happy" || t === "deviation";
  const group = (t: string, section: string): Group => ({ id: `#${t}`, title: t, section, files: walkers.filter((w) => tagMatches(w.tags ?? [], t)).map((w) => w.file) });
  const refs = tags.filter((t) => REFERENCE.test(t)).sort(byReference);
  const plain = tags.filter((t) => !REFERENCE.test(t)).sort((a, b) => Number(isKind(b)) - Number(isKind(a)) || a.localeCompare(b));
  const prefixes = [...new Set(refs.map((t) => REFERENCE.exec(t)![1]!))];
  return [
    ...plain.map((t) => group(t, isKind(t) ? "kind" : "topic")),
    ...prefixes.flatMap((p) => [group(anyOf(p), p), ...refs.filter((t) => REFERENCE.exec(t)![1] === p).map((t) => group(t, p))]),
  ];
}

export function scenarioGroups(drawings: Drawing[], walkers: Walker[]): Group[] {
  // In the order of their first scenario, so the picker reads roughly as the scenarios are numbered.
  const groups: Group[] = drawings.map((d) => {
    const id = d.file.replace(/\.yaml$/, "");
    return { id, title: d.title, files: walkers.filter((w) => w.drawing === id).map((w) => w.file).sort() };
  }).filter((g) => g.files.length > 0).sort((a, b) => a.files[0]!.localeCompare(b.files[0]!));
  const known = new Set(groups.map((g) => g.id));
  const none = walkers.filter((w) => w.drawing === undefined || !known.has(w.drawing)).map((w) => w.file);
  if (none.length > 0) groups.push({ id: "", title: "On no drawing", files: none });
  return groups;
}

export type Mark = "drawn" | "missing" | "unwalked" | "decided" | "anyway" | "proposed";
export interface MarkedEdge extends FlowEdge { mark: Mark; why?: string }
export interface DrawnNode extends FlowNode { label: string; extra: boolean }
export interface DrawingBoard extends FlowGraph {
  nodes: DrawnNode[];
  edges: MarkedEdge[];
  /** Arrows from a trigger drawn outside the lanes (Cancelled order): not statuses, not drawn here. */
  outside: number;
  issues: DrawingIssue[];
}

export const EXTRA_LANE = "Not on the drawing";
const evOf = (id: string) => id.slice(0, id.lastIndexOf("@"));
const laneOfId = (id: string) => id.slice(id.lastIndexOf("@") + 1);

/**
 * `shown` is the board built from the chosen runs; `own` says whether those runs are the
 * drawing's own scenarios — only then is a drawn arrow they do not show a gap. `byPath` is,
 * for a path that names its own scenarios (drawn on many drawings), the board of
 * those: its arrows are judged by them, as the check does.
 */
export function drawingBoard(d: Drawing, shown: FlowGraph, own: boolean, issues: DrawingIssue[] = [], byPath: Record<string, FlowGraph> = {}): DrawingBoard {
  const stem = d.file.replace(/\.yaml$/, "");
  const lanes = [...new Set(d.boxes.map((b) => b.lane))];
  const count = new Map<string, number>();
  const tone = new Map<string, FlowNode["tone"]>();
  for (const n of shown.nodes) {
    count.set(n.event, (count.get(n.event) ?? 0) + n.count);
    if (n.count > 0 && (!tone.has(n.event) || tone.get(n.event) === "neutral")) tone.set(n.event, n.tone);
  }
  const nodes = new Map<string, DrawnNode>();
  for (const b of d.boxes) {
    const id = nodeId(b.event, b.lane);
    if (!nodes.has(id)) nodes.set(id, { id, event: b.event, lane: b.lane, label: b.label, extra: false, count: count.get(b.event) ?? 0, tone: tone.get(b.event) ?? "neutral" });
  }
  const drawnEvents = new Set(d.boxes.map((b) => b.event));
  // Where a status the runs show sits on the drawing: the box in the lane the board put it in,
  // else its first box; an event the drawing has no box for is an extra box.
  const place = (boardId: string): string => {
    const [ev, lane] = [evOf(boardId), laneOfId(boardId)];
    const boxes = d.boxes.filter((b) => b.event === ev);
    if (boxes.length) return nodeId(ev, (boxes.find((b) => b.lane === lane) ?? boxes[0]!).lane);
    const at = lanes.includes(lane) ? lane : EXTRA_LANE;
    const id = nodeId(ev, at);
    if (!nodes.has(id)) nodes.set(id, { id, event: ev, lane: at, label: "", extra: true, count: count.get(ev) ?? 0, tone: tone.get(ev) ?? "neutral" });
    return id;
  };
  const boxOf = (name: string): string | undefined => {
    const [label, lane] = name.includes(" @ ") ? name.split(" @ ").map((s) => s.trim()) as [string, string] : [name, undefined];
    const b = d.boxes.find((x) => x.label === label && (lane === undefined || x.lane === lane));
    return b ? nodeId(b.event, b.lane) : undefined;
  };

  const mine = issues.filter((i) => i.drawings.includes(stem) || i.drawings.includes("all"));
  const pairsIn = (g: FlowGraph) => {
    const m = new Map<string, number>();
    for (const e of g.edges) {
      const k = `${evOf(e.from)} ${evOf(e.to)}`;
      m.set(k, (m.get(k) ?? 0) + e.count);
    }
    return m;
  };
  const pairs = pairsIn(shown);
  const pathPairs = Object.fromEntries(Object.entries(byPath).map(([k, g]) => [k, pairsIn(g)]));
  const edges = new Map<string, MarkedEdge>();
  const RANK: Record<Mark, number> = { drawn: 5, anyway: 4, missing: 3, unwalked: 2, decided: 1, proposed: 0 };
  const put = (e: MarkedEdge) => {
    const k = `${e.from}→${e.to}`;
    const had = edges.get(k);
    if (!had || RANK[e.mark] > RANK[had.mark]) edges.set(k, e);
  };
  let outside = 0;
  const drawnPairs = new Set<string>();
  for (const a of d.arrows) {
    if (!a.fromEvent || !a.toEvent) { outside++; continue; }
    const [from, to] = [boxOf(a.from), boxOf(a.to)];
    if (!from || !to) continue;
    drawnPairs.add(`${a.fromEvent} ${a.toEvent}`);
    const n = (own && pathPairs[a.path] ? pathPairs[a.path]! : pairs).get(`${a.fromEvent} ${a.toEvent}`) ?? 0;
    const why = a.decision.kind === "model" ? undefined : `${a.decision.kind}: ${a.decision.why}`;
    const mark: Mark = a.decision.kind === "model" ? (n > 0 ? "drawn" : own ? "missing" : "unwalked") : n > 0 ? "anyway" : "decided";
    put({ from, to, count: n, mark, ...(why ? { why } : {}) });
  }
  // What the runs show that the drawing does not draw, next to a box it does draw.
  for (const e of shown.edges) {
    const [fe, te] = [evOf(e.from), evOf(e.to)];
    if (drawnPairs.has(`${fe} ${te}`) || fe === te) continue;
    if (!drawnEvents.has(fe) && !drawnEvents.has(te)) continue;
    // Raised already as a change to this drawing: say which (MC-14).
    const raised = mine.filter((i) => i.status !== "done" && i.arrows.includes(`${fe} ${te}`)).map((i) => i.id);
    put({ from: place(e.from), to: place(e.to), count: pairs.get(`${fe} ${te}`) ?? e.count, mark: "proposed", ...(raised.length ? { why: `raised in ${raised.join(", ")}` } : {}) });
  }
  const all = [...nodes.values()];
  return {
    lanes: [...lanes, ...(all.some((n) => n.lane === EXTRA_LANE) ? [EXTRA_LANE] : [])],
    nodes: all,
    edges: [...edges.values()],
    left: [],
    outside,
    issues: mine,
  };
}
