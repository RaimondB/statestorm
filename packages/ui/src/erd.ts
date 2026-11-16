/**
 * The structure view: every type of the model as an entity-relationship diagram — what each
 * type holds, which owns which, which points at which, which refines which. Derived from the
 * model alone (no run), so it is what the model *says*, for people who think in data.
 *
 *   ownership  (parent/child relation, ADR 0004)  one parent ——< many children
 *   reference  (ADR 0007)                         many referrers >—— one target
 *   extends    (ADR 0008)                         subtype ——▷ supertype
 *   uses       (ADR 0012 §8)                      a type ┄┄> a value object it holds or takes
 *
 * Every box says what it is — aggregate, entity or value object (ADR 0012) — and an aggregate
 * type that owns entities is drawn as a frame around itself and what it owns: its boundary.
 * A box shows only what its type declares itself; what it inherits is on its supertype.
 */
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { isA, type MachineDef, type Model, type ShapeField } from "@statestorm/kernel";
import { estimate, type Measure } from "./chart-layout.ts";
import { allRules, creatorsOf, frameOf } from "./boundaries.ts";

export interface ErdType {
  name: string;
  role: "aggregate" | "entity" | "value";
  /** The aggregate type whose boundary this type is drawn inside (ADR 0012 §3). */
  frame?: string;
  abstract: boolean;
  extends?: string;
  /** Its fields, inherited ones first, each saying where it was declared when not here. */
  fields: { name: string; type: string; note?: string; inherited?: string }[];
  /** Top-level states, the lifecycle a business reader recognises. */
  states: string[];
}
export type RelKind = "owns" | "refers" | "extends" | "uses";
export interface ErdRel {
  id: string;
  kind: RelKind;
  /** An ownership a concrete pair has through a relation inherited from this type — a SiteVisit
   *  owns SiteTasks through the `tasks` the generic Step declares. */
  derivedFrom?: string;
  /** owns: parent → child type; refers: referrer → target; extends: subtype → supertype. */
  from: string;
  to: string;
  label: string;
}
export interface ErdPackage { name: string; note?: string; types: string[] }
export interface Structure {
  types: ErdType[];
  rels: ErdRel[];
  frames: string[];
  /** ADR 0013: the model's packages, each with every type drawn in it — entities included. */
  packages: ErdPackage[];
  /** Packages that would draw ownership wrong, said rather than drawn. */
  errors: string[];
}

const shapeText = (f: ShapeField) => `${f.list ? `[${f.type}]` : f.type}${f.optional ? "?" : ""}`;



/** What a type declares on top of its supertype. */
function own<T>(mine: Record<string, T>, parent: Record<string, T> | undefined): [string, T][] {
  return Object.entries(mine).filter(([k, v]) => !parent || JSON.stringify(parent[k]) !== JSON.stringify(v));
}

