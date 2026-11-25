/**
 * Loading and validating a model file. Validation is hand-written rather than schema-driven
 * so the messages can name the state and the key that is wrong — a model is read by people
 * who are not programmers, and "expected object, received string at .states.a.on" is not an
 * error message for them.
 */
import { sequenceLabelsOf, SystemsError, systemFindings, systemsOf } from "./systems.ts";
import { located, mergeModel } from "./include.ts";
import { refsOf } from "./expr.ts";
import { ANCESTORS, INHERITED, resolveInheritance } from "./inherit.ts";
import {
  ModelError,
  type Walk,
  type ChildRelDef,
  type ChildTrigger,
  type CommandDef,
  type EmitDef,
  type FieldDef,
  type Json,
  type MachineDef,
  type Model,
  type ModelFinding,
  type PackageDef,
  type RefDef,
  type SendDef,
  type ShapeField,
  type ValueDef,
  type StateDef,
  type StatePath,
  type TimerDef,
  type TransitionDef,
} from "./types.ts";

type Raw = Record<string, any>;

const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number {
  const m = DURATION.exec(text.trim());
  if (!m) throw new ModelError(`\`${text}\` is not a duration (try 90s, 15m, 6h, 14d)`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}

function asRecord(v: unknown, where: string): Raw {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ModelError(`${where}: expected a block`);
  return v as Raw;
}

/** ADR 0016: `why:` — the ids of the domain's rules this part of the model implements. Carried, never run. */
function whyOf(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !/^\S+$/.test(x))) {
    throw new ModelError(`${where}.why: a list of the ids of the rules it implements, e.g. \`why: [R3]\` (ADR 0016)`);
  }
  return v as string[];
}

function emits(v: unknown, where: string): EmitDef[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((item) => {
    if (typeof item === "string") return { event: item, payload: {} };
    const rec = asRecord(item, where);
    const keys = Object.keys(rec);
    if (keys.length !== 1) throw new ModelError(`${where}: an emit entry names one event`);
    const name = keys[0]!;
    return { event: name, payload: asRecord(rec[name], `${where}.${name}`) as Record<string, Json> };
  });
}

function commandOf(raw: Raw, where: string): CommandDef | undefined {
  if (raw.command === undefined) return undefined;
  if (typeof raw.command !== "string") throw new ModelError(`${where}.command: expected a string`);
  return { target: raw.command, payload: asRecord(raw.with, `${where}.with`) as Record<string, Json> };
}

/**
 * A field spec of a value object or a payload: `string`, `number?` (optional), `TubeRow`,
 * `[TubeRow]` (a list — payloads only).
 */
function shapeField(raw: unknown, where: string, lists: boolean): ShapeField {
  let text = String(raw).trim();
  let list = false;
  if (text.startsWith("[") && text.endsWith("]")) { list = true; text = text.slice(1, -1).trim(); }
  if (Array.isArray(raw) && raw.length === 1) { list = true; text = String(raw[0]).trim(); }
  const optional = text.endsWith("?");
  if (optional) text = text.slice(0, -1).trim();
  if (list && !lists) throw new ModelError(`${where}: a list is a payload's, never a field's (ADR 0012 §8)`);
  if (!["number", "string", "boolean"].includes(text) && !knownValues.has(text)) {
    throw new ModelError(`${where}: \`${text}\` is not number, string, boolean or a value object`);
  }
  return { type: text, optional, list };
}

function shapeFields(raw: unknown, where: string, lists: boolean): Record<string, ShapeField> {
  const out: Record<string, ShapeField> = {};
  for (const [k, v] of Object.entries(asRecord(raw, where))) out[k] = shapeField(v, `${where}.${k}`, lists);
  return out;
}

function takes(raw: unknown, where: string): TransitionDef["takes"] {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    if (!knownValues.has(raw)) throw new ModelError(`${where}: \`${raw}\` is not a value object`);
    return { value: raw };
  }
  return { fields: shapeFields(raw, where, true) };
}

/** ADR 0012: `send:` — one entry, or a list, each `{ to, with, for_each }` or `{ children, command, with }`. */
function sends(v: unknown, where: string): SendDef[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((item, i) => {
    const rec = asRecord(item, `${where}[${i}]`);
    for (const k of Object.keys(rec)) {
      if (!["to", "children", "command", "with", "for_each", ...WALK_KEYS].includes(k)) throw new ModelError(`${where}[${i}]: unknown key \`${k}\` (expected to, children, command, with, for_each, ${WALK_KEYS.join(", ")})`);
    }
    const payload = asRecord(rec.with, `${where}[${i}].with`) as Record<string, Json>;
    if (rec.to !== undefined) {
      if (rec.children !== undefined || rec.command !== undefined) throw new ModelError(`${where}[${i}]: \`to\` names the command itself — not with \`children\` or \`command\``);
      return { to: String(rec.to), payload, ...walkOf(rec, `${where}[${i}]`) };
    }
    if (rec.children === undefined || rec.command === undefined) {
      throw new ModelError(`${where}[${i}]: send needs \`to: Type#id.Command\`, or \`children: <relation>\` with \`command\``);
    }
    if (rec.for_each !== undefined || WALK_KEYS.some((k) => rec[k] !== undefined)) throw new ModelError(`${where}[${i}]: \`children\` already means every child — no \`for_each\``);
    return { children: String(rec.children), command: String(rec.command), payload };
  });
}

