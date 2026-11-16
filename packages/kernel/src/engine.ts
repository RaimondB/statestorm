/**
 * The turn loop (docs/design.md §2).
 *
 * One command per turn, breadth-first to quiescence. Resolution bubbles outward through the
 * active configuration; a failed guard does not end the search, it is recorded in the
 * rejection chain. The clock only moves at quiescence.
 */
import { activePath, activeRefs, bubbleOrder, initialConfiguration, isFinalConfiguration, move, pathOf, refOf, stateAt } from "./chart.ts";
import { evaluate, explain, template, templateObject, type Scope } from "./expr.ts";
import type { LogEntry, Rejection } from "./log.ts";
import { isA, parseDuration } from "./model.ts";
import {
  ExprError,
  type ChildTrigger,
  type Configuration,
  type Json,
  type MachineDef,
  type Model,
  type ShapeField,
  type StateDef,
  type Walk,
  type StatePath,
  type TransitionDef,
} from "./types.ts";

export interface Instance {
  key: string;
  machine: string;
  /** Instance id for an aggregate, correlation value for a policy. */
  id: string;
  config: Configuration;
  data: Record<string, Json>;
  parent?: { rel: string; key: string };
  /** Reference name -> the instance key it points at (ADR 0007). Never changes. */
  refs: Record<string, string>;
  /** `<command>:<key>` of every keyed command already applied — ADR 0006 §3. */
  applied: Record<string, true>;
  /** `<state>:<trigger>` of predicate quantifiers already fired for this occupancy of the
   *  state. Cleared when the state is exited, so re-entry re-arms them like a timer. */
  fired: Record<string, true>;
}

/**
 * Delivery is at-least-once with no guaranteed order (ADR 0006). A run is reproducible
 * given a *schedule*, not in spite of one: the schedule is an input.
 */
export type Schedule =
  | { kind: "fifo" }
  | { kind: "random"; seed: number }
  | { kind: "duplicate" };

export function describeSchedule(s: Schedule): string {
  return s.kind === "random" ? `random(${s.seed})` : s.kind;
}

/** Deterministic PRNG (mulberry32), so `random(seed)` reproduces exactly. Its state is plain
 *  data on the world, so a forked world draws the same numbers the original would have. */
