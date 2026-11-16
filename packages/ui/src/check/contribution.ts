/**
 * What each scenario covers that no other scenario does (MC-16): the rules it alone takes, the
 * states it alone reaches, the drawn arrows it alone walks on its drawing. A scenario that covers
 * nothing of its own adds runs, not reach — kept, if at all, for what it asserts.
 */
import type { LogEntry, Model } from "@statestorm/kernel";

export interface Contribution {
  file: string;
  rules: string[];
  states: string[];
  arrows: string[];
}

const machineOf = (key: string) => key.slice(0, key.indexOf("#"));

/** Per scenario, the rules (`Type: rule id`) it takes and the states (`Type.path`) it reaches. */
export function reachOf(model: Model, logs: LogEntry[][]): { rules: Set<string>; states: Set<string> } {
  const rules = new Set<string>();
  const states = new Set<string>();
  const reach = (type: string, path: string) => {
    const parts = path.split(".");
    for (let i = 1; i <= parts.length; i++) states.add(`${type}.${parts.slice(0, i).join(".")}`);
  };
  for (const log of logs) for (const e of log) {
    if (e.kind === "transition") {
      const type = machineOf(e.instance);
      if (!model.aggregates[type]) continue;
      rules.add(e.via.startsWith(`${type}.`) ? e.via : `${type}: ${e.via}`);
      reach(type, e.to);
    } else if (e.kind === "created" && model.aggregates[machineOf(e.instance)]) reach(machineOf(e.instance), e.state);
  }
  return { rules, states };
}

/**
 * `runs`: every run of every scenario (all schedules). `arrows`: per scenario, the drawn arrows
 * it walks, already keyed so that two scenarios walking the same arrow of the same drawing agree.
 */
export function contributions(model: Model, runs: { file: string; log: LogEntry[] }[], arrows: Map<string, Set<string>> = new Map()): Contribution[] {
  const files = [...new Set(runs.map((r) => r.file))];
  const reach = new Map(files.map((f) => [f, reachOf(model, runs.filter((r) => r.file === f).map((r) => r.log))]));
  const count = (pick: (f: string) => Iterable<string>) => {
    const n = new Map<string, number>();
    for (const f of files) for (const x of pick(f)) n.set(x, (n.get(x) ?? 0) + 1);
    return n;
  };
  const rules = count((f) => reach.get(f)!.rules);
  const states = count((f) => reach.get(f)!.states);
  const drawn = count((f) => arrows.get(f) ?? []);
  const only = (xs: Iterable<string>, n: Map<string, number>) => [...xs].filter((x) => n.get(x) === 1).sort();
  return files.map((file) => ({
    file,
    rules: only(reach.get(file)!.rules, rules),
    states: only(reach.get(file)!.states, states),
    arrows: only(arrows.get(file) ?? [], drawn),
  }));
}
