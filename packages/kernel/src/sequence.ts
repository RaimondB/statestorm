/**
 * ADR 0022 (revising ADR 0018 §5–6): a run as a sequence diagram. Drawn in causal order — each arrow
 * followed by what it caused — with what repeats folded: a model loop into a `loop` frame, a repeat the
 * run made into a dashed one, a set-up and the scenario's phases into sections. Lifelines open one at a
 * time, down one tree: domain → system → sub-system → aggregate. One derivation, read by the workbench
 * and the command line alike; neither folds on its own.
 */
import type { LogEntry } from "./log.ts";
import type { Json, Model, SubsystemDef, TransitionDef } from "./types.ts";
import { mid, ownersOfType, PERSON, placeOf, senderOfCommand, SystemsError, transitionsOf } from "./systems.ts";

// ------------------------------------------------------------------ the lifelines (§7)

/** How deep every lifeline is opened, as one choice — the levels of ADR 0018, kept as presets. */
export type Depth = "domain" | "system" | "subsystem" | "aggregate";
export const DEPTHS: Depth[] = ["domain", "system", "subsystem", "aggregate"];

export interface Lifeline {
  id: string;
  name: string;
  kind: "person" | "domain" | "system" | "subsystem" | "aggregate" | "none";
  external?: boolean;
  /** The node it is drawn inside, when that node is open; absent at the top. */
  parent?: string;
  /** What it opens into; empty: it does not open. */
  children: string[];
  /** Its bounded context, where that says more than its system's name — drawn as a band. */
  band?: string;
}

export interface Lifelines { nodes: Record<string, Lifeline>; roots: string[] }

const NONE = "(no system)";

/**
 * The tree a lifeline opens down. A node with one child that opens itself opens through it: a system
 * with one sub-system opens straight to its aggregates. An external part that sends or receives is a
 * lifeline of its own; one that only runs packages the model specifies opens into their aggregates.
 */
export function lifelinesOf(model: Model): Lifelines {
  const sys = model.systems;
  if (!sys) throw new SystemsError("the model declares no `systems:` (ADR 0018)");
  const nodes: Record<string, Lifeline> = {};
  const put = (l: Lifeline): string => { nodes[l.id] = l; return l.id; };
  const through = (ids: string[]): string[] => (ids.length === 1 && nodes[ids[0]!]!.children.length > 0 ? nodes[ids[0]!]!.children : ids);

  const typesIn = new Map<string, string[]>();
  for (const m of Object.values(model.aggregates)) {
    if (m.abstract || m.role !== "aggregate") continue;
    const p = placeOf(model, m.name);
    if (!p) continue;
    const key = `${p.system}/${p.subsystem}`;
    (typesIn.get(key) ?? typesIn.set(key, []).get(key)!).push(m.name);
  }
  const subsOf = new Map<string, string[]>();
  for (const sub of sys.subsystems) {
    const band = sub.context !== sub.system ? sub.context : undefined;
    const opens = !sub.external || (!(sub.sends?.length) && !(sub.receives?.length));
    const types = opens ? typesIn.get(`${sub.system}/${sub.name}`) ?? [] : [];
    const children = types.map((t) => put({ id: `aggregate:${t}`, name: t, kind: "aggregate", children: [], ...(sub.external ? { external: true } : {}), ...(band ? { band } : {}) }));
    const id = put({ id: `subsystem:${sub.system}/${sub.name}`, name: sub.name, kind: "subsystem", children, ...(sub.external ? { external: true } : {}), ...(band ? { band } : {}) });
    (subsOf.get(sub.system) ?? subsOf.set(sub.system, []).get(sub.system)!).push(id);
  }
  for (const s of sys.systems) {
    const subs = subsOf.get(s.name) ?? [];
    const contexts = [...new Set(sys.subsystems.filter((x) => x.system === s.name).map((x) => x.context))];
    const band = contexts.length === 1 && contexts[0] !== s.name ? contexts[0] : undefined;
    // One sub-system: the system opens straight into what it holds, or does not open at all.
    const children = subs.length === 1 ? nodes[subs[0]!]!.children : subs;
    put({ id: `system:${s.name}`, name: s.name, kind: "system", children, ...(s.external ? { external: true } : {}), ...(band ? { band } : {}) });
  }
  const roots = [put({ id: PERSON, name: PERSON, kind: "person", children: [] })];
  for (const d of sys.domains) {
    const held = sys.systems.filter((s) => s.domain === d.name).map((s) => `system:${s.name}`);
    if (held.length) roots.push(put({ id: `domain:${d.name}`, name: d.name, kind: "domain", children: through(held) }));
  }
  for (const s of sys.systems) if (!s.domain) roots.push(`system:${s.name}`);
  roots.push(put({ id: NONE, name: NONE, kind: "none", children: [] }));
  const walk = (id: string) => { for (const c of nodes[id]!.children) { nodes[c]!.parent = id; walk(c); } };
  for (const r of roots) walk(r);
  return { nodes, roots };
}