function nextRandom(world: World): number {
  const a = (world.rngState + 0x6d2b79f5) >>> 0;
  world.rngState = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface Timer {
  id: number;
  instance: string;
  /** The state that declared the deadline; leaving it cancels the timer (ADR 0005 §5). */
  owner: StatePath;
  at: number;
  label: string;
  transition: TransitionDef;
}

type Input =
  | {
      kind: "command"; type: string; id: string; name: string; payload: Record<string, Json>; cause: number;
      redelivery?: true; broadcast?: true;
      /** ADR 0012: sent by an owner to one of its own entities, inside the aggregate's step. */
      inner?: true;
      /** ADR 0012: addressed to the aggregate, for these of its entities (routing by reference). */
      inside?: { key: string; name: string; payload: Record<string, Json> }[];
    }
  | { kind: "timer"; timer: Timer; cause: number }
  | { kind: "tally"; instance: string; rel: string; trigger: ChildTrigger; cause: number }
  | { kind: "done"; instance: string; state: StatePath; cause: number }
  | { kind: "deliver"; event: string; payload: Record<string, Json>; policy: string; source: string; cause: number; redelivery?: true };

export interface World {
  model: Model;
  schedule: Schedule;
  rngState: number;
  now: number;
  seq: number;
  log: LogEntry[];
  aggregates: Record<string, Instance>;
  policies: Record<string, Instance>;
  children: Record<string, string[]>;
  /** Instance key -> every instance whose reference points at it. Derived at creation,
   *  like the child tally, so the instance pointed at stays unaware (ADR 0007). */
  referrers: Record<string, { key: string; type: string; ref: string }[]>;
  timers: Timer[];
  /** Children already reported for having a class their parent does not declare. */
  unclassified: Set<string>;
  queue: Input[];
  timerSeq: number;
  /** Ceiling on inputs per run, so a cycle is reported rather than hanging (design §2). */
  budget: number;
  /** Present when the run is being recorded for scrubbing — see `Frame`. */
  frames?: Frame[];
  /** ADR 0012 §5: the aggregate whose step is being settled, and what it has caused inside itself. */
  txn?: { aggregate: string; queue: Input[] };
}

/**
 * The world as it stood after one input — what a view renders at index *i* (design §4).
 * The log alone is not enough: it does not record `data`, and it cannot say what is still
 * in flight, which is part of the world too. Cheap because an instance *replaces* its
 * `config` and `data` on every change rather than mutating them, so an unchanged instance
 * is shared with the previous frame.
 */
export interface Frame {
  /** Log length when the frame was taken: entries 1..seq are the past. */
  seq: number;
  now: number;
  /** What just happened, in one line. */
  step: string;
  instances: Record<string, InstanceView>;
  /** Messages delivered to nobody yet, in queue order. */
  inflight: Message[];
  timers: { instance: string; label: string; state: string; at: number }[];
}

export interface InstanceView {
  key: string;
  machine: string;
  kind: "aggregate" | "policy";
  config: Configuration;
  data: Record<string, Json>;
  parent?: { rel: string; key: string };
  refs: Record<string, string>;
}

export interface Message {
  kind: Input["kind"];
  /** The instance it is addressed to. */
  to: string;
  text: string;
  cause: number;
  redelivery?: boolean;
}

interface Tally {
  /** Children in each class, for a classified relation (ADR 0011). */
  byClass?: Record<string, Tally>;
  total: number;
  finals: number;
  inState: Record<string, number>;
}

export function createWorld(
  model: Model,
  startedAt: string | number = "2026-01-01T09:00:00Z",
  schedule: Schedule = { kind: "fifo" },
  options: { frames?: boolean } = {},
): World {
  const world: World = {
    model,
    schedule,
    rngState: (schedule.kind === "random" ? schedule.seed : 1) >>> 0,
    now: typeof startedAt === "number" ? startedAt : Date.parse(startedAt),
    seq: 0,
    log: [],
    aggregates: {},
    policies: {},
    children: {},
    referrers: {},
    timers: [],
    unclassified: new Set<string>(),
    queue: [],
    timerSeq: 0,
    budget: 500,
  };
  if (options.frames) {
    world.frames = [];
    frame(world, "nothing has happened yet");
  }
  return world;
}

function messageOf(input: Input): Message {
  const base = { kind: input.kind, cause: input.cause };
  switch (input.kind) {
    case "command": {
      const to = `${input.type}#${input.id}`;
      return { ...base, to, text: `${to} ← ${input.name}${payloadText(input.payload)}`, redelivery: input.redelivery };
    }
    case "deliver":
      return { ...base, to: input.policy, text: `${input.event} → ${input.policy}`, redelivery: input.redelivery };
    case "timer":
      return { ...base, to: input.timer.instance, text: `${input.timer.label} deadline → ${input.timer.instance}` };
    case "tally":
      return { ...base, to: input.instance, text: `${input.trigger.raw} → ${input.instance}` };
    case "done":
      return { ...base, to: input.instance, text: `done.${refOf(input.state)} → ${input.instance}` };
  }
}

function payloadText(p: Record<string, Json>): string {
  const keys = Object.keys(p);
  return keys.length === 0 ? "" : ` {${keys.map((k) => `${k}: ${JSON.stringify(p[k])}`).join(", ")}}`;
}

function frame(world: World, step: string): void {
  if (!world.frames) return;
  const prev = world.frames[world.frames.length - 1]?.instances ?? {};
  const instances: Record<string, InstanceView> = {};
  const capture = (inst: Instance, kind: InstanceView["kind"]) => {
    const old = prev[inst.key];
    instances[inst.key] = old && old.config === inst.config && old.data === inst.data
      ? old
      : { key: inst.key, machine: inst.machine, kind, config: inst.config, data: inst.data, parent: inst.parent, refs: inst.refs };
  };
  for (const inst of Object.values(world.aggregates)) capture(inst, "aggregate");
  for (const inst of Object.values(world.policies)) capture(inst, "policy");
  world.frames.push({
    seq: world.seq,
    now: world.now,
    step,
    instances,
    inflight: world.queue.map(messageOf),
    timers: world.timers.map((t) => ({ instance: t.instance, label: t.label, state: refOf(t.owner), at: t.at })),
  });
}

type NewEntry = {
  [K in LogEntry["kind"]]: Omit<Extract<LogEntry, { kind: K }>, "seq" | "at">;
}[LogEntry["kind"]];

function write(world: World, entry: NewEntry): number {
  const seq = ++world.seq;
  world.log.push({ ...entry, seq, at: world.now } as LogEntry);
  return seq;
}

function finding(world: World, severity: "info" | "warning" | "error", message: string, cause: number, instance?: string) {
  write(world, { kind: "finding", severity, message, cause, instance });
}

// ---------------------------------------------------------------- aggregates and their steps

/** The aggregate an instance belongs to: itself, or the nearest owner that is one (ADR 0012 §3). */
function aggregateOf(world: World, key: string): string {
  let at = key;
  for (let hops = 0; hops < 50; hops++) {
    const inst = world.aggregates[at];
    if (!inst) return at;
    if (world.model.aggregates[inst.machine]?.role !== "entity" || !inst.parent) return at;
    at = inst.parent.key;
  }
  return at;
}

/** Where an input settles: inside the open aggregate step, if it is about that aggregate. */
function enqueue(world: World, input: Input): void {
  if (world.txn && aggregateTarget(world, input) === world.txn.aggregate) world.txn.queue.push(input);
  else world.queue.push(input);
}

/** The aggregate an input is addressed to — undefined for a policy's input. */
function aggregateTarget(world: World, input: Input): string | undefined {
  switch (input.kind) {
    case "command": {
      const key = `${input.type}#${input.id}`;
      // An entity that does not exist yet is being created by its owner's `send:`, inside.
      if (input.inner && !world.aggregates[key]) return world.txn?.aggregate;
      return world.aggregates[key] ? aggregateOf(world, key) : key;
    }
    case "tally":
    case "done":
      return world.aggregates[input.instance] ? aggregateOf(world, input.instance) : undefined;
    case "timer":
      return world.aggregates[input.timer.instance] ? aggregateOf(world, input.timer.instance) : undefined;
    case "deliver":
      return undefined;
  }
}

/**
 * ADR 0012 §5: one input, and everything it causes inside its own aggregate, as one step. Only
 * events leave — as deliveries to policies, on the world's queue, like any message.
 */
function settle(world: World, input: Input): void {
  const aggregate = aggregateTarget(world, input);
  if (aggregate === undefined) { dispatch(world, input); return; }
  const outer = world.txn;
  world.txn = { aggregate, queue: [] };
  try {
    dispatch(world, input);
    for (let steps = 0; world.txn.queue.length > 0; steps++) {
      if (steps > world.budget) {
        finding(world, "error", `${aggregate}: its step did not settle after ${world.budget} inner steps — a cycle inside the aggregate`, 0, aggregate);
        break;
      }
      dispatch(world, world.txn.queue.shift()!);
    }
  } finally {
    world.txn = outer;
  }
}

// ---------------------------------------------------------------- value objects (ADR 0012 §8)

/** What is wrong with `v` as a `field` of this shape — nothing, when it fits. */
function misfits(model: Model, field: ShapeField, v: Json | undefined, at: string): string[] {
  if (v === undefined || v === null) return field.optional ? [] : [`${at} is missing`];
  if (field.list) {
    if (!Array.isArray(v)) return [`${at} should be a list`];
    return v.flatMap((x, i) => misfits(model, { ...field, list: false, optional: false }, x, `${at}[${i}]`));
  }
  if (["number", "string", "boolean"].includes(field.type)) {
    return typeof v === field.type ? [] : [`${at} should be a ${field.type}, not ${JSON.stringify(v)}`];
  }
  return valueMisfits(model, field.type, v, at);
}

/** A value object is exactly its fields: nothing missing, nothing else. */
function valueMisfits(model: Model, value: string, v: Json, at: string): string[] {
  const def = model.values[value]!;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${at} should be a ${value}`];
  const rec = v as Record<string, Json>;
  const extra = Object.keys(rec).filter((k) => !(k in def.fields)).map((k) => `${at}.${k} is not a field of ${value}`);
  return [...extra, ...Object.entries(def.fields).flatMap(([k, f]) => misfits(model, f, rec[k], `${at}.${k}`))];
}

/** What a command fails to carry of what its rule `takes`. Extra fields are allowed: policies pass context along. */
function payloadMisfits(model: Model, takes: NonNullable<TransitionDef["takes"]>, payload: Record<string, Json>): string[] {
  const fields = "value" in takes ? model.values[takes.value]!.fields : takes.fields;
  return Object.entries(fields).flatMap(([k, f]) => misfits(model, f, payload[k], k));
}

// ---------------------------------------------------------------- scopes and tallies

function tallyOf(world: World, parentKey: string, rel: string, classify?: { by: string; values: string[] }): Tally {
  const out: Tally = { total: 0, finals: 0, inState: {} };
  if (classify) {
    out.byClass = {};
    for (const v of classify.values) out.byClass[v] = { total: 0, finals: 0, inState: {} };
  }
  for (const childKey of world.children[`${parentKey}::${rel}`] ?? []) {
    const child = world.aggregates[childKey];
    if (!child) continue;
    const machine = world.model.aggregates[child.machine]!;
    const final = isFinalConfiguration(machine, child.config);
    const refs = activeRefs(machine, child.config);
    const count = (t: Tally) => {
      t.total++;
      if (final) t.finals++;
      for (const ref of refs) t.inState[ref] = (t.inState[ref] ?? 0) + 1;
    };
    count(out);
    if (classify) {
      const value = String(child.data[classify.by] ?? "");
      const bucket = out.byClass![value];
      if (bucket) count(bucket);
      else if (value !== "" && !world.unclassified.has(childKey)) {
        // A class nobody declared would be counted nowhere — said once, not dropped quietly.
        // (Empty means "not classified yet": the creating command has not set it.)
        world.unclassified.add(childKey);
        finding(world, "warning",
          `${childKey} has ${classify.by} \`${value}\`, which ${parentKey}'s \`${rel}\` does not declare (${classify.values.join(", ")})`,
          0, childKey);
      }
    }
  }
  return out;
}

