/**
 * Static checks (MC-2): what the model says, read without running it. Each finding names where it
 * is and why it matters; the severity says how sure the check is that it is a mistake.
 */
import type { Json, MachineDef, Model, StateDef, TransitionDef } from "@statestorm/kernel";
import { eventNames } from "../overview.ts";

export interface Finding {
  check: "unheard" | "unraised" | "unsent" | "unentered" | "no-way-out" | "uncreated" | "never-holds";
  severity: "error" | "warning" | "info";
  where: string;
  message: string;
}

const base = (name: string) => name.split("#")[0]!;

function rules(states: Record<string, StateDef>, out: { state: StateDef; t: TransitionDef; key: string }[] = []) {
  for (const st of Object.values(states)) {
    for (const [key, list] of Object.entries(st.on)) for (const t of list) out.push({ state: st, t, key: base(key) });
    for (const oc of st.onChildren) out.push({ state: st, t: oc.transition, key: "" });
    for (const a of st.after) out.push({ state: st, t: a.transition, key: "" });
    if (st.onDone) out.push({ state: st, t: st.onDone, key: "" });
    rules(st.states, out);
  }
  return out;
}

function allStates(states: Record<string, StateDef>, out: StateDef[] = []): StateDef[] {
  for (const st of Object.values(states)) { out.push(st); allStates(st.states, out); }
  return out;
}

/** `Type#id.Name` / `${item}.Name` / `${item}.${eventName}` → the command's name, or undefined. */
function commandName(target: string, eventName?: string): string | undefined {
  const m = /\.([A-Za-z_$][\w${}]*)$/.exec(target.trim());
  if (!m) return undefined;
  const name = m[1]!;
  if (name === "${eventName}") return eventName;
  return name.includes("${") ? undefined : name;
}
const targetType = (target: string) => /^([A-Za-z_]\w*)#/.exec(target)?.[1];

/** Values a payload field takes: a literal, or `open` when it is computed. */
type Values = { open: boolean; values: Set<string> };

/** Every command the model sends itself — a policy's, or an owner's to its own entities. One it
 *  handles and does not send comes from outside: a person, or a system the model does not hold. */
export function sentByModel(model: Model): Set<string> {
  const sent = new Set<string>();
  for (const p of Object.values(model.policies)) for (const r of rules(p.states)) {
    const cmd = r.t.command ? commandName(r.t.command.target, r.key) : undefined;
    if (cmd) sent.add(cmd);
  }
  for (const a of Object.values(model.aggregates)) for (const r of rules(a.states)) for (const sd of r.t.send) {
    const cmd = sd.to ? commandName(sd.to) : sd.command;
    if (cmd) sent.add(cmd);
  }
  return sent;
}

