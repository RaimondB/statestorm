/**
 * Coverage (MC-3): every rule and state of every concrete type, against the union of the
 * scenario runs under every schedule. An accepted gap is stated in the model —
 * `coverage: { ignore: { "<rule id or Type.state>": why } }` — so a gap is a decision.
 */
import type { LogEntry, Model, StateDef } from "@statestorm/kernel";

export interface TypeCoverage {
  type: string;
  rules: { total: number; taken: number; untaken: { id: string; guard?: string; ignored?: string }[] };
  states: { total: number; reached: number; unreached: { path: string; ignored?: string }[] };
}

export interface CoverageReport {
  types: TypeCoverage[];
  /** `coverage.ignore` entries that name nothing — a stale decision is loud (A2). */
  stale: string[];
}

const machineOf = (key: string) => key.slice(0, key.indexOf("#"));

function walk(states: Record<string, StateDef>, visit: (s: StateDef) => void) {
  for (const s of Object.values(states)) { visit(s); walk(s.states, visit); }
}

export function ignoredOf(model: Model): Record<string, string> {
  const cov = model.coverage as { ignore?: Record<string, unknown> } | undefined;
  return Object.fromEntries(Object.entries(cov?.ignore ?? {}).map(([k, v]) => [k, String(v)]));
}

export function coverage(model: Model, logs: LogEntry[][]): CoverageReport {
  const taken = new Map<string, Set<string>>();     // type -> rule ids
  const reached = new Map<string, Set<string>>();   // type -> state paths
  const mark = (m: Map<string, Set<string>>, type: string, v: string) => (m.get(type) ?? m.set(type, new Set()).get(type)!).add(v);
  const reach = (type: string, path: string) => {
    const parts = path.split(".");
    for (let i = 1; i <= parts.length; i++) mark(reached, type, parts.slice(0, i).join("."));
  };
  for (const log of logs) for (const e of log) {
    if (e.kind === "transition") { mark(taken, machineOf(e.instance), e.via); reach(machineOf(e.instance), e.to); }
    else if (e.kind === "created") reach(machineOf(e.instance), e.state);
  }
  const ignore = ignoredOf(model);
  const used = new Set<string>();
  const types: TypeCoverage[] = [];
  for (const m of Object.values(model.aggregates)) {
    if (m.abstract) continue;
    const ids: { id: string; guard?: string }[] = [];
    const paths: string[] = [];
    walk(m.states, (s) => {
      paths.push(s.path.join("."));
      for (const list of Object.values(s.on)) for (const t of list) ids.push({ id: t.id, ...(t.guard ? { guard: t.guard } : {}) });
      for (const oc of s.onChildren) ids.push({ id: oc.transition.id, ...(oc.transition.guard ? { guard: oc.transition.guard } : {}) });
      for (const a of s.after) ids.push({ id: a.transition.id });
      if (s.onDone) ids.push({ id: s.onDone.id });
    });
    const t = taken.get(m.name) ?? new Set();
    const r = reached.get(m.name) ?? new Set();
    const why = (k: string) => { if (ignore[k] !== undefined) { used.add(k); return ignore[k]; } return undefined; };
    const untaken = ids.filter((x) => !t.has(x.id)).map((x) => ({ ...x, ...(why(x.id) !== undefined ? { ignored: why(x.id)! } : {}) }));
    const unreached = paths.filter((p) => !r.has(p)).map((p) => ({ path: p, ...(why(`${m.name}.${p}`) !== undefined ? { ignored: why(`${m.name}.${p}`)! } : {}) }));
    types.push({
      type: m.name,
      rules: { total: ids.length, taken: ids.length - untaken.length, untaken },
      states: { total: paths.length, reached: paths.length - unreached.length, unreached },
    });
  }
  return { types, stale: Object.keys(ignore).filter((k) => !used.has(k)) };
}