function tallyText(t: Tally): string {
  const states = Object.entries(t.inState).map(([s, n]) => `${s}:${n}`).join(" ");
  return `${t.finals}/${t.total} final${states ? ` (${states})` : ""}`;
}

function scopeFor(world: World, inst: Instance, machine: MachineDef, extra: Record<string, Json> = {}): Scope {
  const vars: Record<string, Json> = {
    ...inst.data,
    id: inst.id,
    type: inst.machine,
    state: refOf(activePath(inst.config)),
    ...extra,
  };
  for (const [name, key] of Object.entries(inst.refs)) vars[name] = key.slice(key.indexOf("#") + 1);
  for (const [rel, def] of Object.entries(machine.children)) {
    const t = tallyOf(world, inst.key, rel, def.classify);
    // ADR 0010: how many children are in each top-level state, zero-filled from the child
    // type's own states — so `lines.in.failed` is 0, not a missing reference, and a misspelt
    // state is an error rather than a quiet 0.
    const states = Object.keys(world.model.aggregates[def.type]?.states ?? {});
    const view = (x: Tally): Record<string, Json> => {
      const counts: Record<string, Json> = {};
      for (const name of states) counts[name] = x.inState[name] ?? 0;
      return { count: x.total, finals: x.finals, in: counts };
    };
    const v = view(t);
    // ADR 0011: the same, per declared class — `tasks.stage.final.in.failed`.
    if (def.classify && t.byClass) {
      const classes: Record<string, Json> = {};
      for (const value of def.classify.values) classes[value] = view(t.byClass[value]!);
      v[def.classify.by] = classes;
    }
    vars[rel] = v;
  }
  if (machine.kind === "policy") vars.correlation = inst.id;
  return { vars, active: activeRefs(machine, inst.config) };
}

// ---------------------------------------------------------------- resolution

interface Resolved {
  transition?: TransitionDef;
  chain: Rejection[];
  candidates: number;
}

function resolve(
  world: World,
  inst: Instance,
  machine: MachineDef,
  pick: (s: StateDef) => TransitionDef[],
  scope: Scope,
): Resolved {
  const chain: Rejection[] = [];
  let candidates = 0;
  // Innermost-first, bubbling outward — ADR 0005 §2.
  for (const state of bubbleOrder(machine, inst.config)) {
    for (const cand of pick(state)) {
      candidates++;
      if (!cand.guard) return { transition: cand, chain, candidates };
      try {
        const ev = evaluate(cand.guard, scope);
        if (ev.value === true) return { transition: cand, chain, candidates };
        chain.push({ state: refOf(state.path), transition: cand.id, guard: cand.guard, values: explain(ev) });
      } catch (err) {
        // A guard that cannot be evaluated is a model error, and it is reported rather
        // than quietly treated as false.
        chain.push({
          state: refOf(state.path),
          transition: cand.id,
          guard: cand.guard,
          values: "",
          error: err instanceof ExprError ? err.message : String(err),
        });
      }
    }
  }
  return { chain, candidates };
}

// ---------------------------------------------------------------- applying a transition

function cancelTimers(world: World, instanceKey: string, exited: StateDef[]) {
  const gone = new Set(exited.map((s) => refOf(s.path)));
  world.timers = world.timers.filter((t) => !(t.instance === instanceKey && gone.has(refOf(t.owner))));
}

function armTimers(world: World, inst: Instance, entered: StateDef[], cause = 0) {
  for (const state of entered) {
    for (const def of state.after) {
      let ms = def.durationMs;
      if (def.field !== undefined) {
        // ADR 0014: read when the state is entered. A deadline that cannot be read is loud —
        // a missing duration must not quietly mean "never" (or "now").
        const value = inst.data[def.field];
        const text = typeof value === "string" ? value.trim() : "";
        const m = /^(\d+)(ms|s|m|h|d)$/.exec(text);
        if (!m) {
          finding(world, "error", `${inst.key}: the ${def.field} deadline on ${refOf(state.path)} is not armed — \`${def.field}\` is ${JSON.stringify(value ?? null)}, not a duration such as 7d`, cause, inst.key);
          continue;
        }
        ms = parseDuration(text);
      }
      world.timers.push({
        id: ++world.timerSeq,
        instance: inst.key,
        owner: state.path,
        at: world.now + ms,
        label: def.label,
        transition: def.transition,
      });
    }
  }
}

/**
 * The parent relations a new instance of `childType` can belong to, grouped by declaration:
 * a relation declared on an abstract type is inherited by each concrete subclass, and those
 * copies are one relation whose parent type is only known from the key `via` yields
 * (ADR 0009 §3). The loader guarantees at most one declaration per child type.
 */
function parentRelationsFor(model: Model, childType: string) {
  const out = new Map<string, { rel: string; via: string; declaredOn: string; parentTypes: string[] }>();
  for (const parent of Object.values(model.aggregates)) {
    if (parent.abstract) continue;
    for (const [rel, def] of Object.entries(parent.children)) {
      if (!isA(model, childType, def.type)) continue;
      const id = `${def.declaredOn}.${rel}`;
      const entry = out.get(id) ?? { rel, via: def.via, declaredOn: def.declaredOn, parentTypes: [] };
      entry.parentTypes.push(parent.name);
      out.set(id, entry);
    }
  }
  return [...out.values()];
}

function parseCommandRef(text: string): { type: string; id: string; name: string } {
  const dot = text.lastIndexOf(".");
  if (dot < 0) throw new ExprError(`\`${text}\` is not a command — expected Type#id.Name`);
  const head = text.slice(0, dot);
  const name = text.slice(dot + 1);
  const hash = head.indexOf("#");
  return hash < 0
    ? { type: head, id: "-", name }
    : { type: head.slice(0, hash), id: head.slice(hash + 1), name };
}

function issueCommand(
  world: World,
  spec: { target: string; payload: Record<string, Json> },
  scope: Scope,
  cause: number,
  broadcast = false,
) {
  const ref = parseCommandRef(String(template(spec.target, scope)));
  world.queue.push({
    kind: "command",
    type: ref.type,
    id: ref.id,
    name: ref.name,
    payload: templateObject(spec.payload, scope),
    cause,
    ...(broadcast ? { broadcast: true as const } : {}),
  });
}

/** ADR 0012 §4: an owner's commands to its own entities, settled in this step. */
function sendInside(world: World, inst: Instance, transition: TransitionDef, scope: Scope, cause: number): void {
  for (const sd of transition.send) {
    try {
      if (sd.children !== undefined) {
        for (const child of world.children[`${inst.key}::${sd.children}`] ?? []) {
          const hash = child.indexOf("#");
          enqueue(world, {
            kind: "command", type: child.slice(0, hash), id: child.slice(hash + 1), name: sd.command!,
            payload: templateObject(sd.payload, scope), cause, inner: true,
          });
        }
        continue;
      }
      const items = sd.forEach === undefined ? [undefined] : walkOver(sd.forEach, sd.walk, scope);
      if (typeof items === "string") {
        finding(world, "error", `${inst.key}: \`send … for_each\` — ${items}`, cause, inst.key);
        continue;
      }
      items.forEach((vars) => {
        const s = vars === undefined ? scope : { ...scope, vars: { ...scope.vars, ...vars } };
        const ref = parseCommandRef(String(template(sd.to!, s)));
        enqueue(world, { kind: "command", type: ref.type, id: ref.id, name: ref.name, payload: templateObject(sd.payload, s), cause, inner: true });
      });
    } catch (err) {
      finding(world, "error", `${inst.key}: \`${transition.id}\` could not send — ${err instanceof Error ? err.message : String(err)}`, cause, inst.key);
    }
  }
}

