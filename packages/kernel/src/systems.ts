/**
 * ADR 0018: the systems, bounded contexts and sub-systems a model's types live in, and what is
 * derived from them — the context map (from the model); a run as a sequence diagram is `sequence.ts`
 * (ADR 0022). One derivation, read by the workbench, the command line and the check alike.
 */
import {
  RELATION_PATTERNS,
  type ContextDef, type MachineDef, type Model, type ModelFinding, type RelationDef, type StateDef,
  type DomainDef, type Json, type RoleDef, type SubsystemDef, type SystemDef, type SystemSendDef, type SystemsDef, type TransitionDef,
} from "./types.ts";

class SystemsError extends Error {}
/** ADR 0035: `in: target` — each part a policy commands runs it for its own types; `in: source` — each part that raises its event. */
const TARGET = "target";
const SOURCE = "source";
type Raw = Record<string, unknown>;

function record(v: unknown, where: string): Raw {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new SystemsError(`${where}: expected a mapping`);
  return v as Raw;
}
function list(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SystemsError(`${where}: expected a list`);
  return v.map(String);
}
function only(rec: Raw, keys: string[], where: string): void {
  for (const k of Object.keys(rec)) if (!keys.includes(k)) throw new SystemsError(`${where}: unknown key \`${k}\` (expected ${keys.join(", ")})`);
}
function why(v: unknown): string[] | undefined {
  return v === undefined ? undefined : list(v, "why");
}

// ------------------------------------------------------------------ what the model has

function walkStates(states: Record<string, StateDef>, visit: (s: StateDef) => void): void {
  for (const s of Object.values(states)) { visit(s); walkStates(s.states, visit); }
}

export function transitionsOf(m: MachineDef): TransitionDef[] {
  const out: TransitionDef[] = [];
  walkStates(m.states, (s) => {
    out.push(...Object.values(s.on).flat(), ...s.onChildren.map((o) => o.transition), ...s.after.map((a) => a.transition));
    if (s.onDone) out.push(s.onDone);
  });
  return out;
}

/** The events a type raises, wherever it raises them. */
export function eventsRaisedBy(m: MachineDef): Set<string> {
  const out = new Set<string>();
  for (const t of transitionsOf(m)) for (const e of t.emit) out.add(e.event);
  walkStates(m.states, (s) => { for (const e of [...s.emitOnEntry, ...s.emitOnExit]) out.add(e.event); });
  return out;
}

/** The fields an event is raised with, anywhere in the model — what a receiver may be narrowed by. */
function fieldsOfEvent(model: Model, event: string): Set<string> {
  const out = new Set<string>();
  for (const m of Object.values(model.aggregates)) {
    for (const t of transitionsOf(m)) for (const e of t.emit) if (e.event === event) for (const f of Object.keys(e.payload)) out.add(f);
    walkStates(m.states, (st) => { for (const e of [...st.emitOnEntry, ...st.emitOnExit]) if (e.event === event) for (const f of Object.keys(e.payload)) out.add(f); });
  }
  return out;
}

/**
 * `Event`, or `{ Event: { field: [values] } }` — what one external part receives, narrowed by the
 * event's payload where several parts share it (ADR 0031).
 */
function receivesOf(raw: unknown, where: string, model: Model, raised: Set<string>): { events: string[]; narrowed: Record<string, Record<string, string[]>> } {
  const events: string[] = [];
  const narrowed: Record<string, Record<string, string[]>> = {};
  if (raw === undefined || raw === null) return { events, narrowed };
  if (!Array.isArray(raw)) throw new SystemsError(`${where}: expected a list`);
  for (const item of raw) {
    let name: string;
    let by: Raw | undefined;
    if (typeof item === "string") name = item;
    else {
      const rec = record(item, where);
      const keys = Object.keys(rec);
      if (keys.length !== 1) throw new SystemsError(`${where}: write \`Event\`, or \`{ Event: { field: [values] } }\``);
      name = keys[0]!;
      by = record(rec[name], `${where}: ${name}`);
    }
    if (!raised.has(name)) throw new SystemsError(`${where}: no type of the model raises \`${name}\``);
    if (events.includes(name)) throw new SystemsError(`${where}: \`${name}\` is listed twice`);
    events.push(name);
    if (!by) continue;
    const fields = fieldsOfEvent(model, name);
    const whereBy: Record<string, string[]> = {};
    for (const [field, values] of Object.entries(by)) {
      if (!fields.has(field)) throw new SystemsError(`${where}: ${name} is raised with no field \`${field}\` (it has ${[...fields].join(", ") || "none"})`);
      const vs = Array.isArray(values) ? values.map(String) : [String(values)];
      if (vs.length === 0) throw new SystemsError(`${where}: ${name}.${field} — name the values it is received with`);
      whereBy[field] = vs;
    }
    if (Object.keys(whereBy).length === 0) throw new SystemsError(`${where}: ${name} — narrow it by a field, or write it plain`);
    narrowed[name] = whereBy;
  }
  return { events, narrowed };
}

/** The commands a type answers: its creators and every command any of its states handles. */
export function commandsAnsweredBy(m: MachineDef): Set<string> {
  const out = new Set(m.creators);
  walkStates(m.states, (s) => { for (const k of Object.keys(s.on)) out.add(k.split("#")[0]!); });
  return out;
}

// ------------------------------------------------------------------ the declaration

const NAME = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;

/** The fields a type's command takes, or undefined when no transition of it says (ADR 0015). */
function fieldsTaken(model: Model, m: MachineDef, command: string): Set<string> | undefined {
  let out: Set<string> | undefined;
  walkStates(m.states, (s) => {
    for (const [key, ts] of Object.entries(s.on)) {
      if (key.split("#")[0] !== command) continue;
      for (const t of ts) {
        if (!t.takes) continue;
        out ??= new Set();
        const fields = "fields" in t.takes ? t.takes.fields : model.values[t.takes.value]?.fields ?? {};
        for (const f of Object.keys(fields)) out.add(f);
      }
    }
  });
  return out;
}

