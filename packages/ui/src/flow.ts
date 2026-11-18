/**
 * The flow board: the whole process on one page, the way a business owner draws it — events
 * in swimlanes by where they happen, an arrow from each event to what can happen next.
 *
 * Nothing on it is drawn by hand. The arrows are what the scenarios *showed*: for every
 * subject instance (a sample, say) in every scenario run, each event it raised is followed
 * by the next one it raised. So the board is exactly the flows the model has been proven to
 * handle, the way back included, and it changes when a scenario is added. An event's colour
 * is what it did: a deviation if it ever failed something, progress if it completed something.
 *
 * The model says only what cannot be inferred, under `overview.flow`:
 *   of:    whose events, in the order they happened to each one (default: every aggregate)
 *   lanes: lane name -> what is drawn in it, in order (default: a lane per raising type):
 *          an event named there is always drawn there, where the business draws it; an activity
 *          type named there takes every other event in the place where it moved that activity's
 *          step — so one status can sit in two lanes: Delivered in the transport's lane, but in
 *          the sender's where no transfer was needed. Moving several, the first such lane wins.
 */
import { isA, type Json, type LogEntry, type Model } from "@statestorm/kernel";
import { eventNames, globMatch, toneOf, type OverviewConfig, type Tone } from "./overview.ts";

export interface FlowConfig {
  of?: string[];
  lanes?: { name: string; events: string[]; types: string[] }[];
  /** Words shown on some events — `not in pilot: [PickedUp]`. */
  tags?: Record<string, string[]>;
}