/**
 * ADR 0026: what `for_each` walks — its list, or its lists as one; in the order of a field; only
 * the items `where` holds for; one by one (`item`, `index`) or two in a row (`previous`, `item`).
 * A reason, instead, when it cannot: not a list, an item without the order's number.
 */
function walkOver(first: string, walk: Walk | undefined, scope: Scope): Record<string, Json>[] | string {
  let items: Json[] = [];
  for (const expr of [first, ...(walk?.also ?? [])]) {
    const v = evaluate(expr, scope).value;
    if (!Array.isArray(v)) return `\`${expr}\` is not a list`;
    items = items.concat(v);
  }
  if (walk?.order) {
    const field = walk.order;
    const bad = items.find((it) => typeof it !== "object" || it === null || Array.isArray(it) || typeof (it as Record<string, Json>)[field] !== "number");
    if (bad !== undefined) return `an item has no number \`${field}\` to walk in order by: ${JSON.stringify(bad)}`;
    items = items.map((it, i) => ({ it, i })).sort((a, b) => ((a.it as Record<string, number>)[field]! - (b.it as Record<string, number>)[field]!) || a.i - b.i).map((x) => x.it);
  }
  if (walk?.where) {
    const where = walk.where;
    items = items.filter((item) => evaluate(where, { ...scope, vars: { ...scope.vars, item } }).value === true);
  }
  if (walk?.pairs) return items.slice(1).map((item, i) => ({ previous: items[i]!, item, index: i }));
  return items.map((item, index) => ({ item, index }));
}

function predicate(t: Tally, trigger: ChildTrigger): boolean {
  switch (trigger.kind) {
    case "all_final":
      return (t.total > 0 || trigger.allowEmpty) && t.finals === t.total;
    case "first_entering":
    case "any_in":
      return (t.inState[trigger.state!] ?? 0) > 0;
    case "last_leaving":
    case "none_in":
      // `none` is a universal claim, so it is false over an empty collection by default
      // for the same reason `all_final` is (ADR 0004 §3).
      return (t.inState[trigger.state!] ?? 0) === 0 && (t.total > 0 || trigger.allowEmpty);
  }
}

/**
 * Applies a transition: assignments first (against the pre-transition scope), then the
 * state change, then emissions, then entry effects. Returns the resulting log seq.
 */
