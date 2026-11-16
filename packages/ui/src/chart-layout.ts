/**
 * Statechart layout (R24): states as nested compound boxes, transitions as edges drawn
 * between the states that *declare* them — a transition owned by a composite starts at the
 * composite's border, because that is what "applies from any substate" looks like.
 *
 * Layout is per machine, not per frame: instances move, the chart does not. ELK does the
 * compound-node work; nothing here touches the DOM, so it runs (and is tested) in Node.
 */
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { refOf, type MachineDef, type StateDef, type TransitionDef } from "@statestorm/kernel";

export type Measure = (text: string, font: "label" | "title" | "small") => number;

/** A fallback for Node: wide enough not to clip, which is the failure that matters. */
export const estimate: Measure = (text, font) => text.length * (font === "title" ? 8.6 : font === "label" ? 7.4 : 6.8);

export interface Box { x: number; y: number; width: number; height: number }

export interface ChartState extends Box {
  ref: string;
  name: string;
  depth: number;
  composite: boolean;
  final: boolean;
  initial: boolean;
  /** Transitions with no target: they run here without leaving (internal). */
  internal: { id: string; text: string; transition: TransitionDef }[];
  /** y offset inside the box where the internal-transition lines start. */
  bodyTop: number;
}

export type EdgeKind = "command" | "event" | "after" | "done" | "children" | "initial";

export interface ChartEdge {
  /** The transition id, which the log records as `via` — how a frame lights an edge up. */
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  label: string;
  transition?: TransitionDef;
  points: { x: number; y: number }[];
  labelBox?: Box;
}

export interface ChartLayout {
  width: number;
  height: number;
  states: ChartState[];
  /** Initial-state markers: a dot inside each composite (and the root) pointing at `initial`. */
  dots: (Box & { ref: string })[];
  edges: ChartEdge[];
}

const PAD = 14;
const TITLE_H = 26;
const LINE_H = 18;
const DOT = 12;

function shorten(text: string, max = 34): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** What a transition says, in the words an edge label can afford. */
export function transitionLabel(name: string, t: TransitionDef): string {
  const parts = [name];
  if (t.guard) parts.push(`[${shorten(t.guard, 30)}]`);
  const effects = [...t.emit.map((e) => e.event), ...(t.command ? [t.command.target.replace(/\$\{[^}]*\}/g, "…")] : [])];
  if (effects.length > 0) parts.push(`/ ${shorten(effects.join(", "), 30)}`);
  return parts.join(" ");
}

export interface Collected {
  id: string;
  kind: EdgeKind;
  name: string;
  owner: StateDef;
  transition: TransitionDef;
}

function transitionsOf(state: StateDef, machine: MachineDef): Collected[] {
  const kind: EdgeKind = machine.kind === "policy" ? "event" : "command";
  const out: Collected[] = [];
  for (const [name, list] of Object.entries(state.on)) {
    for (const t of list) out.push({ id: t.id, kind, name, owner: state, transition: t });
  }
  for (const a of state.after) out.push({ id: a.transition.id, kind: "after", name: `after ${a.label}`, owner: state, transition: a.transition });
  if (state.onDone) out.push({ id: state.onDone.id, kind: "done", name: "done", owner: state, transition: state.onDone });
  for (const oc of state.onChildren) {
    out.push({ id: oc.transition.id, kind: "children", name: oc.trigger.raw, owner: state, transition: oc.transition });
  }
  return out;
}

/** Every transition in a machine, wherever it is declared — for the inspector. */
export function allTransitions(machine: MachineDef): (Collected & { ownerRef: string })[] {
  const out: (Collected & { ownerRef: string })[] = [];
  const walk = (states: Record<string, StateDef>) => {
    for (const s of Object.values(states)) {
      for (const c of transitionsOf(s, machine)) out.push({ ...c, ownerRef: refOf(s.path) });
      walk(s.states);
    }
  };
  walk(machine.states);
  return out;
}