export function flowConfig(model: Model): { flow: FlowConfig; errors: string[] } {
  const errors: string[] = [];
  const overview = model.overview as Record<string, Json> | undefined;
  const raw = overview && typeof overview === "object" && !Array.isArray(overview) ? overview.flow : undefined;
  if (raw === undefined || raw === null) return { flow: {}, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { flow: {}, errors: ["overview.flow: expected a block"] };
  const r = raw as Record<string, Json>;
  for (const k of Object.keys(r)) if (!["of", "lanes", "tags"].includes(k)) errors.push(`overview.flow: unknown key \`${k}\` (expected of, lanes, tags)`);
  const flow: FlowConfig = {};
  if (r.of !== undefined) {
    const list = (Array.isArray(r.of) ? r.of : [r.of]).map(String);
    for (const t of list) if (!model.aggregates[t]) errors.push(`overview.flow.of: there is no aggregate called \`${t}\``);
    flow.of = list.filter((t) => model.aggregates[t]);
  }
  if (r.lanes !== undefined) {
    if (typeof r.lanes !== "object" || Array.isArray(r.lanes) || r.lanes === null) errors.push("overview.flow.lanes: expected lane: [events]");
    else {
      const known = new Set(eventNames(model));
      const seen = new Set<string>();
      flow.lanes = Object.entries(r.lanes as Record<string, Json>).map(([name, list]) => {
        const names = (Array.isArray(list) ? list : [list]).map(String);
        const types = names.filter((n) => model.aggregates[n]);
        const events = names.filter((e) => {
          if (model.aggregates[e]) return false;
          if (!known.has(e)) { errors.push(`overview.flow.lanes.${name}: the model raises no event called \`${e}\`, and has no type called that`); return false; }
          if (seen.has(e)) { errors.push(`overview.flow.lanes.${name}: \`${e}\` is already in another lane`); return false; }
          seen.add(e);
          return true;
        });
        return { name, events, types };
      });
    }
  }
  if (r.tags !== undefined) {
    if (typeof r.tags !== "object" || Array.isArray(r.tags) || r.tags === null) errors.push("overview.flow.tags: expected tag: [events]");
    else {
      const known = new Set(eventNames(model));
      flow.tags = {};
      for (const [tag, list] of Object.entries(r.tags as Record<string, Json>)) {
        flow.tags[tag] = (Array.isArray(list) ? list : [list]).map(String).filter((e) => {
          if (!known.has(e)) { errors.push(`overview.flow.tags.${tag}: the model raises no event called \`${e}\``); return false; }
          return true;
        });
      }
    }
  }
  return { flow, errors };
}

/** The tags an event carries on the board. */
export function tagsOf(flow: FlowConfig, event: string): string[] {
  return Object.entries(flow.tags ?? {}).filter(([, events]) => events.includes(event)).map(([tag]) => tag);
}

// ---------------------------------------------------------------- the graph

export interface FlowNode {
  /** `event@lane`: one status may sit in two lanes, a box in each. */
  id: string;
  event: string;
  lane: string;
  /** How often it happened, over every run. */
  count: number;
  tone: Tone;
}
export interface FlowEdge { from: string; to: string; count: number }
export interface FlowGraph {
  lanes: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Events the subjects raised that no lane lists — left off, and said so. */
  left: string[];
}

const machineOf = (key: string) => key.slice(0, key.indexOf("#"));
export const nodeId = (event: string, lane: string) => `${event}@${lane}`;

function causes(log: LogEntry[]): Map<number, LogEntry[]> {
  const byCause = new Map<number, LogEntry[]>();
  for (const e of log) if (e.cause) (byCause.get(e.cause) ?? byCause.set(e.cause, []).get(e.cause)!).push(e);
  return byCause;
}

/**
 * The lane of the activity whose step this event moved: down its chain, the first state
 * change of an instance inside an aggregate a lane names — before any further event, or (a
 * deviation, whose hold comes from the deviation it opened) one event further. The aggregate is
 * the one the command was delivered to: an entity counts for the aggregate it is inside.
 */
function activityLane(model: Model, flow: FlowConfig, byCause: Map<number, LogEntry[]>, seq: number): string | undefined {
  const typed = (flow.lanes ?? []).filter((l) => l.types.length > 0);
  if (typed.length === 0) return undefined;
  const laneOf = (instance: string) => typed.findIndex((l) => l.types.some((t) => isA(model, machineOf(instance), t)));
  for (const reach of [0, 1]) {
    let best = -1;
    const queue: [number, string | undefined, number, number][] = [[seq, undefined, 0, 0]];
    while (queue.length > 0) {
      const [at, inside, depth, hops] = queue.shift()!;
      for (const next of byCause.get(at) ?? []) {
        let agg = inside;
        if (next.kind === "command" && model.aggregates[machineOf(next.instance)]?.role === "aggregate") agg = next.instance;
        if (next.kind === "transition" && !next.internal && hops <= reach) {
          const self = model.aggregates[machineOf(next.instance)]?.role === "aggregate" ? next.instance : agg;
          const i = self ? laneOf(self) : -1;
          if (i >= 0 && (best < 0 || i < best)) best = i;
        }
        const h = hops + (next.kind === "event" ? 1 : 0);
        if (depth < 9 && h <= reach) queue.push([next.seq, agg, depth + 1, h]);
      }
    }
    if (best >= 0) return typed[best]!.name;
  }
  return undefined;
}

/** The events on the board, in log order, with the subject that raised them and their lane. */
export function subjectEvents(model: Model, overview: OverviewConfig, flow: FlowConfig, log: LogEntry[]) {
  const lane = new Map<string, string>();
  for (const l of flow.lanes ?? []) for (const e of l.events) lane.set(e, l.name);
  const byCause = causes(log);
  const out: { seq: number; instance: string; event: string; lane: string; id: string }[] = [];
  const left = new Set<string>();
  for (const e of log) {
    if (e.kind !== "event") continue;
    const machine = machineOf(e.instance);
    const m = model.aggregates[machine];
    if (!m) continue;
    let subject = e.instance;
    if (flow.of && !flow.of.some((t) => isA(model, machine, t))) {
      // A status a lane names, raised by something that points at a subject and names it in the
      // event — a step's deadline passing, for a sample — is that subject's.
      const ref = lane.has(e.event)
        ? Object.entries(m.references).find(([name, r]) => flow.of!.some((t) => isA(model, r.type, t)) && typeof e.payload[name] === "string")
        : undefined;
      if (!ref) continue;
      subject = `${ref[1].type}#${String(e.payload[ref[0]])}`;
    }
    let where: string | undefined;
    if (!lane.has(e.event) && overview.hideEvents.some((p) => globMatch(p, e.event))) continue;
    if (flow.lanes) {
      where = lane.get(e.event) ?? activityLane(model, flow, byCause, e.seq);
      if (!where) { left.add(e.event); continue; }
    } else {
      where = machine;
    }
    out.push({ seq: e.seq, instance: subject, event: e.event, lane: where, id: nodeId(e.event, where) });
  }
  return { events: out, left };
}

/**
 * The board event that caused this one, raised by another instance — an order placed that made
 * the warehouse reserve stock. Followed up the cause chain to the nearest board event.
 */
function causedBy(bySeq: Map<number, LogEntry>, board: Map<number, { instance: string; id: string }>, seq: number, instance: string): string | undefined {
  let at = bySeq.get(seq)?.cause ?? 0;
  for (let hops = 0; at > 0 && hops < 40; hops++) {
    const hit = board.get(at);
    if (hit && hit.instance !== instance) return hit.id;
    at = bySeq.get(at)?.cause ?? 0;
  }
  return undefined;
}

/** Every arrow a run shows: the next event of the same subject, and what one subject's event caused in another. */
function arrowsOf(log: LogEntry[], events: { seq: number; instance: string; id: string }[]): [string, string][] {
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const board = new Map(events.map((e) => [e.seq, e]));
  const last = new Map<string, string>();
  const out: [string, string][] = [];
  for (const e of events) {
    const prev = last.get(e.instance);
    if (prev && prev !== e.id) out.push([prev, e.id]);
    const cause = causedBy(bySeq, board, e.seq, e.instance);
    if (cause && cause !== e.id && cause !== prev) out.push([cause, e.id]);
    last.set(e.instance, e.id);
  }
  return out;
}

// A deviation's point is the hold it puts things on, so that says the most about it.
const RANK: Record<Tone, number> = { held: 5, failed: 4, done: 3, partial: 3, active: 2, skipped: 1, neutral: 0 };

/**
 * What an event did, judged by its near effects: the transitions a few steps down its chain —
 * what the handlings made of it (through a deviation it opened, say), not the whole roll-up.
 */
function effectOf(model: Model, byCause: Map<number, LogEntry[]>, seq: number): Tone {
  let best: Tone = "neutral";
  // [entry, depth, events crossed]. Done, failed, started are judged by the direct effects — what
  // happened before any further event; beyond one, only a hold counts (a deviation it opened put
  // the steps on hold), so a roll-up further down never colours the event that started it.
  const queue: [number, number, number][] = [[seq, 0, 0]];
  while (queue.length > 0) {
    const [at, depth, hops] = queue.shift()!;
    for (const next of byCause.get(at) ?? []) {
      if (next.kind === "transition" && !next.internal && model.aggregates[machineOf(next.instance)]) {
        const path = next.to.split(".");
        const final = model.aggregates[machineOf(next.instance)]!.states[path[0]!]?.final === true;
        const t = toneOf(path, final);
        if ((hops === 0 || t === "held") && RANK[t] > RANK[best]) best = t;
      }
      if (depth < 7) queue.push([next.seq, depth + 1, hops + (next.kind === "event" ? 1 : 0)]);
    }
  }
  return best;
}

/** What one run puts on the board: its events with their tone, what it left off, and its arrows. */
interface RunFacts {
  events: { id: string; event: string; lane: string; tone: Tone }[];
  left: string[];
  arrows: [string, string][];
}

/**
 * A run's facts depend only on the run and the model's settings, so they are read once and kept:
 * the board is rebuilt each time more runs come in (runs.ts), and only the counting is done again.
 */
const factsCache = new WeakMap<LogEntry[], { model: Model; overview: OverviewConfig; flow: FlowConfig; length: number; facts: RunFacts }>();

function factsOf(model: Model, overview: OverviewConfig, flow: FlowConfig, log: LogEntry[]): RunFacts {
  const kept = factsCache.get(log);
  // A run on screen may grow where it stands, as a command is fired: its length says it has.
  if (kept && kept.model === model && kept.overview === overview && kept.flow === flow && kept.length === log.length) return kept.facts;
  const byCause = causes(log);
  const { events, left } = subjectEvents(model, overview, flow, log);
  const facts: RunFacts = {
    events: events.map((e) => ({ id: e.id, event: e.event, lane: e.lane, tone: effectOf(model, byCause, e.seq) })),
    left: [...left],
    arrows: [...arrowsOf(log, events)],
  };
  factsCache.set(log, { model, overview, flow, length: log.length, facts });
  return facts;
}

export function buildFlow(model: Model, overview: OverviewConfig, flow: FlowConfig, logs: LogEntry[][]): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const left = new Set<string>();
  const laneOrder: string[] = flow.lanes ? flow.lanes.map((l) => l.name) : [];
  for (const log of logs) {
    const facts = factsOf(model, overview, flow, log);
    for (const x of facts.left) left.add(x);
    for (const e of facts.events) {
      if (!laneOrder.includes(e.lane)) laneOrder.push(e.lane);
      const tone = e.tone;
      const node = nodes.get(e.id) ?? { id: e.id, event: e.event, lane: e.lane, count: 0, tone: "neutral" as Tone };
      node.count++;
      if (RANK[tone] > RANK[node.tone]) node.tone = tone === "partial" ? "done" : tone;
      nodes.set(e.id, node);
    }
    for (const [from, to] of facts.arrows) {
      const k = `${from}→${to}`;
      const edge = edges.get(k) ?? { from, to, count: 0 };
      edge.count++;
      edges.set(k, edge);
    }
  }
  // Listed, but no scenario ever made it happen: on the board all the same — that gap is
  // worth seeing — with a count of nought.
  for (const l of flow.lanes ?? []) for (const e of l.events) {
    const id = nodeId(e, l.name);
    if (!nodes.has(id)) nodes.set(id, { id, event: e, lane: l.name, count: 0, tone: "neutral" });
  }
  // Configured lanes keep the order they were listed in, and so do the events inside them; an
  // event placed by its activity comes after the lane's own, in the order first seen.
  const listed = new Map<string, number>();
  (flow.lanes ?? []).forEach((l, li) => l.events.forEach((e, ei) => listed.set(nodeId(e, l.name), li * 1000 + ei)));
  const ordered = [...nodes.values()].sort((a, b) =>
    (listed.get(a.id) ?? Infinity) - (listed.get(b.id) ?? Infinity));
  return {
    lanes: laneOrder.filter((l) => ordered.some((n) => n.lane === l)),
    nodes: ordered,
    edges: [...edges.values()],
    // Left off: what no lane lists and no run placed — a status that moved nothing in one run
    // (a refusal after a cancel) is still drawn where it moved something in another.
    left: [...left].filter((e) => ![...nodes.values()].some((n) => n.event === e)).sort(),
  };
}