function applyTransition(
  world: World,
  inst: Instance,
  machine: MachineDef,
  transition: TransitionDef,
  scope: Scope,
  cause: number,
  on: string,
): void {
  const parentBefore = inst.parent
    ? tallyOf(world, inst.parent.key, inst.parent.rel)
    : undefined;

  // ADR 0012 §8: a command that does not carry what its rule takes changes nothing, and says why.
  const payload = scope.vars.command;
  if (transition.takes && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const wrong = payloadMisfits(world.model, transition.takes, payload as Record<string, Json>);
    if (wrong.length > 0) {
      finding(world, "error",
        `${inst.key}: \`${transition.id}\` was not applied — the command does not carry what it takes: ${wrong.join("; ")}`,
        cause, inst.key);
      return;
    }
  }

  const nextData = { ...inst.data };
  for (const [field, expr] of Object.entries(transition.assign)) {
    if (!(field in inst.data)) {
      finding(world, "error", `${inst.key}: \`${transition.id}\` assigns unknown field \`${field}\``, cause, inst.key);
      continue;
    }
    try {
      nextData[field] = evaluate(expr, scope).value;
      const def = machine.data[field];
      if (def?.type === "value" && nextData[field] !== null) {
        const wrong = valueMisfits(world.model, def.value!, nextData[field]!, field);
        if (wrong.length > 0) throw new Error(wrong.join("; "));
      }
      if (def?.type === "list") {
        // Replaced whole (ADR 0015): rows of the value, one per key.
        const rows = nextData[field];
        if (!Array.isArray(rows)) throw new Error(`a list of ${def.value} is replaced by a list`);
        const wrong = rows.flatMap((r, i) => valueMisfits(world.model, def.value!, r, `${field}[${i}]`));
        const keys = rows.map((r) => JSON.stringify((r as Record<string, Json>)[def.key!]));
        if (new Set(keys).size !== keys.length) wrong.push(`two rows with the same ${def.key}`);
        if (wrong.length > 0) throw new Error(wrong.join("; "));
      }
    } catch (err) {
      // Assignments are worked out before anything changes, so a broken one — typically a
      // field the command does not carry — leaves the instance exactly as it was, and says so.
      // Thrown, it would have ended the whole run.
      finding(world, "error",
        `${inst.key}: \`${transition.id}\` was not applied — \`${field}: ${expr}\`: ${err instanceof Error ? err.message : String(err)}`,
        cause, inst.key);
      return;
    }
  }

  // ADR 0015: a row into a list — replacing the one with the same key, or added. A repeat of
  // the same command puts the same row again: nothing changes.
  for (const [field, spec] of Object.entries(transition.put)) {
    const def = machine.data[field]!;
    try {
      const row: Record<string, Json> = {};
      for (const [k, expr] of Object.entries(spec)) row[k] = evaluate(expr, scope).value;
      const wrong = valueMisfits(world.model, def.value!, row, field);
      if (wrong.length > 0) throw new Error(wrong.join("; "));
      const rows = [...((nextData[field] as Json[] | undefined) ?? [])] as Record<string, Json>[];
      const at = rows.findIndex((r) => JSON.stringify(r[def.key!]) === JSON.stringify(row[def.key!]));
      if (at >= 0) rows[at] = row;
      else rows.push(row);
      nextData[field] = rows;
    } catch (err) {
      finding(world, "error",
        `${inst.key}: \`${transition.id}\` was not applied — \`put: ${field}\`: ${err instanceof Error ? err.message : String(err)}`,
        cause, inst.key);
      return;
    }
  }

  const from = refOf(activePath(inst.config));
  let entered: StateDef[] = [];
  if (transition.target) {
    const m = move(machine, inst.config, transition.owner, transition.target);
    for (const state of [...m.exit]) {
      for (const emit of state.emitOnExit) raise(world, inst, machine, emit, scope, cause);
    }
    cancelTimers(world, inst.key, m.exit);
    for (const state of m.exit) {
      const prefix = `${refOf(state.path)}:`;
      for (const mark of Object.keys(inst.fired)) if (mark.startsWith(prefix)) delete inst.fired[mark];
    }
    inst.config = [m.to];
    entered = m.enter;
  }
  inst.data = nextData;

  const to = refOf(activePath(inst.config));
  const internal = transition.target === undefined;
  const seq = machine.kind === "policy"
    ? write(world, { kind: "policy", instance: inst.key, from, to, via: transition.id, on, cause, internal })
    : write(world, { kind: "transition", instance: inst.key, from, to, via: transition.id, cause, internal });

  // Emissions see the post-transition data and state.
  const after = scopeFor(world, inst, machine, scope.vars.command !== undefined || scope.vars.event !== undefined
    ? {
        command: scope.vars.command ?? null,
        event: scope.vars.event ?? null,
        ...(scope.vars.eventName !== undefined ? { eventName: scope.vars.eventName } : {}),
        ...(scope.vars.source !== undefined ? { source: scope.vars.source } : {}),
      }
    : {});

  for (const emit of transition.emit) raise(world, inst, machine, emit, after, seq);
  if (transition.command) {
    if (transition.forEachReferrer) {
      // ADR 0007: every instance pointing at the aggregate that raised the event. An event
      // whose raiser nobody points at reached no one, and that is said out loud.
      const fr = transition.forEachReferrer;
      // The instance pointed at: the event's raiser, unless the rule names another (§8).
      const refType = world.model.aggregates[fr.type]!.references[fr.ref]!.type;
      let source = String(after.vars.source ?? "");
      if (fr.of !== undefined) {
        const named = String(template(fr.of, after));
        source = world.model.aggregates[refType]?.abstract || named.includes("#") ? named : `${refType}#${named}`;
      }
      const all = world.referrers[source] ?? [];
      const targets = all.filter((r) => r.ref === fr.ref && isA(world.model, r.type, fr.type));
      // Several policies may each route to one kind of referrer, so an empty fan-out for one
      // kind is normal. Reaching *no one at all* is the no-op worth saying — once per event.
      if (all.length === 0) {
        const message = `${source} raised ${String(after.vars.eventName ?? "an event")} (#${cause}), and nothing points at it — it reached no one`;
        let said = false;
        for (let i = world.log.length - 1; i >= 0 && world.log[i]!.seq > cause; i--) {
          const e = world.log[i]!;
          if (e.kind === "finding" && e.message === message) { said = true; break; }
        }
        if (!said) finding(world, "warning", message, seq, source);
      }
      // ADR 0012 §4: entities are reached through their aggregate — one command per aggregate,
      // delivered inside to exactly the entities the event is about.
      const through = new Map<string, NonNullable<Extract<Input, { kind: "command" }>["inside"]>>();
      targets.forEach((r, index) => {
        const scopeR = { ...after, vars: { ...after.vars, item: r.key, index } };
        if (world.model.aggregates[r.type]?.role !== "entity") {
          issueCommand(world, transition.command!, scopeR, seq, true);
          return;
        }
        const ref = parseCommandRef(String(template(transition.command!.target, scopeR)));
        const agg = aggregateOf(world, r.key);
        (through.get(agg) ?? through.set(agg, []).get(agg)!).push({
          key: `${ref.type}#${ref.id}`, name: ref.name, payload: templateObject(transition.command!.payload, scopeR),
        });
      });
      for (const [agg, inside] of through) {
        const hash = agg.indexOf("#");
        world.queue.push({
          kind: "command", type: agg.slice(0, hash), id: agg.slice(hash + 1), name: inside[0]!.name,
          payload: inside[0]!.payload, cause: seq, broadcast: true, inside,
        });
      }
    } else if (transition.forEach) {
      const items = walkOver(transition.forEach, transition.walk, after);
      if (typeof items === "string") {
        finding(world, "error", `${inst.key}: \`${transition.id}\` for_each — ${items}`, seq, inst.key);
      } else {
        for (const vars of items) issueCommand(world, transition.command!, { ...after, vars: { ...after.vars, ...vars } }, seq);
      }
    } else {
      issueCommand(world, transition.command, after, seq);
    }
  }

  sendInside(world, inst, transition, after, seq);

  for (const state of entered) {
    for (const emit of state.emitOnEntry) raise(world, inst, machine, emit, after, seq);
    if (state.entryCommand) issueCommand(world, state.entryCommand, after, seq);
  }
  armTimers(world, inst, entered, seq);
  checkPredicates(world, inst, machine, entered, seq);

  // A final substate completes its composite and raises done.<State> — ADR 0005 §6.
  const leaf = activePath(inst.config);
  if (transition.target && leaf.length > 1 && stateAt(machine, leaf).final) {
    const composite = leaf.slice(0, -1);
    const sig = write(world, { kind: "signal", instance: inst.key, signal: `done.${refOf(composite)}`, cause: seq });
    enqueue(world, { kind: "done", instance: inst.key, state: composite, cause: sig });
  }

  if (inst.parent && parentBefore) notifyParent(world, inst, inst.parent, parentBefore, seq);
}

/**
 * A predicate quantifier is a condition on its state, so entering that state is one of the
 * two moments it is checked — the other being a tally change. This is what makes a parent
 * recover when its children finished before it was listening, and what lets a childless
 * parent act at all (Q12 / ADR 0006 §4).
 */
function checkPredicates(
  world: World,
  inst: Instance,
  machine: MachineDef,
  states: StateDef[],
  cause: number,
): void {
  for (const state of states) {
    for (const { trigger } of state.onChildren) {
      if (trigger.form !== "predicate") continue;
      const mark = `${refOf(state.path)}:${trigger.raw}`;
      if (inst.fired[mark]) continue;
      const t = tallyOf(world, inst.key, trigger.rel);
      if (!predicate(t, trigger)) continue;
      inst.fired[mark] = true;
      const seq = write(world, {
        kind: "tally", instance: inst.key, rel: trigger.rel, trigger: trigger.raw,
        before: "on entry", after: tallyText(t), cause,
      });
      world.queue.push({ kind: "tally", instance: inst.key, rel: trigger.rel, trigger, cause: seq });
    }
  }
}

/**
 * At-least-once delivery means the same message can arrive more than once. A transition
 * that declares an identity is applied at most once per identity; one that does not is
 * expected to be *naturally* idempotent — a repeat lands somewhere nothing handles it.
 * Either way the kernel never dedups silently: a recognised repeat is written to the log.
 */
function alreadyApplied(
  world: World,
  inst: Instance,
  transition: TransitionDef,
  scope: Scope,
  name: string,
  cause: number,
): boolean {
  if (transition.idempotency === undefined) return false;
  const mark = `${name}:${JSON.stringify(evaluate(transition.idempotency, scope).value)}`;
  if (inst.applied[mark]) {
    write(world, { kind: "duplicate", instance: inst.key, name, identity: mark, cause });
    return true;
  }
  inst.applied[mark] = true;
  return false;
}

function raise(
  world: World,
  inst: Instance,
  machine: MachineDef,
  emit: { event: string; payload: Record<string, Json> },
  scope: Scope,
  cause: number,
) {
  if (machine.kind === "policy") {
    finding(world, "error", `${inst.key}: policies issue commands, they do not raise events (ADR 0003)`, cause, inst.key);
    return;
  }
  let payload: Record<string, Json>;
  try {
    payload = templateObject(emit.payload, scope);
  } catch (err) {
    // The state change this emission belongs to has happened; the event cannot be raised.
    finding(world, "error",
      `${inst.key}: ${emit.event} was not raised — ${err instanceof Error ? err.message : String(err)}`, cause, inst.key);
    return;
  }
  const seq = write(world, { kind: "event", instance: inst.key, event: emit.event, payload, cause });
  for (const policy of Object.values(world.model.policies)) {
    if (subscribes(policy, emit.event)) {
      world.queue.push({ kind: "deliver", event: emit.event, payload, policy: policy.name, source: inst.key, cause: seq });
    }
  }
}