const WALK_KEYS = ["order", "where", "pairs"];

/**
 * ADR 0026: `for_each` — one list, or several walked as one (`[a, b]`) — and how: `order` (a field
 * of the items, a number), `where` (an expression about `item`), `pairs` (true: two items in a row).
 */
function walkOf(rec: Record<string, unknown>, where: string): { forEach?: string; walk?: Walk } {
  const extra = WALK_KEYS.filter((k) => rec[k] !== undefined);
  if (rec.for_each === undefined) {
    if (extra.length) throw new ModelError(`${where}: \`${extra.join("`, `")}\` say how \`for_each\` walks — there is no \`for_each\``);
    return {};
  }
  const lists = Array.isArray(rec.for_each) ? rec.for_each.map(String) : [String(rec.for_each)];
  if (lists.length === 0) throw new ModelError(`${where}: \`for_each\` names no list`);
  if (rec.pairs !== undefined && typeof rec.pairs !== "boolean") throw new ModelError(`${where}: \`pairs\` is true or false`);
  if (rec.order !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(rec.order))) throw new ModelError(`${where}: \`order\` names a field of the items, e.g. \`seq\``);
  const walk: Walk = {
    ...(lists.length > 1 ? { also: lists.slice(1) } : {}),
    ...(rec.order !== undefined ? { order: String(rec.order) } : {}),
    ...(rec.where !== undefined ? { where: String(rec.where) } : {}),
    ...(rec.pairs === true ? { pairs: true } : {}),
  };
  return { forEach: lists[0]!, ...(Object.keys(walk).length > 0 ? { walk } : {}) };
}

function transition(raw: unknown, id: string, owner: StatePath): TransitionDef {
  const rec = asRecord(raw, id);
  for (const key of Object.keys(rec)) {
    if (!["guard", "assign", "put", "target", "emit", "command", "with", "for_each", ...WALK_KEYS, "for_each_referrer", "allow_empty", "idempotency", "send", "takes", "why", INHERITED].includes(key)) {
      throw new ModelError(`${id}: unknown key \`${key}\``);
    }
  }
  return {
    id,
    owner,
    idempotency: rec.idempotency === undefined ? undefined : String(rec.idempotency),
    guard: rec.guard === undefined ? undefined : String(rec.guard),
    assign: expressions(asRecord(rec.assign, `${id}.assign`), `${id}.assign`),
    put: Object.fromEntries(Object.entries(asRecord(rec.put, `${id}.put`)).map(([f, row]) =>
      [f, expressions(asRecord(row, `${id}.put.${f}`), `${id}.put.${f}`)])),
    target: rec.target === undefined ? undefined : String(rec.target),
    emit: emits(rec.emit, `${id}.emit`),
    command: commandOf(rec, id),
    send: sends(rec.send, `${id}.send`),
    takes: takes(rec.takes, `${id}.takes`),
    ...walkOf(rec, id),
    forEachReferrer: referrer(rec.for_each_referrer, id),
    inheritedFrom: rec[INHERITED] === undefined ? undefined : String(rec[INHERITED]),
    why: whyOf(rec.why, id),
  };
}

/**
 * An assignment's value is an expression. YAML reads `rank: 2` or `paid: true` as a number or
 * a boolean, which is the same expression written without quotes — so it is read as one.
 */
function expressions(raw: Record<string, unknown>, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else if (typeof v === "string") out[k] = v;
    else throw new ModelError(`${where}.${k}: an assignment is an expression, not ${JSON.stringify(v)}`);
  }
  return out;
}

/**
 * `for_each_referrer: Handling.unit` — every Handling whose `unit` points at the raiser; or
 * `{ via: Handling.unit, of: "${event.unit}" }` — at the instance the event names (ADR 0007 §8).
 */
function referrer(raw: unknown, where: string): TransitionDef["forEachReferrer"] {
  if (raw === undefined) return undefined;
  let via = raw;
  let of: string | undefined;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Raw;
    for (const k of Object.keys(rec)) {
      if (!["via", "of"].includes(k)) throw new ModelError(`${where}: \`for_each_referrer\` takes \`via\` and \`of\`, not \`${k}\``);
    }
    via = rec.via;
    if (rec.of === undefined) throw new ModelError(`${where}: \`for_each_referrer\` as a block needs \`of\` — the instance pointed at`);
    of = String(rec.of);
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(via).trim());
  if (!m) {
    throw new ModelError(`${where}: \`for_each_referrer: ${via}\` should name a type and its reference, e.g. Handling.unit`);
  }
  return of === undefined ? { type: m[1]!, ref: m[2]! } : { type: m[1]!, ref: m[2]!, of };
}

const TRIGGER = /^([A-Za-z_][A-Za-z0-9_]*)\.(all_final|first_entering|last_leaving|any|none)(?:\(([^)]*)\))?$/;