export function structureOf(model: Model): Structure {
  const types: ErdType[] = [];
  const rels: ErdRel[] = [];
  const creators = creatorsOf(model);
  for (const m of Object.values(model.aggregates)) {
    const sup: MachineDef | undefined = m.ancestors[0] ? model.aggregates[m.ancestors[0]] : undefined;
    // Everything the type has: what it inherits (and from whom) first, then its own.
    const origin = (pick: (x: MachineDef) => Record<string, unknown>, name: string): string | undefined => {
      let from: string | undefined;
      for (const a of m.ancestors) {
        const anc = model.aggregates[a];
        if (anc && JSON.stringify(pick(anc)[name]) === JSON.stringify(pick(m)[name])) from = a;
      }
      return from;
    };
    const note = (v: unknown) =>
      // A type's own zero is what the kernel fills in when nothing is declared — not worth a word.
      v !== undefined && v !== null && v !== "" && v !== 0 && v !== false && !(Array.isArray(v) && v.length === 0) ? { note: `= ${JSON.stringify(v)}` } : {};
    const fields: ErdType["fields"] = [];
    for (const [name, f] of Object.entries(m.data)) {
      const from = origin((x) => x.data, name);
      fields.push({ name, type: f.type === "value" ? f.value! : f.type === "list" ? `[${f.value}] by ${f.key}` : f.type, ...note(f.default), ...(from ? { inherited: from } : {}) });
    }
    // A reference is a field too — the id it holds — and a line to what it points at.
    for (const [name, r] of Object.entries(m.references)) {
      const from = origin((x) => x.references, name);
      fields.push({ name, type: `→ ${r.type}`, ...(from ? { inherited: from } : {}) });
      if (!from) rels.push({ id: `ref:${m.name}.${name}`, kind: "refers", from: m.name, to: r.type, label: name });
      // Inherited: the concrete type points at it too — a logical line, like an inherited relation.
      else if (!m.abstract) rels.push({ id: `ref:${m.name}.${name}`, kind: "refers", from: m.name, to: r.type, label: name, derivedFrom: from });
    }
    fields.sort((a, b) => Number(!a.inherited) - Number(!b.inherited));
    for (const [rel, c] of Object.entries(m.children)) {
      if (c.declaredOn !== m.name) continue;     // inherited: drawn once, on the type that declares it
      const by = c.classify ? ` · by ${c.classify.by}` : "";
      rels.push({ id: `own:${m.name}.${rel}`, kind: "owns", from: m.name, to: c.type, label: `${rel}${by}` });
    }
    if (sup) rels.push({ id: `ext:${m.name}`, kind: "extends", from: m.name, to: sup.name, label: "" });
    // The value objects this type holds or takes (ADR 0012 §8), each once.
    const uses = new Map<string, string>();
    for (const [name, f] of Object.entries(m.data)) if ((f.type === "value" || f.type === "list") && !sup?.data[name]) uses.set(f.value!, name);
    for (const t of allRules(m)) {
      if (!t.takes || t.inheritedFrom) continue;
      if ("value" in t.takes) { if (!uses.has(t.takes.value)) uses.set(t.takes.value, "takes"); continue; }
      for (const [name, f] of Object.entries(t.takes.fields)) if (model.values[f.type] && !uses.has(f.type)) uses.set(f.type, name);
    }
    for (const [value, via] of uses) rels.push({ id: `use:${m.name}.${value}`, kind: "uses", from: m.name, to: value, label: via });
    const frame = m.role === "entity" ? frameOf(model, m.name, creators) : undefined;
    types.push({
      name: m.name, role: m.role, ...(frame ? { frame } : {}), abstract: m.abstract, ...(sup ? { extends: sup.name } : {}),
      fields, states: Object.keys(m.states),
    });
  }
  for (const v of Object.values(model.values)) {
    types.push({ name: v.name, role: "value", abstract: false, fields: Object.entries(v.fields).map(([n, f]) => ({ name: n, type: shapeText(f) })), states: [] });
    for (const [n, f] of Object.entries(v.fields)) {
      if (model.values[f.type]) rels.push({ id: `use:${v.name}.${n}`, kind: "uses", from: v.name, to: f.type, label: n });
    }
  }
  // The logical lines between concrete types: an inherited relation, as the model uses it. An
  // owner that creates a child names the parent in the field the relation reads (`activity:`,
  // `task:`) — itself (`${type}#…`) or another type by name — and that is the concrete owner.
  for (const m of Object.values(model.aggregates)) {
    for (const t of allRules(m)) {
      for (const sd of t.send) {
        const child = sd.to ? /^([A-Za-z_][A-Za-z0-9_]*)#/.exec(sd.to)?.[1] : undefined;
        if (!child || model.aggregates[child]?.abstract) continue;
        for (const owner of Object.values(model.aggregates)) {
          if (owner.abstract) continue;
          for (const [rel, c] of Object.entries(owner.children)) {
            if (c.declaredOn === owner.name || !isA(model, child, c.type)) continue;
            const field = /^\s*command\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(c.via)?.[1];
            const value = field ? sd.payload[field] : undefined;
            if (typeof value !== "string") continue;
            const named = value.startsWith("${type}#") ? m.name : /^([A-Za-z_][A-Za-z0-9_]*)#/.exec(value)?.[1];
            if (named !== owner.name) continue;
            const id = `own:${owner.name}.${rel}:${child}`;
            if (!rels.some((r) => r.id === id)) rels.push({ id, kind: "owns", from: owner.name, to: child, label: rel, derivedFrom: c.declaredOn });
          }
        }
      }
    }
  }
  // Two references between the same two types are one line, labelled with both names —
  // a link's `before` and `after` both point at a Step.
  const merged: ErdRel[] = [];
  for (const r of rels) {
    const same = r.kind === "refers" && merged.find((m) => m.kind === "refers" && m.from === r.from && m.to === r.to);
    if (same) same.label = `${same.label}, ${r.label}`;
    else merged.push({ ...r });
  }
  rels.length = 0;
  rels.push(...merged);
  // An aggregate type that owns entities is a frame: itself and what it owns.
  const frames = [...new Set(types.map((t) => t.frame).filter((f): f is string => !!f))];
  for (const f of frames) types.find((t) => t.name === f)!.frame = f;

  // ADR 0013 §3: a package holds the types it lists, and the entities of its aggregates.
  const errors: string[] = [];
  const declared = new Map<string, string>();
  for (const p of model.packages) for (const t of p.types) declared.set(t, p.name);
  const packages: ErdPackage[] = model.packages.map((p) => ({ name: p.name, ...(p.note ? { note: p.note } : {}), types: [] }));
  for (const t of types) {
    const own = t.frame && t.frame !== t.name ? declared.get(t.frame) : undefined;
    const said = declared.get(t.name);
    if (own && said && own !== said) {
      errors.push(`packages: ${t.name} is listed in ${said}, but it belongs to ${t.frame}'s aggregate, in ${own} — an entity goes where its aggregate is (ADR 0013)`);
    }
    const home = own ?? said;
    if (home) packages.find((p) => p.name === home)!.types.push(t.name);
  }
  return { types, rels, frames, packages, errors };
}