function subscribes(machine: MachineDef, event: string): boolean {
  const walk = (states: Record<string, StateDef>): boolean =>
    Object.values(states).some((s) => (s.on[event]?.length ?? 0) > 0 || walk(s.states));
  return walk(machine.states);
}

/** Detects tally edges and queues the parent's quantifier rules — ADR 0004 §1. */
function notifyParent(
  world: World,
  child: Instance,
  link: { rel: string; key: string },
  before: Tally,
  cause: number,
) {
  const parent = world.aggregates[link.key];
  if (!parent) return;
  const parentMachine = world.model.aggregates[parent.machine]!;
  const after = tallyOf(world, link.key, link.rel);
  void child;
  const parentActive = activeRefs(parentMachine, parent.config);
  for (const { state, trigger } of parentMachine.allChildTriggers) {
    if (trigger.rel !== link.rel) continue;
    if (!predicate(after, trigger)) continue;

    if (trigger.form === "predicate") {
      // Convergent: what matters is that it holds now, not that it just changed. It only
      // applies while its state is active; otherwise entering that state picks it up.
      if (!parentActive.has(refOf(state))) continue;
      const mark = `${refOf(state)}:${trigger.raw}`;
      if (parent.fired[mark]) continue;
      parent.fired[mark] = true;
    } else if (predicate(before, trigger)) {
      continue; // an edge needs the crossing
    }

    const seq = write(world, {
      kind: "tally",
      instance: parent.key,
      rel: link.rel,
      trigger: trigger.raw,
      before: tallyText(before),
      after: tallyText(after),
      cause,
    });
    enqueue(world, { kind: "tally", instance: parent.key, rel: link.rel, trigger, cause: seq });
  }
}

// ---------------------------------------------------------------- instance creation

/**
 * The instance a creating command would make, unsaved: its initial configuration, its defaults and
 * the references the command sets — enough to try the command's rules on (ADR 0021). Nothing is
 * indexed, linked or said; a reference that cannot be set is left out, and said once it is created.
 */
function provisional(world: World, machine: MachineDef, id: string, payload: Record<string, Json>): Instance {
  const key = `${machine.name}#${id}`;
  const data: Record<string, Json> = {};
  for (const [field, def] of Object.entries(machine.data)) data[field] = def.default;
  const refs: Record<string, string> = {};
  for (const [name, def] of Object.entries(machine.references)) {
    try {
      const target = evaluate(def.via, { vars: { command: payload, id, type: machine.name }, active: new Set<string>() }).value;
      refs[name] = world.model.aggregates[def.type]?.abstract ? String(target) : `${def.type}#${String(target)}`;
    } catch { /* said when it is created */ }
  }
  return { key, machine: machine.name, id, config: initialConfiguration(machine), data, refs, applied: {}, fired: {} };
}

function createAggregate(
  world: World,
  machine: MachineDef,
  id: string,
  command: { name: string; payload: Record<string, Json> },
  cause: number,
): Instance {
  const key = `${machine.name}#${id}`;
  const data: Record<string, Json> = {};
  for (const [field, def] of Object.entries(machine.data)) data[field] = def.default;
  const inst: Instance = {
    key, machine: machine.name, id,
    config: initialConfiguration(machine), data, refs: {}, applied: {}, fired: {},
  };
  world.aggregates[key] = inst;

  // ADR 0007: references are fixed at creation, from the creating command, and indexed the
  // other way round so the instance pointed at never needs to know.
  for (const [name, def] of Object.entries(machine.references)) {
    let target: Json;
    try {
      target = evaluate(def.via, { vars: { command: command.payload, id, type: machine.name }, active: new Set<string>() }).value;
    } catch (err) {
      finding(world, "error",
        `${key}: cannot set reference \`${name}\` — \`via: ${def.via}\` ${err instanceof Error ? err.message : err}`,
        cause, key);
      continue;
    }
    // A reference to an abstract type cannot know the concrete type, so it is a key (ADR 0009 §3).
    const targetKey = world.model.aggregates[def.type]?.abstract ? String(target) : `${def.type}#${String(target)}`;
    inst.refs[name] = targetKey;
    (world.referrers[targetKey] ??= []).push({ key, type: machine.name, ref: name });
  }

  // Link to a parent, if some aggregate declares a relation to this type (ADR 0004 §1). With
  // several possible relations the creating command picks one by the field it carries; exactly
  // one must resolve, and anything else is said, never guessed (ADR 0009 §4).
  const candidates = parentRelationsFor(world.model, machine.name);
  const viaScope: Scope = { vars: { command: command.payload, id, type: machine.name }, active: new Set<string>() };
  const resolved: { rel: (typeof candidates)[number]; value: Json }[] = [];
  const failures: string[] = [];
  for (const rel of candidates) {
    try {
      resolved.push({ rel, value: evaluate(rel.via, viaScope).value });
    } catch (err) {
      failures.push(`\`${rel.declaredOn}.${rel.rel}\` (via: ${rel.via}) ${err instanceof Error ? err.message : err}`);
    }
  }
  if (candidates.length > 0 && resolved.length !== 1) {
    finding(world, "error",
      resolved.length === 0
        ? `${key}: cannot correlate to a parent — ${failures.join("; ")}`
        : `${key}: the creating command names more than one parent (${resolved.map((r) => `${r.rel.declaredOn}.${r.rel.rel}`).join(", ")}) — it must name exactly one`,
      cause, key);
  }
  for (const { rel, value: parentId } of resolved.length === 1 ? resolved : []) {
    let parentKey: string;
    if (world.model.aggregates[rel.declaredOn]?.abstract) {
      // Declared on an abstract type: which concrete parent is meant is part of the value.
      const text = String(parentId);
      const hash = text.indexOf("#");
      const parentType = hash < 0 ? "" : text.slice(0, hash);
      if (!rel.parentTypes.includes(parentType)) {
        finding(world, "error",
          `${key}: \`${rel.rel}\` is declared on the abstract ${rel.declaredOn}, so \`via: ${rel.via}\` must yield the ` +
            `parent's key — one of ${rel.parentTypes.map((t) => `${t}#…`).join(", ")} — not ${JSON.stringify(parentId)}`,
          cause, key);
        continue;
      }
      parentKey = text;
    } else {
      parentKey = `${rel.parentTypes[0]}#${String(parentId)}`;
    }
    inst.parent = { rel: rel.rel, key: parentKey };
    (world.children[`${parentKey}::${rel.rel}`] ??= []).push(key);
    const parent = world.aggregates[parentKey];
    if (parent && isFinalConfiguration(world.model.aggregates[parent.machine]!, parent.config)) {
      // ADR 0004 §7: a child arriving after the parent is final is a modelling error.
      finding(world, "warning", `${key} was created after ${parentKey} had already finished`, cause, key);
    }
  }

  const seq = write(world, { kind: "created", instance: key, state: refOf(activePath(inst.config)), cause });
  const scope = scopeFor(world, inst, machine, { command: command.payload });
  for (let i = 1; i <= activePath(inst.config).length; i++) {
    const state = stateAt(machine, activePath(inst.config).slice(0, i));
    for (const emit of state.emitOnEntry) raise(world, inst, machine, emit, scope, seq);
    if (state.entryCommand) issueCommand(world, state.entryCommand, scope, seq);
  }
  armTimers(world, inst, bubbleOrder(machine, inst.config).reverse());
  checkPredicates(world, inst, machine, bubbleOrder(machine, inst.config).reverse(), seq);
  if (inst.parent) {
    notifyParent(world, inst, inst.parent, { total: 0, finals: 0, inState: {} }, seq);
  }
  return inst;
}