function childTrigger(key: string, raw: Raw, where: string): ChildTrigger {
  const m = TRIGGER.exec(key.trim());
  if (!m) {
    throw new ModelError(
      `${where}: \`${key}\` is not a child quantifier — expected ` +
        `<relation>.all_final, .first_entering(<state>), .last_leaving(<state>), .any(<state>) or .none(<state>)`,
    );
  }
  const [, rel, kind, arg] = m;
  const needsArg = kind !== "all_final";
  if (needsArg && !arg) throw new ModelError(`${where}: \`${key}\` needs a state, e.g. ${rel}.${kind}(shipped)`);
  if (!needsArg && arg) throw new ModelError(`${where}: \`${key}\` takes no argument`);
  const resolved = kind === "any" ? "any_in" : kind === "none" ? "none_in" : (kind as ChildTrigger["kind"]);
  return {
    raw: key,
    rel: rel!,
    kind: resolved,
    // `first_entering` / `last_leaving` are moments; the rest are conditions (ADR 0006 §4).
    form: resolved === "first_entering" || resolved === "last_leaving" ? "edge" : "predicate",
    state: arg?.trim(),
    // ADR 0004 §3: a universal quantifier is false over an empty collection unless the
    // model opts in, so a childless parent does not complete itself on creation.
    allowEmpty: raw.allow_empty === true,
  };
}

function timers(raw: Raw, owner: StatePath, where: string): TimerDef[] {
  const after = asRecord(raw.after, `${where}.after`);
  return Object.entries(after).map(([dur, body]) => {
    // A literal duration, or (ADR 0014) the name of a data field that holds one.
    const field = DURATION.test(dur.trim()) ? undefined : dur.trim();
    if (field !== undefined && !/^[A-Za-z_]\w*$/.test(field)) parseDuration(dur);   // says what a duration looks like
    return {
      durationMs: field === undefined ? parseDuration(dur) : 0,
      ...(field === undefined ? {} : { field }),
      label: dur,
      transition: transition(body, `${where} after ${dur}`, owner),
    };
  });
}

function stateDef(name: string, raw: unknown, parent: StatePath, machine: string): StateDef {
  const rec = asRecord(raw, `${machine}.${[...parent, name].join(".")}`);
  const path = [...parent, name];
  const where = `${machine}.${path.join(".")}`;
  for (const key of Object.keys(rec)) {
    if (!["initial", "states", "final", "on", "on_children", "on_done", "after", "emit_on_entry", "emit_on_exit", "on_entry", "why"].includes(key)) {
      throw new ModelError(`${where}: unknown key \`${key}\``);
    }
  }

  const children: Record<string, StateDef> = {};
  for (const [childName, childRaw] of Object.entries(asRecord(rec.states, `${where}.states`))) {
    children[childName] = stateDef(childName, childRaw, path, machine);
  }
  if (Object.keys(children).length > 0 && !rec.initial) {
    // ADR 0005 §8: no defaulting to "the first one listed".
    throw new ModelError(`${where}: a composite state must declare \`initial\``);
  }
  if (rec.initial && !children[String(rec.initial)]) {
    throw new ModelError(`${where}: initial state \`${rec.initial}\` is not one of its substates`);
  }

  const on: Record<string, TransitionDef[]> = {};
  for (const [key, body] of Object.entries(asRecord(rec.on, `${where}.on`))) {
    // `Pay#partial` is a second rule for the same command: same base name, own guard.
    const base = key.split("#")[0]!.trim();
    (on[base] ??= []).push(transition(body, `${where} on ${key}`, path));
  }

  const onChildren: StateDef["onChildren"] = [];
  for (const [key, body] of Object.entries(asRecord(rec.on_children, `${where}.on_children`))) {
    const rawBody = asRecord(body, `${where}.on_children.${key}`);
    // `lines.all_final#partial` is a second rule for the same trigger, with its own guard —
    // like `Pay#partial` for a command (ADR 0010 §2). The trigger is the part before `#`.
    const base = key.split("#")[0]!.trim();
    onChildren.push({
      trigger: childTrigger(base, rawBody, `${where}.on_children`),
      transition: transition({ ...rawBody, allow_empty: undefined }, `${where} on_children ${key}`, path),
    });
  }

  const entry = asRecord(rec.on_entry, `${where}.on_entry`);
  return {
    name,
    path,
    final: rec.final === true,
    initial: rec.initial === undefined ? undefined : String(rec.initial),
    states: children,
    on,
    onChildren,
    onDone: rec.on_done === undefined ? undefined : transition(rec.on_done, `${where} on_done`, path),
    after: timers(rec, path, where),
    emitOnEntry: emits(rec.emit_on_entry, `${where}.emit_on_entry`),
    emitOnExit: emits(rec.emit_on_exit, `${where}.emit_on_exit`),
    entryCommand: commandOf(entry, `${where}.on_entry`),
    why: whyOf(rec.why, where),
  };
}

function collectTriggers(
  states: Record<string, StateDef>,
  out: { state: StatePath; trigger: ChildTrigger }[],
): { state: StatePath; trigger: ChildTrigger }[] {
  for (const s of Object.values(states)) {
    // Variants of one trigger share it: it is watched — and queued — once, and resolution
    // then tries the variants in order.
    for (const oc of s.onChildren) {
      if (!out.some((o) => o.state === s.path && o.trigger.raw === oc.trigger.raw)) out.push({ state: s.path, trigger: oc.trigger });
    }
    collectTriggers(s.states, out);
  }
  return out;
}