/** Every node opened down to `depth`: what the levels of ADR 0018 were, as a starting point. */
export function openAt(lines: Lifelines, depth: Depth): string[] {
  const opened = DEPTHS.slice(0, DEPTHS.indexOf(depth));
  return Object.values(lines.nodes).filter((n) => (opened as string[]).includes(n.kind) && n.children.length > 0 && reachable(lines, n.id)).map((n) => n.id);
}

function reachable(lines: Lifelines, id: string): boolean {
  return lines.roots.includes(id) || lines.nodes[id]?.parent !== undefined;
}

/** The node a name means — its id, or its name when only one node has it. */
export function lifelineNamed(lines: Lifelines, name: string): string {
  if (lines.nodes[name] && reachable(lines, name)) return name;
  const found = Object.values(lines.nodes).filter((n) => n.name === name && reachable(lines, n.id));
  if (found.length === 1) return found[0]!.id;
  if (found.length > 1) throw new SystemsError(`${name}: more than one lifeline has this name — say which: ${found.map((n) => n.id).join(", ")}`);
  throw new SystemsError(`${name}: no domain, system, sub-system or aggregate of that name opens here`);
}

// ------------------------------------------------------------------ the diagram (§1–6)

/** Where the run's phases begin and its set-up ends — from the scenario, not the log. */
export interface SequenceMarks {
  /** Each phase, and the last log entry before it began (0: from the start). */
  phases?: { name: string; after: number }[];
  /** The last log entry of the scenario's `given:` sends. */
  setup?: number;
}

export interface SequenceView {
  /** The nodes opened (ADR 0022 §7). */
  open: string[];
  /** The folds and sections opened or closed against their default (§6). */
  toggled?: string[];
  /** False: nothing is folded (`--unfold`). */
  fold?: boolean;
  /** Show the commands their receiver ignored (§5). */
  ignored?: boolean;
}

export type SequenceItem =
  | {
    kind: "message"; from: string; to: string; label: string; style: "command" | "event";
    /** The first log entry it stands for, and all of them. */
    seq: number; seqs: number[];
    /** The instances it was sent to — what a fold has folded. */
    instances: string[];
    /** What it is, by name: the event that set it off, the command it became (`Type.Command`), the
     *  policy that carried it — for whoever explains it. */
    event?: string; command?: string; policy?: string;
    /** Folded: the same arrow, this many times; `fold` opens it. */
    times?: number; fold?: string;
  }
  | { kind: "note"; over: string; steps: number; text: string }
  | {
    kind: "frame"; frame: "loop" | "repeat" | "section" | "setup"; id: string; label: string;
    /** Folded: a loop or a repeat shows one of its iterations; a section, nothing. */
    folded: boolean;
    seq: number;
    /** The arrows it stands for, unfolded. */
    messages: number;
    items: SequenceItem[];
  };

export interface Sequence {
  open: string[];
  /** In drawing order: the children of an open node side by side. */
  participants: string[];
  /** The participants and every node they are drawn inside. */
  lifelines: Record<string, Lifeline>;
  items: SequenceItem[];
  /** What was left out: the arrows of commands their receiver ignored. */
  hidden: { ignored: number };
}