export function staticChecks(model: Model, scenarioInputs: { ref: string; payload: Record<string, Json> }[] = []): Finding[] {
  const out: Finding[] = [];
  const aggregates = Object.values(model.aggregates);
  const policies = Object.values(model.policies);

  // ---- events: raised, and listened to
  const raised = new Set(eventNames(model));
  const heard = new Set(policies.flatMap((p) => rules(p.states).map((r) => r.key)));
  for (const e of [...raised].sort()) {
    if (!heard.has(e)) out.push({ check: "unheard", severity: "info", where: e, message: `${e} is raised, and no policy reacts to it — an outcome for the outside world, or a missing policy` });
  }
  for (const p of policies) for (const r of rules(p.states)) {
    if (r.key && !raised.has(r.key)) out.push({ check: "unraised", severity: "warning", where: `${p.name} on ${r.key}`, message: `${p.name} waits for ${r.key}, which no aggregate raises` });
  }

  // ---- commands: who sends what, with which values
  const sent = new Set<string>();
  const fields = new Map<string, Values>();          // `Command.field` → values
  const note = (cmd: string | undefined, payload: Record<string, Json> | undefined, type?: string) => {
    if (!cmd) return;
    sent.add(cmd);
    if (type) sent.add(`${type}.${cmd}`);
    for (const [f, v] of Object.entries(payload ?? {})) {
      const k = `${cmd}.${f}`;
      const entry = fields.get(k) ?? fields.set(k, { open: false, values: new Set() }).get(k)!;
      if (typeof v === "string" && !v.includes("${")) entry.values.add(v);
      else if (typeof v === "number" || typeof v === "boolean") entry.values.add(String(v));
      else entry.open = true;
    }
  };
  for (const p of policies) for (const r of rules(p.states)) {
    if (r.t.command) note(commandName(r.t.command.target, r.key), r.t.command.payload, targetType(r.t.command.target));
  }
  for (const a of aggregates) for (const r of rules(a.states)) for (const sd of r.t.send) {
    if (sd.to) note(commandName(sd.to), sd.payload, targetType(sd.to));
    else if (sd.command) note(sd.command, sd.payload);
  }
  const byPerson = new Set<string>();
  for (const s of scenarioInputs) {
    const cmd = s.ref.slice(s.ref.lastIndexOf(".") + 1);
    byPerson.add(cmd);
    note(cmd, s.payload);
  }
  for (const a of aggregates) {
    if (a.abstract) continue;
    const handled = new Set(rules(a.states).map((r) => r.key).filter(Boolean));
    for (const cmd of [...handled].sort()) {
      if (!sent.has(cmd) && !byPerson.has(cmd)) {
        out.push({ check: "unsent", severity: "info", where: `${a.name}.${cmd}`, message: `${a.name} handles ${cmd}, which no policy or owner sends and no scenario does — a person's command nobody has tried, or a dead rule` });
      }
    }
  }

  // ---- states: entered, and left
  for (const a of aggregates) {
    if (a.abstract) continue;
    const entered = new Set<string>();
    const enterInitial = (states: Record<string, StateDef>, initial: string | undefined) => {
      const st = initial ? states[initial] : undefined;
      if (!st) return;
      entered.add(st.path.join("."));
      enterInitial(st.states, st.initial);
    };
    enterInitial(a.states, a.initial);
    const byPath = new Map(allStates(a.states).map((s) => [s.path.join("."), s]));
    for (const r of rules(a.states)) {
      if (!r.t.target) continue;
      const parts = r.t.target.split(".");
      for (let i = 1; i <= parts.length; i++) entered.add(parts.slice(0, i).join("."));
      const leaf = byPath.get(r.t.target);
      if (leaf) enterInitial(leaf.states, leaf.initial);
    }
    // A subtype cannot remove a state it inherits (ADR 0008): one it never enters is worth a
    // word, not a warning. Its own unenterable states are a warning.
    const inherited = (p: string) => a.ancestors.some((anc) => {
      let states = model.aggregates[anc]?.states;
      for (const part of p.split(".")) { const st = states?.[part]; if (!st) return false; states = st.states; }
      return true;
    });
    for (const st of allStates(a.states)) {
      const p = st.path.join(".");
      if (entered.has(p)) continue;
      if (inherited(p)) out.push({ check: "unentered", severity: "info", where: `${a.name}.${p}`, message: `${a.name} never enters ${p}, which it inherits` });
      else out.push({ check: "unentered", severity: "warning", where: `${a.name}.${p}`, message: `${a.name}: nothing enters ${p}` });
    }
    // A leaf that is not final, where neither it nor a state around it has a rule that moves on.
    for (const st of allStates(a.states)) {
      if (Object.keys(st.states).length > 0 || st.final || !entered.has(st.path.join("."))) continue;
      const around = st.path.map((_, i) => byPath.get(st.path.slice(0, i + 1).join("."))!).filter(Boolean);
      const moves = around.some((s) => rules({ x: { ...s, states: {} } }).some((r) => r.t.target && r.t.target !== st.path.join(".")));
      if (!moves) out.push({ check: "no-way-out", severity: "info", where: `${a.name}.${st.path.join(".")}`, message: `${a.name} never leaves ${st.path.join(".")}, and it is not final — a record that lives on, or a step that waits forever` });
    }
  }

  // ---- entities: created by someone
  const createdTypes = new Set<string>();
  for (const a of aggregates) for (const r of rules(a.states)) for (const sd of r.t.send) {
    const t = sd.to ? targetType(sd.to) : undefined;
    if (t) createdTypes.add(t);
  }
  for (const a of aggregates) {
    if (a.role !== "entity" || a.abstract) continue;
    if (!createdTypes.has(a.name)) out.push({ check: "uncreated", severity: "warning", where: a.name, message: `${a.name} is an entity nothing creates: no owner sends it a command` });
  }

  // ---- guards: compared with a value the field never holds
  const dataValues = (a: MachineDef, field: string): Values => {
    const v: Values = { open: false, values: new Set() };
    let any = false;
    for (const r of rules(a.states)) {
      const expr = r.t.assign[field];
      if (expr === undefined) continue;
      any = true;
      const lit = /^'([^']*)'$/.exec(expr.trim());
      const cmd = /^command\.(\w+)$/.exec(expr.trim());
      if (lit) v.values.add(lit[1]!);
      else if (cmd && r.key) {
        const f = fields.get(`${r.key}.${cmd[1]}`);
        if (!f || f.open) v.open = true;
        else for (const x of f.values) v.values.add(x);
      } else v.open = true;
    }
    if (!any) v.open = true;
    return v;
  };
  for (const a of aggregates) {
    if (a.abstract) continue;
    for (const r of rules(a.states)) {
      if (!r.t.guard) continue;
      for (const m of r.t.guard.matchAll(/\b((?:command\.)?\w+)\s*(?:==|!=)\s*'([^']*)'/g)) {
        const [, lhs, value] = m as unknown as [string, string, string];
        let v: Values | undefined;
        if (lhs.startsWith("command.") && r.key) v = fields.get(`${r.key}.${lhs.slice(8)}`);
        else if (a.data[lhs]) v = dataValues(a, lhs);
        if (!v || v.open || v.values.has(value)) continue;
        out.push({
          check: "never-holds", severity: "warning", where: r.t.id,
          message: `${r.t.id}: \`${lhs}\` is compared with '${value}', but only ever holds ${[...v.values].map((x) => `'${x}'`).join(", ") || "nothing"} — a misspelling, or a value nobody sends`,
        });
      }
    }
  }
  return out;
}