// ---------------------------------------------------------------- the layout

export const NODE = { w: 204, h: 34, gapX: 18, gapY: 46, lanePad: 22, head: 40 };

export interface Placed extends FlowNode { x: number; y: number; rank: number }
type Pt = [number, number];
export interface Routed extends FlowEdge { back: boolean; points: Pt[]; path: string }

/** Does the axis-aligned segment a–b pass through the rectangle? */
function crosses(a: Pt, b: Pt, r: { x: number; y: number; w: number; h: number }): boolean {
  const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return x1 < r.x + r.w && x2 > r.x && y1 < r.y + r.h && y2 > r.y;
}

/** A polyline with its corners rounded off. */
function rounded(pts: Pt[], radius = 8): string {
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [p, c, n] = [pts[i - 1]!, pts[i]!, pts[i + 1]];
    if (!n) { d += ` L${c[0]},${c[1]}`; break; }
    const r = Math.min(radius, Math.hypot(c[0] - p[0], c[1] - p[1]) / 2, Math.hypot(n[0] - c[0], n[1] - c[1]) / 2);
    const into = [c[0] - Math.sign(c[0] - p[0]) * r, c[1] - Math.sign(c[1] - p[1]) * r];
    const out = [c[0] + Math.sign(n[0] - c[0]) * r, c[1] + Math.sign(n[1] - c[1]) * r];
    d += ` L${into[0]},${into[1]} Q${c[0]},${c[1]} ${out[0]},${out[1]}`;
  }
  return d;
}
export interface FlowLayout {
  lanes: { name: string; x: number; width: number }[];
  nodes: Placed[];
  edges: Routed[];
  width: number;
  height: number;
}