function typeOfInstance(instance: string): string {
  const i = instance.indexOf("#");
  return i < 0 ? instance : instance.slice(0, i);
}
function idOfInstance(instance: string): string {
  const i = instance.indexOf("#");
  return i < 0 ? instance : instance.slice(i + 1);
}

/** What the rule of a policy firing iterates, when it does: `for each of units`. */
function loopOf(model: Model, entry: Extract<LogEntry, { kind: "policy" }>): string | undefined {
  const m = model.policies[typeOfInstance(entry.instance)];
  const t: TransitionDef | undefined = m ? transitionsOf(m).find((x) => x.id === entry.via) : undefined;
  if (t?.forEach) {
    // ADR 0026: a walk names its lists, its order, and whether it goes two at a time.
    const lists = [t.forEach, ...(t.walk?.also ?? [])].map((l) => l.replace(/^(event|command)\./, "")).join(" and ");
    return `${t.walk?.pairs ? "for each two in a row of" : "for each of"} ${lists}${t.walk?.order ? `, by ${t.walk.order}` : ""}`;
  }
  if (t?.forEachReferrer) return `for each ${t.forEachReferrer.type} that refers to it`;
  return undefined;
}

/** One arrow the log could draw, before a view decides whether it crosses a boundary. */
interface Fact {
  key: string;
  seq: number;
  kind: "input" | "hop" | "inside" | "tell";
  /** The type the arrow lands on, or the external part told. */
  toType?: string;
  toPart?: SubsystemDef;
  fromType?: string;
  fromPart?: SubsystemDef;
  label: string;
  style: "command" | "event";
  instance: string;
  /** The nearest command it descends from; 0, none. */
  parent: number;
  /** The policy firing that sent it, when its rule iterates. */
  loop?: { seq: number; label: string };
  ignored: boolean;
  what: { event?: string; command?: string; policy?: string };
}

function factsOf(model: Model, log: LogEntry[]): Fact[] {
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  const ignored = new Set(log.flatMap((e) => (e.kind === "ignored" ? [e.cause] : [])));
  const parts = model.systems!.subsystems.filter((s) => s.external);
  const commandAbove = (cause: number): number => {
    let e = bySeq.get(cause);
    while (e && (e.kind !== "command" || e.redelivery)) e = bySeq.get(e.cause);
    return e?.seq ?? 0;
  };
  const out: Fact[] = [];
  for (const e of log) {
    if (e.kind === "command") {
      if (e.redelivery) continue;
      const type = typeOfInstance(e.instance);
      const base = { key: `c${e.seq}`, seq: e.seq, toType: type, instance: e.instance, parent: commandAbove(e.cause), ignored: ignored.has(e.seq), what: { command: `${type}.${e.name}` } as Fact["what"] };
      if (e.cause === 0) {
        const part = senderOfCommand(model, type, e.name, e.payload as Record<string, Json>);
        out.push({ ...base, kind: "input", ...(part ? { fromPart: part } : {}), label: `${type}.${e.name}`, style: "command" });
        continue;
      }
      // Walk up the causes: an owner's command means a send inside its aggregate; a policy, a hop.
      let c = bySeq.get(e.cause);
      let hop: Extract<LogEntry, { kind: "event" }> | undefined;
      let loop: Fact["loop"];
      let policy: string | undefined;
      while (c) {
        if (c.kind === "command") break;
        if (c.kind === "policy") {
          policy = typeOfInstance(c.instance);
          const label = loopOf(model, c);
          if (label) loop = { seq: c.seq, label };
          let ev = bySeq.get(c.cause);
          while (ev && ev.kind !== "event") ev = bySeq.get(ev.cause);
          if (ev && ev.kind === "event") hop = ev;
          break;
        }
        c = bySeq.get(c.cause);
      }
      if (hop) out.push({ ...base, kind: "hop", fromType: typeOfInstance(hop.instance), label: `${hop.event} → ${type}.${e.name}`, style: "event", ...(loop ? { loop } : {}), what: { event: hop.event, command: `${type}.${e.name}`, ...(policy ? { policy } : {}) } });
      else out.push({ ...base, kind: "inside", fromType: type, label: `${type}.${e.name}`, style: "command" });
    } else if (e.kind === "event") {
      for (const p of parts.filter((x) => (x.receives ?? []).includes(e.event))) {
        out.push({
          key: `t${e.seq}:${p.system}/${p.name}`, seq: e.seq, kind: "tell", fromType: typeOfInstance(e.instance), toPart: p,
          label: e.event, style: "event", instance: e.instance, parent: commandAbove(e.cause), ignored: false, what: { event: e.event },
        });
      }
    }
  }
  return out;
}