/** `Type.Command`, or `{ Type.Command: { field: [values] } }` — what one external part sends (ADR 0020 §4). */
function sendsOf(raw: unknown, where: string, subsystem: string, model: Model): SystemSendDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SystemsError(`${where}: expected a list`);
  return raw.map((item) => {
    let name: string;
    let narrowed: Raw | undefined;
    if (typeof item === "string") name = item;
    else {
      const rec = record(item, where);
      const keys = Object.keys(rec);
      if (keys.length !== 1) throw new SystemsError(`${where}: write \`Type.Command\`, or \`{ Type.Command: { field: [values] } }\``);
      name = keys[0]!;
      narrowed = record(rec[name], `${where}: ${name}`);
    }
    const m = NAME.exec(name);
    if (!m) throw new SystemsError(`${where}: \`${name}\` — write it Type.Command`);
    const type = model.aggregates[m[1]!];
    if (!type) throw new SystemsError(`${where}: there is no type called \`${m[1]}\``);
    if (type.role !== "aggregate") throw new SystemsError(`${where}: ${m[1]} is an entity — commands from outside go to its aggregate (ADR 0012 §4)`);
    if (!commandsAnsweredBy(type).has(m[2]!)) throw new SystemsError(`${where}: ${m[1]} answers no command \`${m[2]}\``);
    const send: SystemSendDef = { type: m[1]!, command: m[2]!, subsystem };
    if (narrowed) {
      const taken = fieldsTaken(model, type, m[2]!);
      const whereBy: Record<string, string[]> = {};
      for (const [field, values] of Object.entries(narrowed)) {
        if (taken && !taken.has(field)) throw new SystemsError(`${where}: ${name} takes no field \`${field}\` (it takes ${[...taken].join(", ")})`);
        const vs = Array.isArray(values) ? values.map(String) : [String(values)];
        if (vs.length === 0) throw new SystemsError(`${where}: ${name}.${field} — name the values it is sent with`);
        whereBy[field] = vs;
      }
      if (Object.keys(whereBy).length === 0) throw new SystemsError(`${where}: ${name} — narrow it by a field, or write it plain`);
      send.where = whereBy;
    }
    return send;
  });
}

/**
 * `systems:`, `contexts:`, `domains:` and `relations:` (ADR 0018 §1–3, ADR 0020). Names are checked
 * here; what needs the whole model — a type in no system, a relation nothing connects — is said by
 * `systemFindings`.
 */