/**
 * Top to bottom by what follows what; a lane is a column. An arrow that goes back up — the
 * same steps at a second site, a second attempt — is a loop drawn beside the lane, as on the
 * business's own drawings. Ranks: the longest chain of forward arrows before each event, with
 * the loops found by walking from the events in the order they first happened.
 */
export function layoutFlow(g: FlowGraph): FlowLayout {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const out = new Map<string, FlowEdge[]>();
  for (const e of g.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
  const incoming = new Set(g.edges.map((e) => e.to));
  // Walk from the starts (nothing leads to them), then from whatever is still unvisited.
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (n: string) => {
    state.set(n, 1);
    const next = [...(out.get(n) ?? [])].sort((a, b) => b.count - a.count || index.get(a.to)! - index.get(b.to)!);
    for (const e of next) {
      const s = state.get(e.to);
      if (s === 1) back.add(`${e.from}→${e.to}`);
      else if (!s) visit(e.to);
    }
    state.set(n, 2);
  };
  for (const n of g.nodes) if (!incoming.has(n.id) && !state.has(n.id)) visit(n.id);
  for (const n of g.nodes) if (!state.has(n.id)) visit(n.id);

  const rank = new Map(g.nodes.map((n) => [n.id, 0]));
  const forward = g.edges.filter((e) => !back.has(`${e.from}→${e.to}`) && e.from !== e.to);
  for (let round = 0; round < g.nodes.length; round++) {
    let moved = false;
    for (const e of forward) {
      if (rank.get(e.to)! < rank.get(e.from)! + 1) { rank.set(e.to, rank.get(e.from)! + 1); moved = true; }
    }
    if (!moved) break;
  }

  // Events no arrow touches — no scenario showed them, and (on a drawing) none is drawn to
  // them: below everything else in their lane.
  const touched = new Set(g.edges.flatMap((e) => [e.from, e.to]));
  const shown = Math.max(0, ...g.nodes.filter((n) => touched.has(n.id)).map((n) => rank.get(n.id)!));
  for (const n of g.nodes) if (!touched.has(n.id) && n.count === 0) rank.set(n.id, shown + 1);

  // Cells: (lane, rank) -> its events, ordered by where their predecessors sit.
  const cells = new Map<string, string[]>();
  for (const n of g.nodes) {
    const k = `${n.lane}|${rank.get(n.id)}`;
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(n.id);
  }
  const perLane = new Map(g.lanes.map((l) => [l, 1]));
  for (const [k, list] of cells) {
    const l = k.slice(0, k.lastIndexOf("|"));
    perLane.set(l, Math.max(perLane.get(l) ?? 1, list.length));
  }
  const lanes: FlowLayout["lanes"] = [];
  let x = 0;
  for (const name of g.lanes) {
    const width = perLane.get(name)! * (NODE.w + NODE.gapX) - NODE.gapX + 2 * NODE.lanePad + 40;   // room for loops
    lanes.push({ name, x, width });
    x += width;
  }
  const laneOf = new Map(lanes.map((l) => [l.name, l]));
  const maxRank = Math.max(0, ...rank.values());
  const pos = new Map<string, { x: number; y: number }>();
  const preds = (n: string) => forward.filter((e) => e.to === n).map((e) => pos.get(e.from)?.x).filter((v): v is number => v !== undefined);
  for (let r = 0; r <= maxRank; r++) {
    for (const lane of lanes) {
      const list = cells.get(`${lane.name}|${r}`) ?? [];
      const keyed = list.map((n) => {
        const p = preds(n);
        return { n, at: p.length ? p.reduce((a, b) => a + b, 0) / p.length : index.get(n)! * 1e-3 };
      }).sort((a, b) => a.at - b.at);
      const span = keyed.length * (NODE.w + NODE.gapX) - NODE.gapX;
      const start = lane.x + (lane.width - 40 - span) / 2;
      keyed.forEach(({ n }, i) => pos.set(n, { x: start + i * (NODE.w + NODE.gapX), y: NODE.head + r * (NODE.h + NODE.gapY) }));
    }
  }

  const nodes: Placed[] = g.nodes.map((n) => ({ ...n, ...pos.get(n.id)!, rank: rank.get(n.id)! }));
  // Right-angled connectors, as on the business's own drawings, routed round the boxes: for
  // each arrow, the first of a few candidate routes that touches no other box.
  const rects = nodes.map((n) => ({ id: n.id, x: n.x - 4, y: n.y - 4, w: NODE.w + 8, h: NODE.h + 8 }));
  const clear = (pts: Pt[], skip: string[]) => !rects.some((r) => !skip.includes(r.id) && pts.some((p, i) => i > 0 && crosses(pts[i - 1]!, p, r)));
  const laneBox = (event: string) => laneOf.get(g.nodes[index.get(event)!]!.lane)!;
  const gutter = (event: string, k: number) => { const l = laneBox(event); return l.x + l.width - 12 - 6 * (k % 4); };
  let k = 0;
  const edges: Routed[] = g.edges.filter((e) => e.from !== e.to).map((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const isBack = back.has(`${e.from}→${e.to}`);
    const skip = [e.from, e.to];
    const spread = ((k++ % 3) - 1) * 5;     // arrows sharing a gap do not lie on one line
    let routes: Pt[][];
    if (!isBack) {
      const [x1, y1, x2, y2] = [a.x + NODE.w / 2, a.y + NODE.h, b.x + NODE.w / 2, b.y];
      const below = y1 + NODE.gapY / 2 + spread;     // the gap under the source's row
      const above = y2 - NODE.gapY / 2 + spread;     // the gap over the target's row
      const gs = gutter(e.from, k);
      const gt = laneBox(e.to).x + 12 + 6 * (k % 4);
      routes = [
        ...(Math.abs(x1 - x2) < 1 ? [[[x1, y1], [x2, y2]] as Pt[]] : []),
        [[x1, y1], [x1, above], [x2, above], [x2, y2]],
        [[x1, y1], [x1, below], [x2, below], [x2, y2]],
        [[x1, y1], [x1, below], [gs, below], [gs, above], [x2, above], [x2, y2]],
        [[x1, y1], [x1, below], [gt, below], [gt, above], [x2, above], [x2, y2]],
      ];
    } else {
      // Up again: out of the side, up the lane's gutter, into the side of where it returns to.
      const [x1, y1, x2, y2] = [a.x + NODE.w, a.y + NODE.h / 2, b.x + NODE.w, b.y + NODE.h / 2];
      const gt = gutter(e.to, k);
      const gs = gutter(e.from, k);
      const below = a.y + NODE.h + NODE.gapY / 2 + spread;
      // Or, when a box sits beside the target in its row, down into the target's top from the
      // gap above that row.
      const over = b.y - NODE.gapY / 2 + spread;
      const top = b.x + NODE.w * 0.75;
      routes = [
        [[x1, y1], [gt, y1], [gt, y2], [x2, y2]],
        [[a.x + NODE.w / 2, a.y + NODE.h], [a.x + NODE.w / 2, below], [gt, below], [gt, y2], [x2, y2]],
        [[x1, y1], [gs, y1], [gs, below], [gt, below], [gt, y2], [x2, y2]],
        [[x1, y1], [gt, y1], [gt, over], [top, over], [top, b.y]],
        [[a.x + NODE.w / 2, a.y + NODE.h], [a.x + NODE.w / 2, below], [gt, below], [gt, over], [top, over], [top, b.y]],
      ];
    }
    const points = routes.find((r) => clear(r, skip)) ?? routes[0]!;
    return { ...e, back: isBack, points, path: rounded(points) };
  });
  return { lanes, nodes, edges, width: x, height: NODE.head + (maxRank + 1) * (NODE.h + NODE.gapY) };
}

// ---------------------------------------------------------------- the run you are looking at

export interface Trail {
  /** Every board box (`event@lane`) the run has reached so far, the first time (log seq). */
  first: Map<string, number>;
  edges: Set<string>;
  last?: string;
  /** The subjects that raised board events so far, for "follow one". */
  subjects: string[];
}

/** What the run you are stepping through has done so far — optionally for one subject only. */
export function trailOf(model: Model, overview: OverviewConfig, flow: FlowConfig, log: LogEntry[], upTo: number, only?: string): Trail {
  const { events } = subjectEvents(model, overview, flow, log.filter((e) => e.seq <= upTo));
  const first = new Map<string, number>();
  const subjects: string[] = [];
  let last: string | undefined;
  for (const e of events) {
    if (!subjects.includes(e.instance)) subjects.push(e.instance);
    if (only && e.instance !== only) continue;
    if (!first.has(e.id)) first.set(e.id, e.seq);
    last = e.id;
  }
  const mine = only ? events.filter((e) => e.instance === only) : events;
  const edges = new Set(arrowsOf(log, mine).map(([a, b]) => `${a}→${b}`));
  return { first, edges, last, subjects };
}