interface Raw {
  seq: number;
  from: string;
  to: string;
  label: string;
  style: "command" | "event";
  instance: string;
  input: boolean;
  loop?: { seq: number; label: string };
  what: Fact["what"];
  inside: Map<string, number>;
  children: Raw[];
}

interface Unit { items: SequenceItem[]; sig: string; seq: number; messages: number; bare: boolean; input: boolean; instances: string[] }

/** What a picture looks like, whatever it was about: no positions, no instances, no ids. */
function signature(items: SequenceItem[]): string {
  return JSON.stringify(items, (k, v) => (["seq", "seqs", "instances", "id", "fold"].includes(k) ? undefined : v));
}

/** The same picture, each of its arrows standing for that arrow in every unit — they are alike. */
function standingFor(units: { items: SequenceItem[] }[]): SequenceItem[] {
  const zip = (pictures: SequenceItem[][]): SequenceItem[] => pictures[0]!.map((item, k) => {
    const alike = pictures.map((p) => p[k]!);
    if (item.kind === "message") {
      const ms = alike as Extract<SequenceItem, { kind: "message" }>[];
      return { ...item, seqs: ms.flatMap((m) => m.seqs), instances: ms.flatMap((m) => m.instances) };
    }
    if (item.kind === "frame") return { ...item, items: zip(alike.map((f) => (f as Extract<SequenceItem, { kind: "frame" }>).items)) };
    return item;
  });
  return zip(units.map((u) => u.items));
}

function repeatedFor(instances: string[], n: number): string {
  const ids = instances.map(idOfInstance);
  if (new Set(ids).size !== ids.length) return `repeated ×${n}`;
  return ids.length > 4 ? `repeated for ${ids.slice(0, 3).join(", ")}, … (×${n})` : `repeated for ${ids.join(", ")}`;
}

/**
 * The messages of a run that cross a boundary of the open lifelines, each followed by what it caused;
 * what stays inside a lifeline is counted into a note. Redeliveries are left out: the diagram is of
 * what happened, once.
 */
