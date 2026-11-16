/** Hierarchy helpers. ADR 0005: the active state is a configuration, not a label. */
import { ModelError, type Configuration, type MachineDef, type StateDef, type StatePath } from "./types.ts";

export function pathOf(ref: string): StatePath {
  return ref.split(".").filter((s) => s.length > 0);
}

export function refOf(path: StatePath): string {
  return path.join(".");
}

/** Resolves a dotted path from the root. No relative addressing — ADR 0005 §7. */
export function stateAt(machine: MachineDef, path: StatePath): StateDef {
  let level: Record<string, StateDef> = machine.states;
  let found: StateDef | undefined;
  for (const seg of path) {
    found = level[seg];
    if (!found) throw new ModelError(`${machine.name}: no such state \`${refOf(path)}\``);
    level = found.states;
  }
  if (!found) throw new ModelError(`${machine.name}: empty state path`);
  return found;
}

/** Follows `initial` down from a state until it reaches a leaf — the entry path. */
export function resolveEntry(machine: MachineDef, path: StatePath): StatePath {
  let out = [...path];
  let def = stateAt(machine, out);
  while (Object.keys(def.states).length > 0) {
    if (!def.initial) throw new ModelError(`${machine.name}: composite \`${refOf(out)}\` has no initial state`);
    out = [...out, def.initial];
    def = stateAt(machine, out);
  }
  return out;
}

export function initialConfiguration(machine: MachineDef): Configuration {
  return [resolveEntry(machine, [machine.initial])];
}

/** The single active path. v1 has exactly one; parallel regions (Q10) relax this. */
export function activePath(config: Configuration): StatePath {
  const first = config[0];
  if (!first || config.length !== 1) throw new ModelError("v1 expects exactly one active path");
  return first;
}

/** Active states innermost-first — the order a command bubbles outward. ADR 0005 §2. */
export function bubbleOrder(machine: MachineDef, config: Configuration): StateDef[] {
  const path = activePath(config);
  const out: StateDef[] = [];
  for (let i = path.length; i > 0; i--) out.push(stateAt(machine, path.slice(0, i)));
  return out;
}

/** Every active state as a dotted ref, for in_state() and child tallies. */
export function activeRefs(machine: MachineDef, config: Configuration): Set<string> {
  const out = new Set<string>();
  for (const path of config) {
    for (let i = 1; i <= path.length; i++) out.add(refOf(path.slice(0, i)));
  }
  void machine;
  return out;
}

function commonPrefix(a: StatePath, b: StatePath): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export interface Move {
  exit: StateDef[];
  enter: StateDef[];
  to: StatePath;
}

/**
 * Exit innermost-outward up to (excluding) the least common ancestor of the transition's
 * owner and target; enter from just below it down to the target's initial leaf.
 * ADR 0005 §4.
 */
export function move(
  machine: MachineDef,
  config: Configuration,
  owner: StatePath,
  targetRef: string,
): Move {
  const from = activePath(config);
  const target = resolveEntry(machine, pathOf(targetRef));
  // A transition that targets its own owner is an external self-transition: it exits and
  // re-enters, so entry emissions and timers fire again.
  const domain = refOf(owner) === refOf(pathOf(targetRef))
    ? owner.length - 1
    : commonPrefix(owner, target);

  const exit: StateDef[] = [];
  for (let i = from.length; i > domain; i--) exit.push(stateAt(machine, from.slice(0, i)));
  const enter: StateDef[] = [];
  for (let i = domain + 1; i <= target.length; i++) enter.push(stateAt(machine, target.slice(0, i)));
  return { exit, enter, to: target };
}

/** An instance is final when the state active in its *root* region is final — ADR 0005 §6. */
export function isFinalConfiguration(machine: MachineDef, config: Configuration): boolean {
  const root = activePath(config)[0]!;
  return stateAt(machine, [root]).final;
}