// ---------------------------------------------------------------- dispatch

/**
 * ADR 0012 §4, §6: a command routed to an aggregate for some of its entities, delivered to each.
 * Inside the boundary an entity without an answer is quiet; if nobody answered, the aggregate
 * says so once. A guard that could not be evaluated is reported, inside or not.
 */
function deliverInside(world: World, aggregate: string, inside: { key: string; name: string; payload: Record<string, Json> }[], seq: number): void {
  let answered = false;
  for (const target of inside) {
    const inst = world.aggregates[target.key];
    if (!inst) continue;
    const machine = world.model.aggregates[inst.machine]!;
    const scope = scopeFor(world, inst, machine, { command: target.payload });
    const r = resolve(world, inst, machine, (st) => st.on[target.name] ?? [], scope);
    if (!r.transition) {
      if (r.chain.some((c) => c.error)) write(world, { kind: "rejected", instance: inst.key, name: target.name, chain: r.chain, cause: seq });
      continue;
    }
    answered = true;
    if (alreadyApplied(world, inst, r.transition, scope, target.name, seq)) continue;
    applyTransition(world, inst, machine, r.transition, scope, seq, target.name);
  }
  if (!answered) {
    write(world, {
      kind: "ignored", instance: aggregate, name: inside[0]?.name ?? "?", cause: seq,
      reason: `nothing inside answered (${inside.map((t) => t.key).join(", ")})`,
    });
  }
}

function dispatch(world: World, input: Input): void {
  switch (input.kind) {
    case "command": {
      const key = `${input.type}#${input.id}`;
      const machine = world.model.aggregates[input.type];
      const seq = write(world, {
        kind: "command", instance: key, name: input.name, payload: input.payload,
        cause: input.cause, redelivery: input.redelivery,
      });
      if (!machine) {
        finding(world, "error", `there is no aggregate called \`${input.type}\``, seq, key);
        return;
      }
      if (machine.abstract) {
        finding(world, "error",
          `\`${input.type}\` is abstract and has no instances — address one of its subclasses (ADR 0008)`, seq, key);
        return;
      }
      if (machine.role === "entity" && !input.inner) {
        // ADR 0012 §4: an entity is reached through its aggregate, never addressed from outside.
        const agg = world.aggregates[key] ? aggregateOf(world, key) : undefined;
        finding(world, "error",
          `${key} is an entity${agg ? ` of ${agg}` : ""} — commands go to its aggregate, which sends them on (ADR 0012)`, seq, key);
        return;
      }
      if (input.inside) {
        deliverInside(world, key, input.inside, seq);
        return;
      }
      let inst = world.aggregates[key];
      if (!inst) {
        if (!machine.creators.includes(input.name)) {
          write(world, {
            kind: "unhandled", instance: key, name: input.name, cause: seq,
            reason: `no such instance, and \`${input.name}\` is not one of ${machine.name}'s creators (${machine.creators.join(", ")})`,
          });
          return;
        }
        // ADR 0021: a creating command that no rule accepts creates nothing. It is tried first on
        // the instance it would make — its initial state, its defaults, its references — unsaved.
        const trial = provisional(world, machine, input.id, input.payload);
        const t = resolve(world, trial, machine, (s) => s.on[input.name] ?? [], scopeFor(world, trial, machine, { command: input.payload }));
        if (!t.transition) {
          if (t.candidates === 0) {
            write(world, {
              kind: "unhandled", instance: key, name: input.name, cause: seq,
              reason: `nothing in ${refOf(activePath(trial.config))} or its ancestors handles it — nothing was created`,
            });
          } else {
            write(world, { kind: "rejected", instance: key, name: input.name, chain: t.chain, cause: seq });
          }
          return;
        }
        inst = createAggregate(world, machine, input.id, input, seq);
      }
      const scope = scopeFor(world, inst, machine, { command: input.payload });
      const r = resolve(world, inst, machine, (s) => s.on[input.name] ?? [], scope);
      if (!r.transition && input.broadcast) {
        // A broadcast reaches everyone who points at the raiser; most have no answer, and
        // that is the expected case — recorded, but not as a fault (ADR 0007 §5).
        write(world, {
          kind: "ignored", instance: key, name: input.name, cause: seq,
          reason: r.candidates === 0
            ? `nothing in ${refOf(activePath(inst.config))} handles it`
            : "no rule's guard held",
          chain: r.candidates === 0 ? undefined : r.chain,
        });
        return;
      }
      if (!r.transition) {
        if (r.candidates === 0) {
          write(world, {
            kind: "unhandled", instance: key, name: input.name, cause: seq,
            reason: `nothing in ${refOf(activePath(inst.config))} or its ancestors handles it`,
          });
        } else {
          write(world, { kind: "rejected", instance: key, name: input.name, chain: r.chain, cause: seq });
        }
        return;
      }
      if (alreadyApplied(world, inst, r.transition, scope, input.name, seq)) return;
      applyTransition(world, inst, machine, r.transition, scope, seq, input.name);
      return;
    }

    case "timer": {
      const inst = world.aggregates[input.timer.instance] ?? world.policies[input.timer.instance];
      if (!inst) return;
      const machine = (world.model.aggregates[inst.machine] ?? world.model.policies[inst.machine])!;
      const seq = write(world, {
        kind: "timer", instance: inst.key, label: input.timer.label,
        state: refOf(input.timer.owner), cause: input.cause,
      });
      const scope = scopeFor(world, inst, machine);
      applyTransition(world, inst, machine, input.timer.transition, scope, seq, `after ${input.timer.label}`);
      return;
    }

    case "done": {
      const inst = world.aggregates[input.instance] ?? world.policies[input.instance];
      if (!inst) return;
      const machine = (world.model.aggregates[inst.machine] ?? world.model.policies[inst.machine])!;
      const state = stateAt(machine, input.state);
      if (!state.onDone) {
        finding(world, "info",
          `${inst.key} completed ${refOf(input.state)} and nothing reacts to done.${refOf(input.state)}`,
          input.cause, inst.key);
        return;
      }
      const scope = scopeFor(world, inst, machine);
      applyTransition(world, inst, machine, state.onDone, scope, input.cause, `done.${refOf(input.state)}`);
      return;
    }

    case "tally": {
      const inst = world.aggregates[input.instance];
      if (!inst) return;
      const machine = world.model.aggregates[inst.machine]!;
      const scope = scopeFor(world, inst, machine);
      const r = resolve(world, inst, machine,
        (s) => s.onChildren.filter((oc) => oc.trigger.raw === input.trigger.raw).map((oc) => oc.transition), scope);
      if (!r.transition && r.chain.length > 0) {
        // Rules for this trigger exist here, and every guard said no — or could not be
        // evaluated. Say which, with the values seen, as for a refused command (R21).
        write(world, { kind: "rejected", instance: inst.key, name: input.trigger.raw, chain: r.chain, cause: input.cause });
        return;
      }
      if (!r.transition) {
        // A moment that passed unobserved: the notification the business expected never
        // happened. A predicate would have been picked up again on entry.
        finding(world, input.trigger.form === "edge" ? "warning" : "info",
          `${inst.key} is in ${refOf(activePath(inst.config))}, where \`${input.trigger.raw}\` is not handled`,
          input.cause, inst.key);
        return;
      }
      applyTransition(world, inst, machine, r.transition, scope, input.cause, input.trigger.raw);
      return;
    }

    case "deliver": {
      const machine = world.model.policies[input.policy]!;
      const base: Scope = { vars: { event: input.payload, eventName: input.event }, active: new Set<string>() };
      let correlation = "-";
      if (machine.correlate) {
        try {
          correlation = String(evaluate(machine.correlate, base).value);
        } catch (err) {
          finding(world, "error",
            `${machine.name}: cannot correlate ${input.event} — \`${machine.correlate}\` ${err instanceof Error ? err.message : err}`,
            input.cause);
          return;
        }
      }
      const key = `${machine.name}#${correlation}`;
      let inst = world.policies[key];
      if (!inst) {
        // Only start a policy instance when its initial configuration can actually handle
        // this event — otherwise the policy simply is not interested yet.
        const probe: Instance = {
          key, machine: machine.name, id: correlation,
          config: initialConfiguration(machine), data: {}, refs: {}, applied: {}, fired: {},
        };
        const canStart = bubbleOrder(machine, probe.config).some((s) => (s.on[input.event]?.length ?? 0) > 0);
        if (!canStart) return;
        for (const [field, def] of Object.entries(machine.data)) probe.data[field] = def.default;
        world.policies[key] = probe;
        inst = probe;
        write(world, { kind: "created", instance: key, state: refOf(activePath(inst.config)), cause: input.cause });
        armTimers(world, inst, bubbleOrder(machine, inst.config).reverse());
      }
      const scope = scopeFor(world, inst, machine, { event: input.payload, eventName: input.event, source: input.source });
      const r = resolve(world, inst, machine, (s) => s.on[input.event] ?? [], scope);
      if (!r.transition) {
        if (r.candidates > 0) {
          write(world, { kind: "rejected", instance: key, name: input.event, chain: r.chain, cause: input.cause });
        }
        return;
      }
      if (alreadyApplied(world, inst, r.transition, scope, input.event, input.cause)) return;
      applyTransition(world, inst, machine, r.transition, scope, input.cause, input.event);
      return;
    }
  }
}