/**
 * Legal but suspect, given at-least-once delivery and no guaranteed order (ADR 0006 §5).
 * These are warnings on the model, not errors: the modeller may know better.
 */
function lint(machine: MachineDef): ModelFinding[] {
  const out: ModelFinding[] = [];
  const walk = (states: Record<string, StateDef>): void => {
    for (const state of Object.values(states)) {
      const transitions = [
        ...Object.values(state.on).flat(),
        ...state.after.map((a) => a.transition),
        ...(state.onDone ? [state.onDone] : []),
        ...state.onChildren.map((oc) => oc.transition),
      ];
      for (const t of transitions) {
        for (const [field, expr] of Object.entries(t.assign)) {
          // An assignment that reads the field it writes moves the state further on every
          // delivery, so a repeat changes the outcome. Derive, or declare a key.
          if (t.idempotency === undefined && refsOf(expr).includes(field)) {
            out.push({
              severity: "warning",
              message:
                `${t.id}: \`${field}: ${expr}\` accumulates — a redelivery would apply it twice. ` +
                `Declare \`idempotency:\` or derive the value instead of adding to it.`,
            });
          }
        }
      }
      for (const oc of state.onChildren) {
        if (oc.trigger.form === "edge" && oc.transition.target !== undefined) {
          out.push({
            severity: "warning",
            message:
              `${oc.transition.id}: \`${oc.trigger.raw}\` is a moment, not a condition, so under ` +
              `reordering it may never be observed — driving a state change from it can strand the ` +
              `instance. Use a predicate quantifier for the transition and keep the edge for notifying.`,
          });
        }
      }
      walk(state.states);
    }
  };
  walk(machine.states);
  return out;
}

/** The value objects of the model being loaded — data fields and payloads may be of one. */
let knownValues = new Set<string>();
let knownValueDefs: Record<string, ValueDef> = {};

/** What every rule and template already reads by these names: an instance's own id, type and state. */
const BUILT_IN = ["id", "type", "state"];

/** An aggregate's data: a field may not take a name the kernel gives every instance — it would never be read. */
function dataFields(raw: Raw, where: string): Record<string, FieldDef> {
  const out = fields(raw, where);
  for (const name of Object.keys(out)) {
    if (BUILT_IN.includes(name)) {
      throw new ModelError(`${where}.${name}: \`${name}\` is the instance's own (${BUILT_IN.join(", ")}) — \`\${${name}}\` and a guard's \`${name}\` read that, never this field; name it for what it holds`);
    }
  }
  return out;
}

function fields(raw: Raw, where: string): Record<string, FieldDef> {
  const out: Record<string, FieldDef> = {};
  for (const [name, spec] of Object.entries(asRecord(raw, where))) {
    const rec = asRecord(spec, `${where}.${name}`);
    const raw = rec.type;
    const listOf = Array.isArray(raw) && raw.length === 1 ? String(raw[0]).trim()
      : typeof raw === "string" && /^\[.*\]$/.test(raw.trim()) ? raw.trim().slice(1, -1).trim() : undefined;
    if (listOf !== undefined) {
      // ADR 0015: a set of value objects, told apart by one of their fields.
      const def = knownValueDefs[listOf];
      if (!def) throw new ModelError(`${where}.${name}: a list field holds value objects — \`${listOf}\` is not one (${[...knownValues].join(", ") || "none declared"})`);
      const key = rec.key === undefined ? undefined : String(rec.key);
      if (!key || !def.fields[key]) {
        throw new ModelError(`${where}.${name}: a list of ${listOf} needs \`key:\` — the field that tells its rows apart (one of ${Object.keys(def.fields).join(", ")}), so a repeat replaces a row instead of adding one`);
      }
      out[name] = { type: "list", value: listOf, key, default: [] };
      continue;
    }
    const type = String(raw ?? "number");
    if (knownValues.has(type)) {
      // ADR 0012 §8: one value object; absent until assigned.
      out[name] = { type: "value", value: type, default: rec.default ?? null };
      continue;
    }
    if (!["number", "string", "boolean"].includes(type)) {
      throw new ModelError(`${where}.${name}: type must be number, string, boolean or a value object (${[...knownValues].join(", ") || "none declared"})`);
    }
    const fallback: Json = type === "number" ? 0 : type === "string" ? "" : false;
    out[name] = { type: type as FieldDef["type"], default: rec.default ?? fallback };
  }
  return out;
}

function relations(raw: Raw, where: string, owner: string): Record<string, ChildRelDef> {
  const out: Record<string, ChildRelDef> = {};
  for (const [name, spec] of Object.entries(asRecord(raw, where))) {
    const rec = asRecord(spec, `${where}.${name}`);
    if (!rec.type) throw new ModelError(`${where}.${name}: a relation needs a child \`type\``);
    if (!rec.via) {
      throw new ModelError(
        `${where}.${name}: a relation needs \`via\` — an expression over the child's creating ` +
          `command that yields the parent's id, e.g. \`via: command.orderId\``,
      );
    }
    const rel: ChildRelDef = { type: String(rec.type), via: String(rec.via), declaredOn: String(rec[INHERITED] ?? owner) };
    if (rec.classify !== undefined) {
      const c = asRecord(rec.classify, `${where}.${name}.classify`);
      const values = Array.isArray(c.values) ? c.values.map(String) : [];
      if (!c.by || values.length === 0) {
        throw new ModelError(`${where}.${name}.classify: needs \`by\` (a data field of the children) and \`values\` (the classes)`);
      }
      rel.classify = { by: String(c.by), values };
    }
    out[name] = rel;
  }
  return out;
}