export function systemsOf(rawSystems: unknown, rawContexts: unknown, rawRelations: unknown, model: Model, rawDomains?: unknown, rawRoles?: unknown): SystemsDef | undefined {
  if (rawSystems === undefined || rawSystems === null) {
    if (rawContexts !== undefined || rawRelations !== undefined || rawDomains !== undefined) throw new SystemsError("contexts:, domains: and relations: need `systems:` — the sub-systems they group");
    if (rawRoles !== undefined) throw new SystemsError("roles: need `systems:` — the parts that play them (ADR 0027)");
    return undefined;
  }
  const systems: SystemDef[] = [];
  const subsystems: SubsystemDef[] = [];
  const packageNames = new Set(model.packages.map((p) => p.name));
  const packageHome = new Map<string, string>();
  const names = new Set<string>();
  const raised = new Set(Object.values(model.aggregates).flatMap((m) => [...eventsRaisedBy(m)]));
  const roles = rolesOf(rawRoles, model, raised);
  const plays = (v: unknown, where: string): RoleDef[] => list(v, where).map((r) => {
    const role = roles.find((x) => x.name === r);
    if (!role) throw new SystemsError(`${where}: there is no role called \`${r}\` (ADR 0027)`);
    return role;
  });

  for (const [name, body] of Object.entries(record(rawSystems, "systems"))) {
    const where = `systems.${name}`;
    const rec = record(body, where);
    only(rec, ["note", "external", "domain", "sends", "receives", "plays", "computes", "context", "subsystems", "packages", "why"], where);
    const external = rec.external === true;
    if (names.has(name)) throw new SystemsError(`${where}: the name is used twice`);
    names.add(name);
    if (external && rec.context !== undefined) throw new SystemsError(`${where}: an external system is a context of its own — it has no \`context\``);
    if (!external) for (const k of ["sends", "receives", "plays"]) if (rec[k] !== undefined) throw new SystemsError(`${where}: \`${k}\` is for an external system`);
    if (external && rec.computes !== undefined) throw new SystemsError(`${where}: \`computes\` is for a system of its own — an external system \`sends\` (ADR 0030)`);
    if (rec.subsystems !== undefined && rec.computes !== undefined) throw new SystemsError(`${where}: \`computes\` — a system with sub-systems says it on each (ADR 0030)`);
    if (rec.subsystems !== undefined && rec.packages !== undefined) throw new SystemsError(`${where}: list \`subsystems\`, or \`packages\` for a system of one sub-system — not both`);
    if (external && rec.subsystems !== undefined) for (const k of ["sends", "receives", "plays"]) if (rec[k] !== undefined) throw new SystemsError(`${where}: \`${k}\` — an external system with sub-systems says it on each`);
    const context = external ? name : rec.context !== undefined ? String(rec.context) : name;
    const split = rec.subsystems !== undefined;
    const parts: [string, Raw][] = split
      ? Object.entries(record(rec.subsystems, `${where}.subsystems`)).map(([n, b]) => [n, Array.isArray(b) ? { packages: b } : record(b, `${where}.subsystems.${n}`)])
      : [[name, { packages: rec.packages, sends: rec.sends, receives: rec.receives, plays: rec.plays, computes: rec.computes }]];
    if (parts.length === 0) throw new SystemsError(`${where}: list its \`subsystems\`, or leave the key out`);
    const sends: SystemSendDef[] = [];
    const receives: string[] = [];
    for (const [sub, sb] of parts) {
      const sw = split ? `${where}.subsystems.${sub}` : where;
      if (split) only(sb, external ? ["note", "packages", "sends", "receives", "plays", "why"] : ["note", "context", "packages", "computes", "why"], sw);
      if (split && names.has(sub) && sub !== name) throw new SystemsError(`${sw}: the name is used twice`);
      if (sub !== name) names.add(sub);
      const packages = list(sb.packages, `${sw}.packages`);
      if (packages.length === 0 && !external) throw new SystemsError(`${sw}: a sub-system lists its \`packages\``);
      for (const p of packages) {
        if (!packageNames.has(p)) throw new SystemsError(`${sw}.packages: there is no package called \`${p}\` (ADR 0013)`);
        if (packageHome.has(p)) throw new SystemsError(`${sw}.packages: \`${p}\` is already in sub-system ${packageHome.get(p)}`);
        packageHome.set(p, sub);
      }
      const played = external ? plays(sb.plays, `${sw}.plays`) : [];
      const told = external ? receivesOf(sb.receives, `${sw}.receives`, model, raised) : { events: [], narrowed: {} };
      const subReceivesOwn = told.events;
      // A part sends and receives what the roles it plays do (ADR 0027 §2), beside its own.
      const subSends = external ? [...sendsOf(sb.sends, `${sw}.sends`, sub, model), ...played.flatMap((r) => r.sends.map((x) => ({ ...x, subsystem: sub })))] : [];
      const subReceives = [...new Set([...subReceivesOwn, ...played.flatMap((r) => r.receives)])];
      // What a part of our own works out itself, which the model does not run: a scenario sends the
      // result in its name (ADR 0030).
      const subComputes = external ? [] : sendsOf(sb.computes, `${sw}.computes`, sub, model);
      if (external && packages.length === 0 && subSends.length === 0 && subReceives.length === 0) {
        throw new SystemsError(`${sw}: an external system says what it \`sends\` into the model or \`receives\` from it, or the \`packages\` it runs for it`);
      }
      sends.push(...subSends);
      receives.push(...subReceives.filter((e) => !receives.includes(e)));
      subsystems.push({
        name: sub, system: name, context: !external && sb.context !== undefined ? String(sb.context) : context, packages,
        ...(external ? { external: true, sends: subSends, receives: subReceives } : {}),
        ...(subComputes.length ? { computes: subComputes } : {}),
        ...(Object.keys(told.narrowed).length ? { receivesWhere: told.narrowed } : {}),
        ...(played.length ? { plays: played.map((r) => r.name) } : {}),
        ...(sb.note !== undefined ? { note: String(sb.note) } : {}),
        ...(why(sb.why) ? { why: why(sb.why)! } : {}),
      });
    }
    systems.push({
      name, ...(rec.note !== undefined ? { note: String(rec.note) } : {}), external,
      ...(rec.domain !== undefined ? { domain: String(rec.domain) } : {}),
      sends, receives, ...(why(rec.why) ? { why: why(rec.why)! } : {}),
    });
  }

  // Contexts: every one a sub-system names (an external system's is its own), and the declared ones' notes.
  const used = new Set(subsystems.map((s) => s.context));
  const declared = new Map<string, ContextDef>();
  for (const [name, body] of Object.entries(record(rawContexts, "contexts"))) {
    const rec = record(body, `contexts.${name}`);
    only(rec, ["note", "team", "why"], `contexts.${name}`);
    if (!used.has(name)) throw new SystemsError(`contexts.${name}: no sub-system is in this context`);
    declared.set(name, { name, ...(rec.note !== undefined ? { note: String(rec.note) } : {}), ...(rec.team !== undefined ? { team: String(rec.team) } : {}), ...(why(rec.why) ? { why: why(rec.why)! } : {}) });
  }
  const contexts = [...used].map((n) => declared.get(n) ?? { name: n });

  // Domains (ADR 0020 §1): every one a system names, and the declared ones' notes.
  const inDomains = [...new Set(systems.flatMap((s) => (s.domain ? [s.domain] : [])))];
  const declaredDomains = new Map<string, DomainDef>();
  for (const [name, body] of Object.entries(record(rawDomains, "domains"))) {
    const rec = record(body, `domains.${name}`);
    only(rec, ["note", "why"], `domains.${name}`);
    if (!inDomains.includes(name)) throw new SystemsError(`domains.${name}: no system is in this domain`);
    declaredDomains.set(name, { name, ...(rec.note !== undefined ? { note: String(rec.note) } : {}), ...(why(rec.why) ? { why: why(rec.why)! } : {}) });
  }
  for (const d of inDomains) if (names.has(d)) throw new SystemsError(`domain ${d}: the name is also a system's or a sub-system's`);
  const domains = inDomains.map((n) => declaredDomains.get(n) ?? { name: n });

  const relations: RelationDef[] = [];
  if (rawRelations !== undefined && rawRelations !== null && !Array.isArray(rawRelations)) throw new SystemsError("relations: expected a list");
  const known = new Set([...systems.map((s) => s.name), ...contexts.map((c) => c.name), ...domains.map((d) => d.name)]);
  for (const [i, body] of ((rawRelations as unknown[] | undefined) ?? []).entries()) {
    const where = `relations[${i}]`;
    const rec = record(body, where);
    only(rec, ["upstream", "downstream", "pattern", "note", "why"], where);
    for (const k of ["upstream", "downstream"]) {
      if (!known.has(String(rec[k]))) throw new SystemsError(`${where}.${k}: \`${rec[k]}\` is no system, context or domain`);
    }
    const pattern = String(rec.pattern);
    if (!(RELATION_PATTERNS as readonly string[]).includes(pattern)) throw new SystemsError(`${where}.pattern: \`${pattern}\` (expected ${RELATION_PATTERNS.join(", ")})`);
    relations.push({ upstream: String(rec.upstream), downstream: String(rec.downstream), pattern: pattern as RelationDef["pattern"], ...(rec.note !== undefined ? { note: String(rec.note) } : {}), ...(why(rec.why) ? { why: why(rec.why)! } : {}) });
  }
  for (const r of roles) if (names.has(r.name)) throw new SystemsError(`role ${r.name}: the name is also a system's or a sub-system's`);
  // A command worked out inside a part has that part as its one sender (ADR 0030 §2).
  const outside = [...subsystems.flatMap((p) => (p.sends ?? []).map((x) => ({ x, by: `${p.system === p.name ? p.name : `${p.system}/${p.name}`}` }))), ...roles.flatMap((r) => r.sends.map((x) => ({ x, by: `role ${r.name}` })))];
  const computed = subsystems.flatMap((p) => (p.computes ?? []).map((x) => ({ x, by: p.system === p.name ? p.name : `${p.system}/${p.name}` })));
  for (const [i, a] of computed.entries()) {
    for (const b of [...outside, ...computed.slice(i + 1)]) if (overlap(a.x, b.x)) {
      throw new SystemsError(`systems: ${a.x.type}.${a.x.command} is worked out inside ${a.by} and sent by ${b.by} too, with values that can be the same — one sender (ADR 0030)`);
    }
  }
  placementsOf(model, systems, subsystems);
  return { systems, subsystems, domains, contexts, relations, roles };
}