/**
 * Takes the next input according to the schedule. `fifo` is the comfortable story a
 * workshop needs; the others are how you find out whether the design survives reality.
 * At-least-once means messages may be duplicated or reordered — never lost.
 */
function take(world: World): Input | undefined {
  if (world.queue.length === 0) return undefined;
  const index = world.schedule.kind === "random" ? Math.floor(nextRandom(world) * world.queue.length) : 0;
  const input = world.queue.splice(index, 1)[0]!;
  if (
    world.schedule.kind === "duplicate" &&
    (input.kind === "command" || input.kind === "deliver") &&
    !input.redelivery
  ) {
    world.queue.push({ ...input, redelivery: true });
  }
  return input;
}

export function runToQuiescence(world: World): void {
  let spent = 0;
  for (;;) {
    if (++spent > world.budget) {
      finding(world, "error",
        `cascade aborted after ${world.budget} steps — the model has a cycle; ${world.queue.length} inputs were dropped`,
        0);
      world.queue = [];
      frame(world, "the cascade was aborted");
      return;
    }
    const input = take(world);
    if (!input) return;
    settle(world, input);
    frame(world, messageOf(input).text);
  }
}

/** Fire a command, by `Type#id.Name`, and run the cascade out. */
export function send(world: World, ref: string, payload: Record<string, Json> = {}): void {
  const parsed = parseCommandRef(ref);
  world.queue.push({ kind: "command", ...parsed, payload, cause: 0 });
  frame(world, `you sent ${ref}`);
  runToQuiescence(world);
}

/**
 * Advances the simulated clock, firing due deadlines oldest-first, each as its own turn.
 * The clock only moves at quiescence (design §2).
 */
export function advance(world: World, ms: number): void {
  const target = world.now + ms;
  for (;;) {
    const due = world.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    const from = world.now;
    world.now = due.at;
    write(world, { kind: "clock", from, to: world.now, cause: 0 });
    world.timers = world.timers.filter((t) => t.id !== due.id);
    world.queue.push({ kind: "timer", timer: due, cause: 0 });
    frame(world, `the clock reached the ${due.label} deadline of ${due.instance}`);
    runToQuiescence(world);
  }
  if (world.now < target) {
    write(world, { kind: "clock", from: world.now, to: target, cause: 0 });
    world.now = target;
    frame(world, "the clock moved on");
  }
}

/**
 * A copy of a world that can run on without touching the original — to try several next steps
 * from one point without replaying the run to it. Shares what never changes (the model, the log
 * entries already written, the rules a deadline points at); copies the rest. Only at rest: not
 * in the middle of a step.
 */
export function fork(world: World): World {
  if (world.txn || world.queue.length > 0) throw new Error("fork: the world is in the middle of a step");
  const copyInstances = (m: Record<string, Instance>) => Object.fromEntries(Object.entries(m).map(([k, i]) => [k, structuredClone(i)]));
  return {
    ...world,
    log: [...world.log],
    aggregates: copyInstances(world.aggregates),
    policies: copyInstances(world.policies),
    children: Object.fromEntries(Object.entries(world.children).map(([k, v]) => [k, [...v]])),
    referrers: Object.fromEntries(Object.entries(world.referrers).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
    timers: world.timers.map((t) => ({ ...t })),
    unclassified: new Set(world.unclassified),
    queue: [],
    frames: undefined,
  };
}

export function stateOf(world: World, key: string): string | undefined {
  const inst = world.aggregates[key] ?? world.policies[key];
  if (!inst) return undefined;
  return refOf(activePath(inst.config));
}

export function activeOf(world: World, key: string): Set<string> {
  const inst = world.aggregates[key] ?? world.policies[key];
  if (!inst) return new Set();
  const machine = (world.model.aggregates[inst.machine] ?? world.model.policies[inst.machine])!;
  return activeRefs(machine, inst.config);
}

export function eventsOf(world: World): { event: string; payload: Record<string, Json> }[] {
  return world.log.flatMap((e) => (e.kind === "event" ? [{ event: e.event, payload: e.payload }] : []));
}

export { pathOf, refOf };