// ---------------------------------------------------------------- layout

export interface ErdOptions { fields: boolean; states: boolean; inheritance: boolean; packages: boolean; inherited: boolean }
/** `inherited`: show what a concrete type has from its supertypes — fields and lines. */
export const DEFAULT_ERD: ErdOptions = { fields: true, states: false, inheritance: true, packages: true, inherited: true };

export const ERD = { pad: 10, head: 40, line: 17, minW: 150 };

export interface PlacedType extends ErdType {
  x: number; y: number; width: number; height: number; lines: Line[];
  /** Refines a type in another package: said in the box, not drawn as a line across packages. */
  refinesElsewhere?: true;
}
export interface PlacedRel extends ErdRel { points: { x: number; y: number }[]; labelBox?: { x: number; y: number; width: number; height: number } }
export interface PlacedFrame { name: string; x: number; y: number; width: number; height: number }
export interface ErdLayout {
  width: number; height: number; types: PlacedType[]; rels: PlacedRel[]; frames: PlacedFrame[];
  packages: (PlacedFrame & { note?: string })[];
}

/** The text lines under a box's title, as the options ask. */
export interface Line { text: string; inherited?: string }

export function linesOf(t: ErdType, o: ErdOptions): Line[] {
  const out: Line[] = [];
  if (o.fields) {
    for (const f of t.fields) {
      if (f.inherited && !o.inherited) continue;
      out.push({ text: `${f.name}: ${f.type}${f.note ? ` ${f.note}` : ""}`, ...(f.inherited ? { inherited: f.inherited } : {}) });
    }
  }
  if (o.states && t.states.length) {
    if (out.length) out.push({ text: "" });
    // Wrapped, so a long lifecycle does not make one box as wide as the page.
    let row = "";
    for (const s of t.states.map((x) => x.replace(/_/g, " "))) {
      const next = row ? `${row} · ${s}` : s;
      if (next.length > 34 && row) { out.push({ text: row }); row = s; } else row = next;
    }
    if (row) out.push({ text: row });
  }
  return out;
}