/** The type a policy's transition commands, when the model says it: a literal `Type#id`, or a referrer's. */
function targetOf(t: TransitionDef): string | undefined {
  return t.forEachReferrer?.type ?? (t.command ? literal(t.command.target) : undefined);
}

/** ADR 0035: each policy's `in:` names a part that runs the model's packages, or `target`. */
function placementsOf(model: Model, systems: SystemDef[], subsystems: SubsystemDef[]): void {
  const placed = Object.values(model.policies).filter((p) => p.runsIn !== undefined);
  if (placed.length === 0) return;
  for (const word of [TARGET, SOURCE]) {
    if (subsystems.some((s) => s.name === word)) throw new SystemsError(`a sub-system is called \`${word}\`, and policies say where they run — \`in: ${word}\` is a word of its own (ADR 0035): rename the sub-system`);
  }
  const raised = new Set(Object.values(model.aggregates).filter((m) => !m.abstract).flatMap((m) => [...eventsRaisedBy(m)]));
  for (const p of placed) {
    const where = `${p.name}: in: ${p.runsIn}`;
    if (p.runsIn === SOURCE) {
      walkStates(p.states, (st) => {
        for (const key of Object.keys(st.on)) {
          const event = key.split("#")[0]!;
          if (!raised.has(event)) throw new SystemsError(`${where} — no type of the model raises ${event}, so no part runs it; name the part it runs in`);
        }
      });
      continue;
    }
    if (p.runsIn === TARGET) {
      for (const t of transitionsOf(p)) {
        const target = targetOf(t);
        if (t.command && (!target || !model.aggregates[target])) throw new SystemsError(`${where} — the type of \`${t.command.target}\` is worked out at run time; name the part it runs in`);
      }
      continue;
    }
    const sub = subsystems.find((s) => s.name === p.runsIn);
    if (!sub) {
      const sys = systems.find((s) => s.name === p.runsIn);
      if (sys) throw new SystemsError(`${where} — ${sys.name} is in parts: name one of ${subsystems.filter((s) => s.system === sys.name).map((s) => s.name).join(", ")}`);
      throw new SystemsError(`${where} — there is no sub-system called ${p.runsIn}`);
    }
    if (sub.packages.length === 0) throw new SystemsError(`${where} — ${sub.name} runs none of the model's packages; a policy runs where the model's types do`);
  }
}

/** Two sends of one command that some payload could match both. */
function overlap(a: SystemSendDef, b: SystemSendDef): boolean {
  if (a.type !== b.type || a.command !== b.command) return false;
  const fields = Object.keys(a.where ?? {}).filter((f) => b.where?.[f] !== undefined);
  return fields.every((f) => a.where![f]!.some((v) => b.where![f]!.includes(v)));
}

/** `roles:` (ADR 0027 §1): what each works and sends; a type worked once, a command sent by one role. */
function rolesOf(raw: unknown, model: Model, raised: Set<string>): RoleDef[] {
  const roles: RoleDef[] = [];
  const worked = new Map<string, string>();
  for (const [name, body] of Object.entries(record(raw, "roles"))) {
    const where = `roles.${name}`;
    const rec = record(body, where);
    only(rec, ["note", "works", "sends", "receives", "why"], where);
    const works = list(rec.works, `${where}.works`);
    for (const t of works) {
      if (!model.aggregates[t]) throw new SystemsError(`${where}.works: there is no type called \`${t}\``);
      if (worked.has(t)) throw new SystemsError(`${where}.works: \`${t}\` is already worked in role ${worked.get(t)} — a type is worked in one role`);
      worked.set(t, name);
    }
    const sends = sendsOf(rec.sends, `${where}.sends`, name, model);
    const receives = list(rec.receives, `${where}.receives`);
    for (const e of receives) if (!raised.has(e)) throw new SystemsError(`${where}.receives: no type of the model raises \`${e}\``);
    if (works.length === 0 && sends.length === 0) throw new SystemsError(`${where}: a role says what it \`works\` or what it \`sends\` (ADR 0027)`);
    for (const other of roles) for (const a of sends) for (const b of other.sends) if (overlap(a, b)) {
      throw new SystemsError(`${where}.sends: ${a.type}.${a.command} is sent by role ${other.name} too, with values that can be the same — an event has one owner (ADR 0027 §1)`);
    }
    roles.push({ name, ...(rec.note !== undefined ? { note: String(rec.note) } : {}), works, sends, receives, ...(why(rec.why) ? { why: why(rec.why)! } : {}) });
  }
  return roles;
}

export { SystemsError };

// ------------------------------------------------------------------ where each type lives

export interface Place { system: string; context: string; subsystem: string; domain?: string }

/** Where a sub-system is — ours, or an external system's part. */
export function placeOfSubsystem(model: Model, sub: SubsystemDef): Place {
  const domain = model.systems!.systems.find((s) => s.name === sub.system)?.domain;
  return { system: sub.system, context: sub.context, subsystem: sub.name, ...(domain ? { domain } : {}) };
}