export async function layoutMachine(machine: MachineDef, measure: Measure = estimate): Promise<ChartLayout> {
  // ELK is most of the bundle; loading it on first layout keeps the first paint fast.
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const states = new Map<string, ChartState>();
  const pendingEdges: { id: string; kind: EdgeKind; from: string; to: string; label: string; transition?: TransitionDef }[] = [];
  const dotRefs: string[] = [];

  const dotId = (ref: string) => `dot:${ref}`;
  const stateId = (ref: string) => `s:${ref}`;

  const build = (defs: Record<string, StateDef>, parentRef: string, initial: string | undefined, depth: number): ElkNode[] => {
    const nodes: ElkNode[] = [];
    if (initial) {
      dotRefs.push(parentRef);
      nodes.push({ id: dotId(parentRef), width: DOT, height: DOT });
      pendingEdges.push({
        id: `initial:${parentRef}`, kind: "initial", from: dotId(parentRef),
        to: stateId(parentRef ? `${parentRef}.${initial}` : initial), label: "",
      });
    }
    for (const def of Object.values(defs)) {
      const ref = refOf(def.path);
      const composite = Object.keys(def.states).length > 0;
      const internal: ChartState["internal"] = [];
      for (const c of transitionsOf(def, machine)) {
        const label = transitionLabel(c.name, c.transition);
        if (c.transition.target === undefined) {
          internal.push({ id: c.id, text: label, transition: c.transition });
        } else {
          pendingEdges.push({
            id: c.id, kind: c.kind, from: stateId(ref), to: stateId(c.transition.target), label, transition: c.transition,
          });
        }
      }
      const bodyTop = TITLE_H;
      const header = bodyTop + internal.length * LINE_H + (internal.length > 0 ? 6 : 0);
      // The title shares its line with the occupancy badge a frame puts top-right.
      const textWidth = Math.max(
        measure(def.name, "title") + (def.final ? 20 : 0) + 34,
        ...internal.map((i) => measure(i.text, "small")),
      );
      states.set(ref, {
        ref, name: def.name, depth, composite, final: def.final,
        initial: false, internal, bodyTop, x: 0, y: 0, width: 0, height: 0,
      });
      const node: ElkNode = { id: stateId(ref) };
      if (composite) {
        node.children = build(def.states, ref, def.initial, depth + 1);
        node.layoutOptions = {
          "elk.padding": `[top=${header + 8},left=${PAD},bottom=${PAD},right=${PAD}]`,
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${textWidth + 2 * PAD}, ${header + 30})`,
        };
      } else {
        node.width = Math.max(textWidth + 2 * PAD, 96);
        // Room under the title for the instance chips a frame puts there.
        node.height = header + 28;
      }
      nodes.push(node);
    }
    return nodes;
  };

  const children = build(machine.states, "", machine.initial, 0);
  for (const child of Object.values(machine.states)) {
    const s = states.get(child.name);
    if (s && child.name === machine.initial) s.initial = true;
  }

  const edges: ElkExtendedEdge[] = pendingEdges.map((e) => ({
    id: e.id,
    sources: [e.from],
    targets: [e.to],
    labels: e.label ? [{ text: e.label, width: measure(e.label, "label") + 8, height: 18 }] : [],
  }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "28",
      "elk.spacing.edgeNode": "18",
      "elk.spacing.edgeEdge": "12",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.inline": "false",
      "elk.layered.edgeLabels.sideSelection": "ALWAYS_UP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
    },
    children,
    edges,
  };

  const out = await elk.layout(graph);

  const dots: ChartLayout["dots"] = [];
  const visit = (nodes: ElkNode[] | undefined) => {
    for (const n of nodes ?? []) {
      const box = { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 };
      if (n.id.startsWith("dot:")) dots.push({ ...box, ref: n.id.slice(4) });
      else Object.assign(states.get(n.id.slice(2))!, box);
      visit(n.children);
    }
  };
  visit(out.children);

  const placed: ChartEdge[] = [];
  const collect = (node: ElkNode) => {
    for (const e of (node.edges ?? []) as ElkExtendedEdge[]) {
      const meta = pendingEdges.find((p) => p.id === e.id)!;
      const points = (e.sections ?? []).flatMap((sec) => [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]);
      const label = e.labels?.[0];
      placed.push({
        id: meta.id, kind: meta.kind, label: meta.label, transition: meta.transition,
        from: meta.from.replace(/^(s|dot):/, ""), to: meta.to.replace(/^s:/, ""),
        points,
        labelBox: label ? { x: label.x ?? 0, y: label.y ?? 0, width: label.width ?? 0, height: label.height ?? 0 } : undefined,
      });
    }
    for (const c of node.children ?? []) collect(c);
  };
  collect(out);

  void dotRefs;
  return { width: out.width ?? 0, height: out.height ?? 0, states: [...states.values()], dots, edges: placed };
}