function references(raw: Raw, where: string): Record<string, RefDef> {
  const out: Record<string, RefDef> = {};
  for (const [name, spec] of Object.entries(asRecord(raw, where))) {
    const rec = asRecord(spec, `${where}.${name}`);
    if (!rec.type) throw new ModelError(`${where}.${name}: a reference needs the \`type\` it points at`);
    if (!rec.via) {
      throw new ModelError(
        `${where}.${name}: a reference needs \`via\` — an expression over the creating command ` +
          `that yields the id it points at, e.g. \`via: command.unit\``,
      );
    }
    out[name] = { type: String(rec.type), via: String(rec.via) };
  }
  return out;
}

function machine(name: string, raw: Raw, kind: MachineDef["kind"]): MachineDef {
  const states: Record<string, StateDef> = {};
  for (const [stateName, body] of Object.entries(asRecord(raw.states, `${name}.states`))) {
    states[stateName] = stateDef(stateName, body, [], name);
  }
  if (Object.keys(states).length === 0) throw new ModelError(`${name}: no states`);
  const initial = String(raw.initial ?? "");
  if (!states[initial]) throw new ModelError(`${name}: \`initial\` must name a top-level state`);

  const role = raw.kind === undefined ? "aggregate" : String(raw.kind);
  if (!["aggregate", "entity"].includes(role)) {
    throw new ModelError(`${name}: \`kind\` is aggregate or entity (a value object is declared under \`values:\`) — not \`${role}\``);
  }
  if (kind === "policy" && raw.kind !== undefined) throw new ModelError(`${name}: a policy has no \`kind\` — it is neither aggregate nor entity`);
  const def: MachineDef = {
    name,
    kind,
    role: role as MachineDef["role"],
    abstract: raw.abstract === true,
    ancestors: (raw[ANCESTORS] as string[] | undefined) ?? [],
    initial,
    states,
    data: dataFields(raw.data, `${name}.data`),
    children: relations(raw.children, `${name}.children`, name),
    references: references(raw.references, `${name}.references`),
    creators: (raw.creators ?? []).map(String),
    correlate: raw.correlate === undefined ? undefined : String(raw.correlate),
    why: whyOf(raw.why, name),
    ...(kind === "policy" && raw.in !== undefined ? { runsIn: String(raw.in) } : {}),
    allChildTriggers: [],
  };
  if (kind === "aggregate" && raw.in !== undefined) throw new ModelError(`${name}: \`in:\` says where a policy runs (ADR 0035); a type is placed by its package`);
  def.allChildTriggers = collectTriggers(states, []);
  checkTimerFields(def);
  checkPuts(def);
  if (kind === "policy" && Object.keys(def.references).length > 0) {
    throw new ModelError(`${name}: a policy is identified by its correlation, it does not hold references (ADR 0007)`);
  }
  for (const ref of Object.keys(def.references)) {
    if (ref in def.data || ref in def.children) {
      throw new ModelError(`${name}: \`${ref}\` is declared both as a reference and as data or children`);
    }
  }
  if (def.kind === "aggregate" && !def.abstract && def.creators.length === 0) {
    throw new ModelError(
      `${name}: declare \`creators\` — the commands that may bring an instance into ` +
        `existence. Anything else addressed to a missing instance is reported, not created.`,
    );
  }
  return def;
}

/** ADR 0015: `put:` goes into a list field, with a row that is exactly its value object. */
function checkPuts(def: MachineDef): void {
  for (const t of allTransitions(def.states)) {
    for (const [field, row] of Object.entries(t.put)) {
      const f = def.data[field];
      if (f?.type !== "list") throw new ModelError(`${t.id}: \`put: ${field}\` — put goes into a list field (\`type: [Value], key: …\`), and ${field} is ${f ? `a ${f.type}` : "not a field"} of ${def.name}`);
      const value = knownValueDefs[f.value!]!;
      const missing = Object.entries(value.fields).filter(([k, sf]) => !(k in row) && !sf.optional).map(([k]) => k);
      const extra = Object.keys(row).filter((k) => !(k in value.fields));
      if (missing.length || extra.length) {
        throw new ModelError(`${t.id}: \`put: ${field}\` — a row is a ${f.value}: ${[...missing.map((k) => `${k} is missing`), ...extra.map((k) => `${k} is not a field of ${f.value}`)].join(", ")}`);
      }
    }
    for (const field of Object.keys(t.assign)) {
      if (def.data[field]?.type === "list" && refsOf(t.assign[field]!).includes(field)) {
        throw new ModelError(`${t.id}: \`${field}\` is a list — change one row with \`put:\`; \`assign:\` may only replace it whole`);
      }
    }
  }
}