/**
 * A type's sub-system is its package's; an entity not in a package, its aggregate's (ADR 0013 §3);
 * a subtype not in one, its nearest ancestor's. An external system's packages place their types in it
 * (ADR 0020 §2).
 */
export function placeOf(model: Model, type: string): Place | undefined {
  const sys = model.systems;
  if (!sys) return undefined;
  const pkg = packageOf(model, type);
  const sub = pkg ? sys.subsystems.find((s) => s.packages.includes(pkg)) : undefined;
  return sub ? placeOfSubsystem(model, sub) : undefined;
}

function packageOf(model: Model, type: string, seen = new Set<string>()): string | undefined {
  if (seen.has(type)) return undefined;
  seen.add(type);
  const direct = model.packages.find((p) => p.types.includes(type));
  if (direct) return direct.name;
  const m = model.aggregates[type];
  if (!m) return undefined;
  // An entity lives where its aggregate does, whatever its abstract supertype's package says.
  if (m.role === "entity") {
    for (const owner of ownersOfType(model, type)) {
      const p = packageOf(model, owner, seen);
      if (p) return p;
    }
  }
  for (const a of m.ancestors) {
    const p = model.packages.find((x) => x.types.includes(a));
    if (p) return p.name;
  }
  return undefined;
}

/** A type and its concrete subtypes — what a policy naming an abstract type reaches. */
function concreteOf(model: Model, type: string): string[] {
  return Object.values(model.aggregates).filter((m) => !m.abstract && (m.name === type || m.ancestors.includes(type))).map((m) => m.name);
}

/** The concrete types that own `type`: those that create it with `send:` first, then those whose relations hold it. */
export function ownersOfType(model: Model, type: string): string[] {
  const m = model.aggregates[type]!;
  const mine = new Set([type, ...m.ancestors]);
  const concrete = Object.values(model.aggregates).filter((o) => !o.abstract);
  const creators = concrete.filter((o) => creates(o, type)).map((o) => o.name);
  if (creators.length) return creators;
  // Nothing creates it: whoever declares a relation that holds it — an inherited, abstract relation
  // (every step's tasks) would make every subtype an owner of every task, so only as a fallback.
  return concrete.filter((o) => Object.values(o.children).some((c) => mine.has(c.type))).map((o) => o.name);
}

function creates(owner: MachineDef, type: string): boolean {
  return transitionsOf(owner).some((t) => t.send.some((s) => s.to !== undefined && literal(s.to) === type));
}

function literal(target: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)#/.exec(target)?.[1];
}

// ------------------------------------------------------------------ findings (ADR 0018 §7)