export function sequenceOf(model: Model, log: LogEntry[], view: SequenceView, marks: SequenceMarks = {}): Sequence {
  const lines = lifelinesOf(model);
  const open = new Set(view.open.filter((id) => lines.nodes[id]));
  const toggled = new Set(view.toggled ?? []);
  const fold = view.fold !== false;
  const nodes = lines.nodes;

  const visible = (id: string): string => {
    const chain: string[] = [];
    for (let n: string | undefined = id; n; n = nodes[n]?.parent) chain.unshift(n);
    for (const n of chain) if (!open.has(n) || nodes[n]!.children.length === 0) return n;
    return id;
  };
  const leafOfType = (type: string): string => {
    let t = type;
    // An entity is inside its aggregate (ADR 0012): its lifeline is its owner's.
    for (let i = 0; i < 8 && model.aggregates[t]?.role === "entity"; i++) {
      const owner = ownersOfType(model, t).find((o) => model.aggregates[o]) ?? ownersOfType(model, t)[0];
      if (!owner || owner === t) break;
      t = owner;
    }
    if (reachable(lines, `aggregate:${t}`)) return `aggregate:${t}`;
    const p = placeOf(model, t);
    if (!p) return NONE;
    return reachable(lines, `subsystem:${p.system}/${p.subsystem}`) ? `subsystem:${p.system}/${p.subsystem}` : `system:${p.system}`;
  };
  const leafOfPart = (p: SubsystemDef): string => (reachable(lines, `subsystem:${p.system}/${p.name}`) ? `subsystem:${p.system}/${p.name}` : `system:${p.system}`);

  // Which arrows cross, at this opening.
  const facts = factsOf(model, log);
  const drawn = new Map<string, Raw>();
  const drawnCommand = new Set<number>();
  let hiddenIgnored = 0;
  const insides: { parent: number; over: string; seq: number }[] = [];
  const parentOf = new Map<number, number>();
  for (const f of facts) {
    if (f.kind !== "tell") parentOf.set(f.seq, f.parent);
    const to = visible(f.toPart ? leafOfPart(f.toPart) : leafOfType(f.toType!));
    const from = f.kind === "input" ? (f.fromPart ? visible(leafOfPart(f.fromPart)) : PERSON) : visible(leafOfType(f.fromType!));
    const crosses = f.kind === "input" || from !== to;
    if (f.ignored && !view.ignored) { if (crosses) hiddenIgnored++; continue; }
    if (!crosses) {
      if (f.kind !== "tell") insides.push({ parent: f.parent, over: to, seq: f.seq });
      continue;
    }
    drawn.set(f.key, {
      seq: f.seq, from, to, label: f.label, style: f.style, instance: f.instance, input: f.kind === "input", what: f.what,
      ...(f.loop ? { loop: f.loop } : {}), inside: new Map(), children: [],
    });
    if (f.kind !== "tell") drawnCommand.add(f.seq);
  }
  const anchor = (seq: number): number => {
    let s = seq;
    while (s && !drawnCommand.has(s)) s = parentOf.get(s) ?? 0;
    return s;
  };
  const roots: Raw[] = [];
  const factOf = new Map(facts.map((f) => [f.key, f]));
  for (const [key, raw] of drawn) {
    const a = anchor(factOf.get(key)!.parent);
    if (a === 0) roots.push(raw);
    else drawn.get(`c${a}`)!.children.push(raw);
  }
  roots.sort((x, y) => x.seq - y.seq);
  const leading = new Map<string, number>();
  for (const i of insides) {
    const a = anchor(i.parent);
    // A step nothing drawn caused (a deadline's): counted after the arrow before it.
    const host = a ? drawn.get(`c${a}`) : [...roots].reverse().find((r) => r.seq < i.seq);
    const counts = host?.inside ?? leading;
    counts.set(i.over, (counts.get(i.over) ?? 0) + 1);
  }

  const notes = (counts: Map<string, number>): SequenceItem[] =>
    [...counts].map(([over, steps]) => ({ kind: "note", over, steps, text: `${steps} step${steps === 1 ? "" : "s"} inside ${nodes[over]?.name ?? over}` }));

  const picture = (r: Raw): Unit => {
    const then = render(r.children, false);
    const items: SequenceItem[] = [
      { kind: "message", from: r.from, to: r.to, label: r.label, style: r.style, seq: r.seq, seqs: [r.seq], instances: [r.instance], ...r.what },
      ...notes(r.inside), ...then.items,
    ];
    return { items, sig: signature(items), seq: r.seq, messages: 1 + then.messages, bare: r.inside.size === 0 && then.items.length === 0, input: r.input, instances: [r.instance] };
  };

  function render(raws: Raw[], top: boolean): { items: SequenceItem[]; messages: number } {
    const sorted = [...raws].sort((x, y) => x.seq - y.seq);
    let units: (Unit & { raw?: Raw })[] = sorted.map((r) => ({ ...picture(r), raw: r }));
    if (fold) {
      // §2: what one firing of an iterating rule sent across, to one lifeline, as one arrow in a loop.
      const groups = new Map<string, number[]>();
      units.forEach((u, i) => {
        const r = u.raw!;
        if (!r.loop) return;
        const k = `${r.loop.seq}|${r.from}|${r.to}|${r.label}`;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
      });
      const replaced = new Map<number, Unit>();
      const gone = new Set<number>();
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const its = members.map((i) => units[i]!);
        const id = `f${its[0]!.seq}`;
        const same = its.every((u) => u.sig === its[0]!.sig);
        const folded = same && !toggled.has(id);
        const messages = its.reduce((n, u) => n + u.messages, 0);
        const items: SequenceItem[] = [{
          kind: "frame", frame: "loop", id, label: `${its[0]!.raw!.loop!.label} ×${its.length}`, folded, seq: its[0]!.seq, messages,
          items: folded ? standingFor(its) : its.flatMap((u) => u.items),
        }];
        replaced.set(members[0]!, { items, sig: signature(items), seq: its[0]!.seq, messages, bare: false, input: false, instances: its.flatMap((u) => u.instances) });
        for (const i of members.slice(1)) gone.add(i);
      }
      units = units.flatMap((u, i) => (gone.has(i) ? [] : [replaced.get(i) ?? u]));

      // §3: consecutive pictures that are the same, folded — the run repeating itself.
      const out: Unit[] = [];
      for (let i = 0; i < units.length;) {
        let j = i + 1;
        while (j < units.length && units[j]!.sig === units[i]!.sig) j++;
        const run = units.slice(i, j);
        i = j;
        if (run.length === 1) { out.push(run[0]!); continue; }
        const id = `f${run[0]!.seq}`;
        const unfolded = toggled.has(id);
        const n = run.length;
        const messages = run.reduce((k, u) => k + u.messages, 0);
        const instances = run.flatMap((u) => u.instances);
        const label = top && run.every((u) => u.input) ? repeatedFor(instances, n) : `repeated ×${n}`;
        let items: SequenceItem[];
        if (unfolded) items = [{ kind: "frame", frame: "repeat", id, label, folded: false, seq: run[0]!.seq, messages, items: run.flatMap((u) => u.items) }];
        else if (run[0]!.bare) {
          const m = standingFor(run)[0] as Extract<SequenceItem, { kind: "message" }>;
          items = [{ ...m, times: n, fold: id }];
        } else items = [{ kind: "frame", frame: "repeat", id, label, folded: true, seq: run[0]!.seq, messages, items: standingFor(run) }];
        out.push({ items, sig: signature(items), seq: run[0]!.seq, messages, bare: false, input: false, instances });
      }
      units = out;
    }
    return { items: units.flatMap((u) => u.items), messages: units.reduce((n, u) => n + u.messages, 0) };
  }

  // §4: the set-up, folded; the phases, as sections.
  const count = (rs: Raw[]): number => rs.reduce((n, r) => n + 1 + count(r.children), 0);
  const phases = [...(marks.phases ?? [])].sort((a, b) => a.after - b.after);
  const sectionOf = (seq: number) => { let k = -1; phases.forEach((p, i) => { if (p.after < seq) k = i; }); return k; };
  const isSetup = (seq: number) => marks.setup !== undefined && seq <= marks.setup;
  const groups: { section: number; setup: boolean; raws: Raw[] }[] = [];
  for (const r of roots) {
    const section = sectionOf(r.seq);
    const setup = isSetup(r.seq);
    const last = groups[groups.length - 1];
    if (last && last.section === section && last.setup === setup) last.raws.push(r);
    else groups.push({ section, setup, raws: [r] });
  }
  const shown = (g: { setup: boolean; raws: Raw[] }): SequenceItem[] => {
    if (!g.setup) return render(g.raws, true).items;
    const folded = fold && !toggled.has("setup");
    return [{ kind: "frame", frame: "setup", id: "setup", label: "set-up", folded, seq: g.raws[0]!.seq, messages: count(g.raws), items: folded ? [] : render(g.raws, true).items }];
  };
  const items: SequenceItem[] = [...notes(leading)];
  for (let k = 0; k < groups.length;) {
    const section = groups[k]!.section;
    const mine: typeof groups = [];
    while (k < groups.length && groups[k]!.section === section) mine.push(groups[k++]!);
    if (section < 0) { items.push(...mine.flatMap(shown)); continue; }
    const id = `s${section}`;
    const folded = fold && toggled.has(id);
    items.push({
      kind: "frame", frame: "section", id, label: phases[section]!.name, folded, seq: mine[0]!.raws[0]!.seq,
      messages: mine.reduce((n, g) => n + count(g.raws), 0), items: folded ? [] : mine.flatMap(shown),
    });
  }

  // The participants: in order of appearance, the children of an open node side by side.
  const first = new Map<string, number>();
  const meet = (id: string) => { if (!first.has(id)) first.set(id, first.size); };
  const visit = (its: SequenceItem[]) => {
    for (const i of its) {
      if (i.kind === "message") { meet(i.from); meet(i.to); } else if (i.kind === "note") meet(i.over); else visit(i.items);
    }
  };
  visit(items);
  const chain = (id: string): string[] => { const c: string[] = []; for (let n: string | undefined = id; n; n = nodes[n]?.parent) c.unshift(n); return c; };
  const rank = new Map<string, number>();
  for (const [p, i] of first) for (const n of chain(p)) rank.set(n, Math.min(rank.get(n) ?? Infinity, i));
  const participants = [...first.keys()].sort((a, b) => {
    const ca = chain(a).map((n) => rank.get(n)!);
    const cb = chain(b).map((n) => rank.get(n)!);
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) if (ca[i] !== cb[i]) return ca[i]! - cb[i]!;
    return ca.length - cb.length;
  });
  const lifelines: Record<string, Lifeline> = {};
  for (const p of participants) for (const n of chain(p)) lifelines[n] = nodes[n]!;
  return { open: [...open], participants, lifelines, items, hidden: { ignored: hiddenIgnored } };
}