/** ADR 0014: a deadline named by a field reads a declared string field of the instance. */
function checkTimerFields(def: MachineDef): void {
  const walk = (states: Record<string, StateDef>): void => {
    for (const state of Object.values(states)) {
      for (const t of state.after) {
        if (t.field === undefined) continue;
        const f = def.data[t.field];
        if (!f) throw new ModelError(`${def.name}.${state.path.join(".")}: \`after: ${t.field}\` is neither a duration (90s, 15m, 6h, 14d) nor a data field of ${def.name}`);
        if (f.type !== "string") throw new ModelError(`${def.name}.${state.path.join(".")}: \`after: ${t.field}\` names a ${f.type} field — a deadline field holds a duration such as 7d, so it is a string`);
      }
      walk(state.states);
    }
  };
  walk(def.states);
}

/** `on: OrderPaid` + `command:` is sugar for a single-state policy — ADR 0003. */
function policy(name: string, raw: Raw): MachineDef {
  if (raw.extends !== undefined || raw.abstract !== undefined) {
    throw new ModelError(`${name}: inheritance is for aggregates; a policy cannot be abstract or extend another (ADR 0008)`);
  }
  if (raw.states) return machine(name, raw, "policy");
  if (!raw.on || !raw.command) {
    throw new ModelError(`${name}: a policy needs either \`states\`, or \`on\` plus \`command\``);
  }
  const events = Array.isArray(raw.on) ? raw.on.map(String) : [String(raw.on)];
  const on: Raw = {};
  for (const e of events) {
    on[e] = { command: raw.command, with: raw.with, for_each: raw.for_each, order: raw.order, where: raw.where, pairs: raw.pairs, for_each_referrer: raw.for_each_referrer };
  }
  return machine(name, { initial: "ready", states: { ready: { on } }, correlate: raw.correlate, why: raw.why, in: raw.in }, "policy");
}

/** ADR 0003: policies issue commands and never raise events. Caught at load, not at run. */
function assertNoEvents(name: string, states: Record<string, StateDef>): void {
  for (const state of Object.values(states)) {
    const all = [
      ...Object.values(state.on).flat(),
      ...state.onChildren.map((oc) => oc.transition),
      ...state.after.map((a) => a.transition),
      ...(state.onDone ? [state.onDone] : []),
    ];
    for (const t of all) {
      if (t.emit.length > 0) {
        throw new ModelError(
          `${t.id}: a policy issues commands, it does not raise events — an event is a fact ` +
            `raised by an aggregate (ADR 0003). Use \`command:\` instead of \`emit:\`.`,
        );
      }
    }
    if (state.emitOnEntry.length > 0 || state.emitOnExit.length > 0) {
      throw new ModelError(`${name}.${state.path.join(".")}: a policy cannot emit events (ADR 0003)`);
    }
    assertNoEvents(name, state.states);
  }
}

/** A fan-out to referrers must name a real reference, or it would reach nobody, quietly. */
function checkReferrers(model: Model, policy: MachineDef): void {
  const walk = (states: Record<string, StateDef>): void => {
    for (const s of Object.values(states)) {
      for (const t of Object.values(s.on).flat()) {
        const fr = t.forEachReferrer;
        if (!fr) continue;
        if (t.forEach) throw new ModelError(`${t.id}: use \`for_each\` or \`for_each_referrer\`, not both`);
        const target = model.aggregates[fr.type];
        if (!target) throw new ModelError(`${t.id}: \`for_each_referrer\` names \`${fr.type}\`, which is not an aggregate`);
        if (!target.references[fr.ref]) {
          throw new ModelError(`${t.id}: \`${fr.type}\` has no reference called \`${fr.ref}\``);
        }
        if (!t.command) throw new ModelError(`${t.id}: \`for_each_referrer\` needs a \`command\` to send each referrer`);
      }
      walk(s.states);
    }
  };
  walk(policy.states);
}

/** `type` is `ancestor`, or extends it at any distance (ADR 0008). */
export function isA(model: Model, type: string, ancestor: string): boolean {
  return type === ancestor || (model.aggregates[type]?.ancestors.includes(ancestor) ?? false);
}

function checkRelations(model: Model): void {
  const concrete = Object.values(model.aggregates).filter((a) => !a.abstract);
  for (const a of Object.values(model.aggregates)) {
    for (const [rel, def] of Object.entries(a.children)) {
      const child = model.aggregates[def.type];
      if (!child) throw new ModelError(`${a.name}.children.${rel}: there is no aggregate called \`${def.type}\``);
      if (def.classify) {
        if (!(def.classify.by in child.data)) {
          throw new ModelError(`${a.name}.children.${rel}: classified by \`${def.classify.by}\`, which is not a data field of ${def.type}`);
        }
        if (["count", "finals", "in"].includes(def.classify.by)) {
          throw new ModelError(`${a.name}.children.${rel}: \`${def.classify.by}\` would clash with the tally's own names (count, finals, in)`);
        }
      }
      // A quantifier naming a state the children cannot be in would never fire, quietly. On
      // an abstract child type only the inherited skeleton counts (ADR 0009 §2).
      for (const { trigger } of a.allChildTriggers) {
        if (trigger.rel !== rel || !trigger.state) continue;
        let level = child.states;
        for (const seg of trigger.state.split(".")) {
          const found = level[seg];
          if (!found) {
            throw new ModelError(
              `${a.name}: \`${trigger.raw}\` — \`${trigger.state}\` is not a state of ${def.type}` +
                (child.abstract ? " (an abstract type: name one of its own states, which every subclass has)" : ""),
            );
          }
          level = found.states;
        }
      }
    }
  }
  // A child type may have several possible parent relations — a route belongs to a request
  // or, being a step itself, to another route — and its creating command picks one
  // by the field it carries (ADR 0009 §4). Two relations reading the *same* field could never
  // be told apart, so that is refused here. Copies of one relation inherited from an abstract
  // type are one declaration, not several.
  for (const child of concrete) {
    const byVia = new Map<string, Set<string>>();
    for (const p of concrete) {
      for (const [rel, def] of Object.entries(p.children)) {
        if (!isA(model, child.name, def.type)) continue;
        const via = def.via.replace(/\s+/g, "");
        (byVia.get(via) ?? byVia.set(via, new Set()).get(via)!).add(`${def.declaredOn}.${rel}`);
      }
    }
    for (const [via, declarations] of byVia) {
      if (declarations.size > 1) {
        throw new ModelError(
          `${child.name} is declared as children by ${[...declarations].join(" and ")}, both \`via: ${via}\`; a child ` +
            `could never tell them apart — give each its own field, or declare the relation once on a common abstract parent`,
        );
      }
    }
  }
}