export async function layoutErd(s: Structure, o: ErdOptions = DEFAULT_ERD, measure: Measure = estimate): Promise<ErdLayout> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  // With packages, a refinement of a type in another package — a site's task of the generic Task —
  // is said in the box rather than drawn: the generic package is a component everything uses.
  const home = new Map((o.packages ? s.packages : []).flatMap((p) => p.types.map((t) => [t, p.name] as const)));
  const across = (r: ErdRel) => r.kind === "extends" && o.packages && home.get(r.from) !== home.get(r.to);
  const elsewhere = new Set(s.rels.filter(across).map((r) => r.from));
  const rels = s.rels.filter((r) => (o.inheritance || r.kind !== "extends") && !across(r) && (o.inherited || !r.derivedFrom))
    .filter((r) => s.types.some((t) => t.name === r.to) && s.types.some((t) => t.name === r.from));
  const sized = s.types.map((t) => {
    const lines = linesOf(t, o);
    // The stereotype line is as wide as the name can be: «entity» abstract ▷ Handling.
    const stereo = `«${t.role === "value" ? "value object" : t.role}»${t.abstract ? " abstract" : ""}${elsewhere.has(t.name) && o.inheritance ? ` ▷ ${t.extends}` : ""}`;
    const width = Math.max(ERD.minW, measure(t.name, "title") + 2 * ERD.pad + 40, measure(stereo, "label") + 2 * ERD.pad,
      ...lines.map((l) => measure(l.text, "small") + 2 * ERD.pad));
    const height = ERD.head + (lines.length ? lines.length * ERD.line + ERD.pad : 0);
    return { ...t, lines, width, height };
  });
  const node = (t: (typeof sized)[number]): ElkNode => ({ id: t.name, width: t.width, height: t.height });
  const listed = o.packages ? s.packages.filter((p) => p.types.length > 0) : [];
  const packageOf = new Map(listed.flatMap((p) => p.types.map((t) => [t, p.name] as const)));
  // What sits directly in a package (or, for undefined, at the top): its frames, and its types
  // that are in no frame.
  const level = (pkg: string | undefined): ElkNode[] => [
    ...s.frames.filter((f) => packageOf.get(f) === pkg).map((f): ElkNode => ({
      id: `frame:${f}`,
      layoutOptions: { "elk.padding": "[top=34,left=16,bottom=16,right=16]" },
      children: sized.filter((t) => t.frame === f).map(node),
    })),
    ...sized.filter((t) => !t.frame && packageOf.get(t.name) === pkg).map(node),
  ];
  const packages = listed.filter((p) => level(p.name).length > 0);
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.spacing.nodeNode": "36",
      "elk.spacing.edgeNode": "20",
      "elk.spacing.edgeEdge": "12",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.edgeLabels.inline": "false",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
    },
    // A package holds frames and loose types; a frame — the aggregate's boundary — holds the
    // aggregate and what it owns. Both are compound nodes.
    children: [
      ...packages.map((p): ElkNode => ({
        id: `package:${p.name}`,
        layoutOptions: { "elk.padding": "[top=52,left=18,bottom=18,right=18]" },
        children: level(p.name),
      })),
      ...level(undefined),
    ],
    // Layered top-down by what owns what and what refines what: an owner above what it owns,
    // a supertype above its subtypes. A reference is drawn, but does not decide the layers.
    edges: rels.map((r): ElkExtendedEdge => {
      const [source, target] = r.kind === "extends" || r.kind === "refers" ? [r.to, r.from] : [r.from, r.to];
      return {
        id: r.id, sources: [source], targets: [target],
        layoutOptions: { "elk.layered.priority.direction": r.kind === "owns" ? "10" : r.kind === "extends" ? "6" : r.kind === "uses" ? "2" : "0" },
        labels: r.label ? [{ text: r.label, width: measure(r.label, "small") + 6, height: 16 }] : [],
      };
    }),
  };
  const out = await elk.layout(graph);
  const at = new Map<string, ElkNode>();
  const collect = (nodes: ElkNode[] | undefined) => { for (const n of nodes ?? []) { at.set(n.id, n); collect(n.children); } };
  collect(out.children);
  const box = (id: string) => { const n = at.get(id)!; return { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 }; };
  const frames: PlacedFrame[] = s.frames.map((f) => ({ name: f, ...box(`frame:${f}`) }));
  const placedPackages = packages.map((p) => ({ name: p.name, ...(p.note ? { note: p.note } : {}), ...box(`package:${p.name}`) }));
  const types: PlacedType[] = sized.map((t) => ({
    ...t, x: at.get(t.name)?.x ?? 0, y: at.get(t.name)?.y ?? 0, ...(elsewhere.has(t.name) && o.inheritance ? { refinesElsewhere: true as const } : {}),
  }));
  const edgesOf = (n: ElkNode): ElkExtendedEdge[] => [...((n.edges ?? []) as ElkExtendedEdge[]), ...(n.children ?? []).flatMap(edgesOf)];
  const placed: PlacedRel[] = edgesOf(out).map((e) => {
    const r = rels.find((x) => x.id === e.id)!;
    let points = (e.sections ?? []).flatMap((sec) => [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]);
    // Laid out with refines/refers reversed; drawn from → to, so the ends sit where they mean.
    if (r.kind === "extends" || r.kind === "refers") points = [...points].reverse();
    const l = e.labels?.[0];
    return { ...r, points, ...(l ? { labelBox: { x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0 } } : {}) };
  });
  return { width: out.width ?? 0, height: out.height ?? 0, types, rels: placed, frames, packages: placedPackages };
}

/** A type and everything one line away from it — for focusing on one part of a big model. */
export function neighbourhood(s: Structure, name: string): Set<string> {
  const out = new Set([name]);
  for (const r of s.rels) {
    if (r.from === name) out.add(r.to);
    if (r.to === name) out.add(r.from);
  }
  return out;
}