// ------------------------------------------------------------------ Mermaid (§8)

export function sequenceToMermaid(s: Sequence): string {
  const lines = ["sequenceDiagram"];
  if (s.hidden.ignored) lines.push(`  %% left out: ${s.hidden.ignored} arrow${s.hidden.ignored === 1 ? "" : "s"} of commands their receiver ignored — --ignored shows them`);
  const name = (id: string) => s.lifelines[id]?.name ?? id;
  const path = (id: string): string => { const n = s.lifelines[id]!; return n.parent ? `${path(n.parent)} / ${n.name}` : n.name; };
  let box: string | undefined;
  for (const p of s.participants) {
    const parent = s.lifelines[p]?.parent;
    if (parent !== box) {
      if (box) lines.push("  end");
      if (parent) lines.push(`  box transparent ${path(parent)}`);
      box = parent;
    }
    lines.push(`  ${p === PERSON ? "actor" : "participant"} ${mid(p)} as ${name(p)}`);
  }
  if (box) lines.push("  end");
  const across = s.participants.length > 1 ? `${mid(s.participants[0]!)},${mid(s.participants[s.participants.length - 1]!)}` : mid(s.participants[0] ?? PERSON);
  const emit = (items: SequenceItem[], indent: string) => {
    for (const i of items) {
      if (i.kind === "message") lines.push(`${indent}${mid(i.from)}${i.style === "command" ? "->>" : "--)"}${mid(i.to)}: ${i.label}${i.times ? ` ×${i.times}` : ""}`);
      else if (i.kind === "note") lines.push(`${indent}Note over ${mid(i.over)}: ${i.text}`);
      else if (i.frame === "loop" || i.frame === "repeat") {
        lines.push(`${indent}loop ${i.label}`);
        emit(i.items, `${indent}  `);
        lines.push(`${indent}end`);
      } else if (i.folded) lines.push(`${indent}Note over ${across}: ▸ ${i.label} · ${i.messages} message${i.messages === 1 ? "" : "s"}, folded`);
      else {
        lines.push(`${indent}rect rgba(128, 128, 128, 0.08)`);
        lines.push(`${indent}  Note over ${across}: ${i.label}`);
        emit(i.items, `${indent}  `);
        lines.push(`${indent}end`);
      }
    }
  };
  emit(s.items, "  ");
  return lines.join("\n") + "\n";
}