/** The literal type a command template names, when it names one: `SiteTask#${id}.Plan` → SiteTask. */
function literalType(target: string): string | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)#/.exec(target);
  return m ? m[1] : undefined;
}

/** Every transition of a machine, wherever it is declared. */
function allTransitions(states: Record<string, StateDef>): TransitionDef[] {
  const out: TransitionDef[] = [];
  const walk = (level: Record<string, StateDef>) => {
    for (const st of Object.values(level)) {
      out.push(...Object.values(st.on).flat(), ...st.onChildren.map((o) => o.transition), ...st.after.map((a) => a.transition), ...(st.onDone ? [st.onDone] : []));
      walk(st.states);
    }
  };
  walk(states);
  return out;
}

/** The types that can own `type`: every type declaring a relation whose children it may be. */
export function ownersOf(model: Model, type: string): string[] {
  return Object.values(model.aggregates)
    .filter((p) => Object.values(p.children).some((c) => isA(model, type, c.type)))
    .map((p) => p.name);
}

/** The aggregate types an instance of `type` can belong to: itself, or its owners' (ADR 0012 §3). */
export function aggregatesOf(model: Model, type: string, seen = new Set<string>()): Set<string> {
  const m = model.aggregates[type];
  if (!m || m.role === "aggregate") return new Set([type]);
  if (seen.has(type)) return new Set();
  seen.add(type);
  const out = new Set<string>();
  for (const o of ownersOf(model, type)) for (const a of aggregatesOf(model, o, seen)) out.add(a);
  return out;
}

/** ADR 0012: entities are owned, reached only through their aggregate, and not pointed into. */
function checkKinds(model: Model): void {
  // Ownership first: every other rule here assumes each entity has an aggregate.
  for (const m of Object.values(model.aggregates)) {
    if (m.role === "entity" && ownersOf(model, m.name).length === 0) {
      throw new ModelError(`${m.name} is an entity, and no relation owns it — an entity lives inside an aggregate (ADR 0012 §3)`);
    }
  }
  for (const m of Object.values(model.aggregates)) {
    for (const [rel, c] of Object.entries(m.children)) {
      const child = model.aggregates[c.type];
      if (child && child.role === "aggregate" && m.role === "entity") {
        throw new ModelError(`${m.name}.children.${rel}: an entity cannot own an aggregate (${c.type}) — the boundary is the aggregate's`);
      }
    }
    for (const t of allTransitions(m.states)) {
      for (const sd of t.send) {
        if (sd.children !== undefined && !m.children[sd.children]) {
          throw new ModelError(`${t.id}: send to \`children: ${sd.children}\` — ${m.name} has no relation called that`);
        }
        const target = sd.to ? literalType(sd.to) : undefined;
        if (target && !model.aggregates[target]) throw new ModelError(`${t.id}: send to \`${target}\`, which is not a type`);
        if (target && model.aggregates[target]!.role !== "entity") {
          throw new ModelError(`${t.id}: \`send\` reaches the sender's own entities; ${target} is an aggregate — raise an event and let a policy command it`);
        }
      }
    }
    // A reference into another aggregate's entity: legal, but the boundary says point at the root.
    for (const [name, r] of Object.entries(m.references)) {
      const target = model.aggregates[r.type];
      if (!target || target.role !== "entity") continue;
      const mine = aggregatesOf(model, m.name);
      const theirs = aggregatesOf(model, r.type);
      if (![...theirs].some((a) => mine.has(a))) {
        model.findings.push({ severity: "warning", message: `${m.name}.references.${name} points at ${r.type}, an entity of ${[...theirs].join(" / ")} — point at the aggregate instead (ADR 0012 §7)` });
      }
    }
  }
  for (const p of Object.values(model.policies)) {
    for (const t of allTransitions(p.states)) {
      if (!t.command || t.forEachReferrer) continue;
      const target = literalType(t.command.target);
      if (target && model.aggregates[target]?.role === "entity") {
        throw new ModelError(
          `${t.id}: commands ${target}, an entity — commands go to its aggregate (${[...aggregatesOf(model, target)].join(" / ")}), which sends them on (ADR 0012 §4)`,
        );
      }
    }
  }
}