export function systemFindings(model: Model): ModelFinding[] {
  const sys = model.systems;
  if (!sys) return [];
  const out: ModelFinding[] = [];
  const outside = Object.values(model.aggregates).filter((m) => !m.abstract && !placeOf(model, m.name)).map((m) => m.name);
  if (outside.length) out.push({ severity: "warning", message: `in no system: ${outside.join(", ")} — put their package in a sub-system (ADR 0018 §1)` });
  for (const m of Object.values(model.aggregates)) {
    if (m.role !== "entity" || m.abstract) continue;
    const mine = placeOf(model, m.name);
    for (const owner of ownersOfType(model, m.name)) {
      const theirs = placeOf(model, owner);
      if (mine && theirs && model.aggregates[owner]!.role === "aggregate" && mine.subsystem !== theirs.subsystem) {
        out.push({ severity: "warning", message: `${m.name} is an entity of ${owner}, but in sub-system ${mine.subsystem}, not ${theirs.subsystem} — an aggregate's boundary is in one sub-system (ADR 0018 §7)` });
      }
    }
  }
  for (const r of sys.roles) {
    if (!sys.subsystems.some((p) => p.plays?.includes(r.name))) out.push({ severity: "warning", message: `role ${r.name}: no part plays it — say \`plays: [${r.name}]\` on the sub-system that does (ADR 0027 §2)` });
  }
  // ADR 0035: once one policy says where it runs, the model is placing them all.
  const policies = Object.values(model.policies);
  const unplaced = policies.filter((p) => p.runsIn === undefined).map((p) => p.name);
  if (unplaced.length > 0 && unplaced.length < policies.length) {
    out.push({ severity: "warning", message: `not placed: ${unplaced.slice(0, 12).join(", ")}${unplaced.length > 12 ? ` and ${unplaced.length - 12} more` : ""} — say \`in:\` (ADR 0035)` });
  }
  // Two parts that depend on each other, then two systems — where their parts did not already say it.
  const bySystem = new Set<string>();
  const systemOf = (sub: string) => sys.subsystems.find((x) => x.name === sub)?.system ?? sub;
  for (const [level, deps] of [["subsystem", dependencies(model, (p) => p.subsystem)], ["system", dependencies(model, (p) => p.system)]] as const) {
    for (const [a, ups] of deps) for (const [b, via] of ups) {
      const back = deps.get(b)?.get(a);
      if (!back || a > b) continue;
      const pair = level === "subsystem" ? [systemOf(a), systemOf(b)].sort().join("\u0000") : [a, b].sort().join("\u0000");
      if (level === "system" && bySystem.has(pair)) continue;
      bySystem.add(pair);
      out.push({ severity: "warning", message: `${a} and ${b} depend on each other — ${a} through ${via}, ${b} through ${back}: let one only hear the other (ADR 0035)` });
    }
  }
  // A declared relation the placed policies turn round.
  const atLevels = [dependencies(model, (p) => p.system), dependencies(model, (p) => p.context), dependencies(model, (p) => p.domain ?? p.system)];
  for (const r of sys.relations) {
    const wrong = atLevels.map((d) => d.get(r.upstream)?.get(r.downstream)).find((x) => x !== undefined);
    const right = atLevels.some((d) => d.get(r.downstream)?.has(r.upstream));
    if (wrong && !right) out.push({ severity: "warning", message: `relations: ${r.upstream} → ${r.downstream} (${r.pattern}) — the policies make ${r.upstream} depend on ${r.downstream} (${wrong}), not the other way (ADR 0035)` });
  }
  // An external system is a system and a context of its own: a relation holds at any level.
  const edges = [...contextMap(model, "system").edges, ...contextMap(model, "context").edges, ...(sys.domains.length ? contextMap(model, "domain").edges : [])];
  for (const r of sys.relations) {
    if (!edges.some((e) => (e.from === r.upstream && e.to === r.downstream) || (e.from === r.downstream && e.to === r.upstream))) {
      out.push({ severity: "warning", message: `relations: ${r.upstream} → ${r.downstream} (${r.pattern}) — the model sends nothing between them` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the context map (ADR 0018 §4)

export type Level = "domain" | "system" | "context" | "subsystem";

export interface MapNode {
  id: string;
  kind: "domain" | "system" | "context" | "subsystem" | "external";
  note?: string;
  team?: string;
  system?: string;
  spans?: string[];
  /** A domain's systems (ADR 0020 §1). */
  holds?: string[];
  /** The packages of abstract types a system owns — the shared definitions (ADR 0020 §5). */
  library?: string[];
}
export interface MapEdge {
  from: string; to: string; events: string[]; commands: string[]; patterns: string[];
  /** ADR 0035: the policies that carry it. */
  policies: string[];
  /** ADR 0035: the end that depends on the other — derived from where its policies run, or a declared relation's. Empty: not known. Both ends: each depends on the other here. */
  downstream: string[];
  /** ADR 0035: the two ends depend on each other, through this edge or the one the other way. */
  mutual?: boolean;
}
export interface ContextMap { level: Level; scope?: string; nodes: MapNode[]; edges: MapEdge[] }

/** The lifeline or node a place is drawn as, at a level. Sub-system level is scoped to one system. */
function groupOf(place: Place | undefined, level: Level, scope?: string): string {
  if (!place) return "(no system)";
  if (level === "domain") return place.domain ?? place.system;
  if (level === "system") return place.system;
  if (level === "context") return place.context;
  return place.system === scope ? place.subsystem : place.system;
}

/** The packages of a system that hold only abstract types: the definitions it owns for others (ADR 0020 §5). */
function libraryOf(model: Model, system: string): string[] {
  return model.systems!.subsystems.filter((s) => s.system === system).flatMap((s) => s.packages).filter((p) => {
    const types = model.packages.find((x) => x.name === p)?.types.filter((t) => model.aggregates[t]) ?? [];
    return types.length > 0 && types.every((t) => model.aggregates[t]!.abstract);
  });
}

/** The systems that may be a sub-system level's scope: ours, and any external system in parts. */
export function scopesOf(model: Model): string[] {
  const sys = model.systems;
  if (!sys) return [];
  return sys.systems.filter((s) => !s.external || sys.subsystems.filter((x) => x.system === s.name).length > 1).map((s) => s.name);
}

function systemNode(model: Model, s: SystemDef): MapNode {
  const library = s.external ? [] : libraryOf(model, s.name);
  return { id: s.name, kind: s.external ? "external" : "system", ...(s.note ? { note: s.note } : {}), ...(library.length ? { library } : {}) };
}

function nodesAt(model: Model, level: Level, scope?: string): MapNode[] {
  const sys = model.systems!;
  const externals = sys.systems.filter((s) => s.external).map((s) => systemNode(model, s));
  if (level === "domain") {
    return [
      ...sys.domains.map((d): MapNode => ({ id: d.name, kind: "domain", ...(d.note ? { note: d.note } : {}), holds: sys.systems.filter((s) => s.domain === d.name).map((s) => s.name) })),
      ...sys.systems.filter((s) => !s.domain).map((s) => systemNode(model, s)),
    ];
  }
  if (level === "system") {
    return [...sys.systems.filter((s) => !s.external).map((s) => systemNode(model, s)), ...externals];
  }
  if (level === "context") {
    const ours = sys.contexts.filter((c) => !sys.systems.some((s) => s.external && s.name === c.name));
    return [
      ...ours.map((c): MapNode => {
        const spans = [...new Set(sys.subsystems.filter((s) => s.context === c.name).map((s) => s.system))];
        return { id: c.name, kind: "context", ...(c.note ? { note: c.note } : {}), ...(c.team ? { team: c.team } : {}), ...(spans.length > 1 ? { spans } : {}) };
      }),
      ...externals,
    ];
  }
  if (!scope || !scopesOf(model).includes(scope)) throw new SystemsError(`sub-system level needs a system as its scope — one of the model's own, or an external system in parts (${scopesOf(model).join(", ")})`);
  return [
    ...sys.subsystems.filter((s) => s.system === scope).map((s): MapNode => ({ id: s.name, kind: "subsystem", system: scope, ...(s.note ? { note: s.note } : {}) })),
    ...sys.systems.filter((s) => s.name !== scope).map((s) => systemNode(model, s)),
  ];
}

/**
 * ADR 0035: one message crossing between two places, as a policy carries it. `down` is the end that
 * depends on the other — the one the policy runs in — when the policy is placed.
 */
interface Crossing { from?: Place; to?: Place; event?: string; command?: string; policy: string; down?: "from" | "to" }

function crossingsOf(model: Model): Crossing[] {
  const raisers = new Map<string, string[]>();
  for (const m of Object.values(model.aggregates)) if (!m.abstract) for (const e of eventsRaisedBy(m)) raisers.set(e, [...(raisers.get(e) ?? []), m.name]);
  const out: Crossing[] = [];
  for (const p of Object.values(model.policies)) {
    const sub = p.runsIn && p.runsIn !== TARGET && p.runsIn !== SOURCE ? model.systems!.subsystems.find((s) => s.name === p.runsIn) : undefined;
    const home = sub ? placeOfSubsystem(model, sub) : undefined;
    walkStates(p.states, (s) => {
      for (const [eventKey, ts] of Object.entries(s.on)) {
        const event = eventKey.split("#")[0]!;
        const from = (raisers.get(event) ?? []).map((r) => placeOf(model, r));
        // Placed in a part: the event crosses to it, and its commands cross from it.
        if (home) for (const r of from) out.push({ from: r, to: home, event, policy: p.name, down: "to" });
        for (const t of ts) {
          const target = targetOf(t);
          if (!target || !model.aggregates[target]) continue;
          const named = t.command ? /\.([^.]+)$/.exec(t.command.target)?.[1] : undefined;
          const name = named === "${eventName}" ? event : named && /^[A-Za-z_][A-Za-z0-9_]*$/.test(named) ? named : undefined;
          const command = name ? `${target}.${name}` : undefined;
          // A subtype that has no answer to the command ignores it: nothing crosses to its part for it.
          const answering = concreteOf(model, target).filter((c) => !name || commandsAnsweredBy(model.aggregates[c]!).has(name));
          for (const to of answering.map((c) => placeOf(model, c))) {
            if (home) out.push({ from: home, to, ...(command ? { command } : {}), policy: p.name, down: "from" });
            // Run by each part it commands: only the event crosses, heard there (ADR 0035 §2).
            else if (p.runsIn === TARGET) for (const r of from) out.push({ from: r, to, event, policy: p.name, down: "to" });
            // Run by each part that raises the event: only the command crosses, sent from there.
            else if (p.runsIn === SOURCE) for (const r of from) out.push({ from: r, to, ...(command ? { command } : {}), policy: p.name, down: "from" });
            else for (const r of from) out.push({ from: r, to, event, ...(command ? { command } : {}), policy: p.name });
          }
        }
      }
    });
  }
  return out;
}

/**
 * Edges from the model alone: a policy reacting to an event raised in A that commands a type in B;
 * an external system's commands and the events it receives. Targets computed at run time (a
 * command template naming no type) cannot be placed, and are left out. Where the policy runs, the
 * edge says which end depends on the other (ADR 0035).
 */
export function contextMap(model: Model, level: Level, scope?: string): ContextMap {
  if (!model.systems) throw new SystemsError("the model declares no `systems:` (ADR 0018)");
  const nodes = nodesAt(model, level, scope);
  const group = (p: Place | undefined) => groupOf(p, level, scope);
  const at = (type: string) => group(placeOf(model, type));
  const raisers = new Map<string, string[]>();
  for (const m of Object.values(model.aggregates)) if (!m.abstract) for (const e of eventsRaisedBy(m)) raisers.set(e, [...(raisers.get(e) ?? []), m.name]);
  const edges = new Map<string, MapEdge>();
  const add = (from: string, to: string, event?: string, command?: string, policy?: string, down?: string) => {
    if (from === to) return;
    const k = `${from}\u0000${to}`;
    const e = edges.get(k) ?? { from, to, events: [], commands: [], patterns: [], policies: [], downstream: [] };
    if (event && !e.events.includes(event)) e.events.push(event);
    if (command && !e.commands.includes(command)) e.commands.push(command);
    if (policy && !e.policies.includes(policy)) e.policies.push(policy);
    if (down && !e.downstream.includes(down)) e.downstream.push(down);
    edges.set(k, e);
  };
  for (const c of crossingsOf(model)) {
    const from = group(c.from), to = group(c.to);
    add(from, to, c.event, c.command, c.policy, c.down === "from" ? from : c.down === "to" ? to : undefined);
  }
  for (const part of model.systems.subsystems.filter((s) => s.external)) {
    const from = groupOf(placeOfSubsystem(model, part), level, scope);
    for (const s of part.sends ?? []) add(from, at(s.type), undefined, `${s.type}.${s.command}`);
    for (const e of part.receives ?? []) for (const r of raisers.get(e) ?? []) add(at(r), from, e);
  }
  const list = [...edges.values()];
  // Each depends on the other: an edge either way between them that says so (ADR 0035 §5).
  const depends = new Set(list.flatMap((e) => e.downstream.map((d) => `${d}\u0000${d === e.from ? e.to : e.from}`)));
  for (const e of list) if (depends.has(`${e.from}\u0000${e.to}`) && depends.has(`${e.to}\u0000${e.from}`)) e.mutual = true;
  for (const r of model.systems.relations) {
    const between = list.filter((x) => (x.from === r.upstream && x.to === r.downstream) || (x.from === r.downstream && x.to === r.upstream));
    between[0]?.patterns.push(r.pattern);
    // What the policies do not say, a declared relation does (ADR 0035 §4).
    for (const e of between) if (e.downstream.length === 0) e.downstream.push(r.downstream);
  }
  return { level, ...(scope ? { scope } : {}), nodes, edges: list };
}

/** ADR 0035: the parts each depends on, at a level — from the placed policies only. */
function dependencies(model: Model, key: (p: Place) => string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const c of crossingsOf(model)) {
    if (!c.down || !c.from || !c.to) continue;
    const [down, up] = c.down === "from" ? [key(c.from), key(c.to)] : [key(c.to), key(c.from)];
    if (down === up) continue;
    const m = out.get(down) ?? out.set(down, new Map()).get(down)!;
    if (!m.has(up)) m.set(up, c.policy);
  }
  return out;
}

// ------------------------------------------------------------------ who sends a command from outside

function sendMatches(s: SystemSendDef, type: string, command: string, payload: Record<string, Json>): boolean {
  return s.type === type && s.command === command &&
    Object.entries(s.where ?? {}).every(([field, values]) => values.includes(String(payload[field])));
}

/**
 * The external parts told of this event, raised with this payload (ADR 0020, ADR 0031): every part that
 * receives it, where a part narrows it by the payload only when the payload matches.
 */
export function receiversOfEvent(model: Model, event: string, payload: Record<string, Json>): SubsystemDef[] {
  return (model.systems?.subsystems ?? []).filter((p) => p.external && (p.receives ?? []).includes(event) &&
    Object.entries(p.receivesWhere?.[event] ?? {}).every(([field, values]) => values.includes(String(payload[field]))));
}

/**
 * Whether the parts told of an event are chosen by its payload (ADR 0031): the fields some part narrows
 * it by, and every part that could be told — empty when every receiver hears it whatever it carries.
 */
export function choiceOfEvent(model: Model, event: string): { fields: string[]; among: SubsystemDef[] } {
  const among = (model.systems?.subsystems ?? []).filter((p) => p.external && (p.receives ?? []).includes(event));
  const fields = [...new Set(among.flatMap((p) => Object.keys(p.receivesWhere?.[event] ?? {})))];
  return { fields, among: fields.length ? among : [] };
}

/**
 * The external part that sends this command with this payload: the first whose declaration matches
 * (ADR 0020 §4), a plain `Type.Command` matching any payload — or the part of our own that works it
 * out itself (ADR 0030). Undefined: a person sends it.
 */
export function senderOfCommand(model: Model, type: string, command: string, payload: Record<string, Json>): SubsystemDef | undefined {
  return model.systems?.subsystems.find((p) => (p.external && (p.sends ?? []).some((s) => sendMatches(s, type, command, payload)))
    || (p.computes ?? []).some((s) => sendMatches(s, type, command, payload)));
}

/** ADR 0027 §3: the role whose contract holds this command with this payload — undefined: no role sends it. */
export function roleOfCommand(model: Model, type: string, command: string, payload: Record<string, Json>): RoleDef | undefined {
  return model.systems?.roles.find((r) => r.sends.some((s) => sendMatches(s, type, command, payload)));
}

/** ADR 0027 §1: the role a type is worked in — its own declaration, or its nearest ancestor's. */
export function roleOfType(model: Model, type: string): RoleDef | undefined {
  const roles = model.systems?.roles ?? [];
  if (roles.length === 0) return undefined;
  for (const t of [type, ...(model.aggregates[type]?.ancestors ?? [])]) {
    const r = roles.find((x) => x.works.includes(t));
    if (r) return r;
  }
  return undefined;
}

/**
 * `sequence: label:` (ADR 0032): for a command (`Type.Command`) or an event, the payload fields its arrow
 * shows, in order — a path into a list of rows (`logisticUnits.lu`) shows each row's — and `id`, the
 * instance it reaches, shown after them so alike arrows still fold and list theirs.
 */
export function sequenceLabelsOf(raw: unknown, model: Model): Record<string, string[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const rec = record(raw, "sequence");
  only(rec, ["label"], "sequence");
  const out: Record<string, string[]> = {};
  const raised = new Set(Object.values(model.aggregates).flatMap((m) => [...eventsRaisedBy(m)]));
  for (const [key, body] of Object.entries(record(rec.label, "sequence.label"))) {
    const where = `sequence.label.${key}`;
    const fields = list(body, where);
    if (fields.length === 0) throw new SystemsError(`${where}: name the fields its arrow shows`);
    let known: Set<string> | undefined;
    const m = NAME.exec(key);
    if (m) {
      const type = model.aggregates[m[1]!];
      if (!type) throw new SystemsError(`${where}: there is no type called \`${m[1]}\``);
      if (!commandsAnsweredBy(type).has(m[2]!)) throw new SystemsError(`${where}: ${m[1]} answers no command \`${m[2]}\``);
      known = fieldsTaken(model, type, m[2]!);
    } else {
      if (!raised.has(key)) throw new SystemsError(`${where}: \`${key}\` is no command (Type.Command) and no event the model raises`);
      known = fieldsOfEvent(model, key);
    }
    for (const f of fields) {
      const head = f.split(".")[0]!;
      if (f !== "id" && known && !known.has(head)) throw new SystemsError(`${where}: \`${head}\` is not among its fields (${[...known].join(", ")}), nor \`id\``);
    }
    out[key] = fields;
  }
  return out;
}

/** The payload fields some external system narrows this command by — what tells its senders apart. */
export function narrowedBy(model: Model, type: string, command: string): string[] {
  return [...new Set((model.systems?.subsystems ?? []).flatMap((p) => (p.sends ?? []).filter((s) => s.type === type && s.command === command).flatMap((s) => Object.keys(s.where ?? {}))))];
}

// ------------------------------------------------------------------ a run as a sequence: sequence.ts (ADR 0022)

export const PERSON = "person";

// ------------------------------------------------------------------ Mermaid (ADR 0018 §6)

/** A name as a Mermaid id. */
export function mid(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export function contextMapToMermaid(m: ContextMap): string {
  const lines = ["flowchart LR"];
  for (const n of m.nodes) {
    const label = n.kind === "external" ? `${n.id}<br/>«external»`
      : n.kind === "domain" ? `${n.id}<br/>«domain»${n.holds?.length ? `<br/>${n.holds.join(", ")}` : ""}`
      : n.spans ? `${n.id}<br/>(${n.spans.join(", ")})` : n.library ? `${n.id}<br/>library: ${n.library.join(", ")}` : n.id;
    lines.push(n.kind === "external" ? `  ${mid(n.id)}[/"${label}"/]` : n.kind === "domain" ? `  ${mid(n.id)}(["${label}"])` : `  ${mid(n.id)}["${label}"]`);
  }
  for (const e of m.edges) {
    const said = [...e.events, ...e.commands.filter((c) => !e.events.includes(c)).map((c) => `${c}()`)];
    const ends = e.downstream.length === 2 ? "D ↔ D" : e.downstream[0] === e.to ? "U → D" : e.downstream[0] === e.from ? "D → U" : "";
    const what = [...(ends ? [ends] : []), ...e.patterns.map((p) => `«${p}»`), ...said.slice(0, 4), ...(said.length > 4 ? [`+${said.length - 4} more`] : [])].join(", ");
    lines.push(`  ${mid(e.from)} -->|"${what}"| ${mid(e.to)}`);
  }
  return lines.join("\n") + "\n";
}