/**
 * ADR 0013: `packages:` — `Name: [types]`, or `Name: { note, types, why }`. Every name must be a type
 * of the model, and a type is declared in one package at most.
 */
function packagesOf(raw: unknown, model: Model): PackageDef[] {
  if (raw === undefined || raw === null) return [];
  const out: PackageDef[] = [];
  const home = new Map<string, string>();
  for (const [name, body] of Object.entries(asRecord(raw, "packages"))) {
    const rec = Array.isArray(body) ? { types: body } : asRecord(body, `packages.${name}`);
    for (const k of Object.keys(rec)) if (!["note", "types", "why"].includes(k)) throw new ModelError(`packages.${name}: unknown key \`${k}\` (expected note, types, why)`);
    const types = (Array.isArray(rec.types) ? rec.types : []).map(String);
    if (types.length === 0) throw new ModelError(`packages.${name}: a package lists its \`types\``);
    for (const t of types) {
      if (!model.aggregates[t] && !model.values[t]) throw new ModelError(`packages.${name}: there is no type called \`${t}\``);
      if (home.has(t)) throw new ModelError(`packages.${name}: \`${t}\` is already in package ${home.get(t)}`);
      home.set(t, name);
    }
    const why = whyOf(rec.why, `packages.${name}`);
    out.push({ name, ...(rec.note !== undefined ? { note: String(rec.note) } : {}), types, ...(why ? { why } : {}) });
  }
  return out;
}

/**
 * A model from its text — and, when it includes parts (ADR 0019), from them too: `files` holds them by
 * path, relative to the model's folder (`modelFiles` collects them). An error names the file the name
 * in it was declared in.
 */
export function loadModel(text: string, files: Record<string, string> = {}): Model {
  const { raw, sources } = mergeModel(text, files);
  try {
    const model = modelOf(raw);
    if (Object.keys(sources).length) model.sources = sources;
    return model;
  } catch (err) {
    if (err instanceof ModelError) throw located(err, sources);
    throw err;
  }
}

function modelOf(raw: Record<string, unknown>): Model {
  // A misspelt section would otherwise be ignored without a word.
  for (const key of Object.keys(raw)) {
    if (!["context", "values", "packages", "aggregates", "policies", "overview", "sequence", "coverage", "systems", "contexts", "domains", "relations", "roles"].includes(key)) {
      throw new ModelError(`unknown top-level section \`${key}\` (expected context, values, packages, aggregates, policies, overview, sequence, coverage, systems, contexts, domains, relations, roles)`);
    }
  }
  const model: Model = { context: String(raw.context ?? "unnamed"), values: {}, packages: [], aggregates: {}, policies: {}, findings: [] };
  // Value objects first: fields and payloads below may be of one.
  const valueRaw = asRecord(raw.values, "values");
  knownValues = new Set(Object.keys(valueRaw));
  for (const [name, body] of Object.entries(valueRaw)) {
    if (raw.aggregates && name in (raw.aggregates as Raw)) throw new ModelError(`values.${name}: also declared as an aggregate`);
    const v: ValueDef = { name, fields: shapeFields(body, `values.${name}`, false) };
    if (Object.keys(v.fields).length === 0) throw new ModelError(`values.${name}: a value object has fields`);
    model.values[name] = v;
  }
  knownValueDefs = model.values;
  for (const [name, body] of Object.entries(resolveInheritance(asRecord(raw.aggregates, "aggregates")))) {
    model.aggregates[name] = machine(name, asRecord(body, name), "aggregate");
  }
  for (const [name, body] of Object.entries(asRecord(raw.policies, "policies"))) {
    model.policies[name] = policy(name, asRecord(body, name));
  }
  if (Object.keys(model.aggregates).length === 0) throw new ModelError("a model needs at least one aggregate");
  if (raw.overview !== undefined) model.overview = raw.overview as Json;
  if (raw.coverage !== undefined) model.coverage = raw.coverage as Json;     // read by the model check (MC-3)
  for (const p of Object.values(model.policies)) assertNoEvents(p.name, p.states);
  for (const p of Object.values(model.policies)) checkReferrers(model, p);
  checkRelations(model);
  checkKinds(model);
  model.packages = packagesOf(raw.packages, model);
  try {
    const systems = systemsOf(raw.systems, raw.contexts, raw.relations, model, raw.domains, raw.roles);
    if (!systems) {
      const placed = Object.values(model.policies).find((p) => p.runsIn !== undefined);
      if (placed) throw new ModelError(`${placed.name}: \`in: ${placed.runsIn}\` — the model declares no \`systems:\` to run it in (ADR 0035)`);
    }
    if (systems) {
      model.systems = systems;
      model.findings.push(...systemFindings(model));
    }
    const labels = sequenceLabelsOf(raw.sequence, model);
    if (labels) model.sequenceLabels = labels;
  } catch (err) {
    if (err instanceof SystemsError) throw new ModelError(err.message);
    throw err;
  }
  for (const m of [...Object.values(model.aggregates), ...Object.values(model.policies)]) {
    model.findings.push(...lint(m));
  }
  return model;
}
