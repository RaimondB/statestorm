/**
 * The UI's whole notion of a run: a model, a schedule and a list of actions. Everything on
 * screen is derived from replaying them (design §4) — the UI never holds domain state, so
 * time travel is choosing a frame and "continue from here" is truncating the action list.
 */
import {
  createWorld, advance, describeSchedule, send,
  type Frame, type Json, type MachineDef, type Model, type Schedule, type World,
} from "@statestorm/kernel";
import type { Scenario } from "@statestorm/scenarios";

export type Action =
  /** `setup`: one of the scenario's `given:` sends — folded in the sequence (ADR 0022 §4). */
  | { kind: "send"; ref: string; payload: Record<string, Json>; setup?: boolean }
  | { kind: "advance"; ms: number; label: string }
  /** A named point in the run, for jumping to; it changes nothing. */
  | { kind: "phase"; name: string };

export interface Run {
  world: World;
  frames: Frame[];
  /** For each frame, the action that produced it; -1 for the empty world. */
  actionOf: number[];
  /** An action that threw — a kernel or model error, shown rather than swallowed. */
  error?: { action: number; message: string };
  /** Each phase and the frame it starts at: the world as the phase begins. */
  phases: { name: string; frame: number }[];
  /** The last log entry of the set-up — the scenario's `given:` sends — if it had one. */
  setup?: number;
}

export const DEFAULT_START = "2026-01-01T09:00:00Z";

export function play(model: Model, actions: Action[], schedule: Schedule, startedAt = DEFAULT_START): Run {
  const world = createWorld(model, startedAt, schedule, { frames: true });
  const frames = world.frames!;
  const actionOf: number[] = frames.map(() => -1);
  let error: Run["error"];
  const phases: Run["phases"] = [];
  let setup: number | undefined;
  for (const [i, action] of actions.entries()) {
    if (action.kind === "phase") {
      phases.push({ name: action.name, frame: frames.length - 1 });
      continue;
    }
    try {
      if (action.kind === "send") send(world, action.ref, action.payload);
      else advance(world, action.ms);
    } catch (err) {
      error = { action: i, message: err instanceof Error ? err.message : String(err) };
      break;
    }
    while (actionOf.length < frames.length) actionOf.push(i);
    if (action.kind === "send" && action.setup) setup = world.log[world.log.length - 1]?.seq;
  }
  return { world, frames, actionOf, error, phases, ...(setup !== undefined ? { setup } : {}) };
}

/**
 * Just the log of a run, without frames — for reading many runs at once (the flow board reads
 * every scenario). A run that throws keeps the log up to where it stopped.
 */
export function logOf(model: Model, actions: Action[], schedule: Schedule, startedAt = DEFAULT_START): World["log"] {
  const world = createWorld(model, startedAt, schedule);
  for (const action of actions) {
    try {
      if (action.kind === "send") send(world, action.ref, action.payload);
      else if (action.kind === "advance") advance(world, action.ms);
    } catch {
      break;
    }
  }
  return world.log;
}

/** A scenario's `given` and `when`, minus its assertions, as replayable actions. */
export function actionsOf(scenario: Scenario): Action[] {
  const out: Action[] = scenario.given.phase ? [{ kind: "phase", name: scenario.given.phase }] : [];
  out.push(...scenario.given.send.map((s): Action => ({ kind: "send", ref: s.ref, payload: s.payload, setup: true })));
  for (const step of scenario.when) {
    if (step.step === "phase") out.push({ kind: "phase", name: step.name });
    if (step.step === "send") out.push({ kind: "send", ref: step.ref, payload: step.payload });
    if (step.step === "advance") out.push({ kind: "advance", ms: step.ms, label: step.label });
  }
  return out;
}

/**
 * Acting while scrubbed back forks the run (R20). The fork point is the end of the action
 * the current frame belongs to: a cascade is not interruptible yet, so continuing from the
 * middle of one means continuing from where it settled.
 */
export function continueFrom(actions: Action[], run: Run, frame: number, next: Action): Action[] {
  const owner = run.actionOf[frame] ?? actions.length - 1;
  return [...actions.slice(0, owner + 1), next];
}

/** The frame in which a log entry was written. */
export function frameOfEntry(run: Run, seq: number): number {
  const i = run.frames.findIndex((f) => f.seq >= seq);
  return i < 0 ? run.frames.length - 1 : i;
}

/** Every command an aggregate type answers to anywhere in its chart, creators first. */
export function commandsOf(machine: MachineDef): string[] {
  const names = new Set<string>(machine.creators);
  const walk = (states: MachineDef["states"]) => {
    for (const s of Object.values(states)) {
      for (const name of Object.keys(s.on)) names.add(name);
      walk(s.states);
    }
  };
  walk(machine.states);
  return [...names];
}

/**
 * The types a command can be fired at: aggregates only (an entity is reached through its aggregate,
 * ADR 0012), and no abstract type — it has no instances (ADR 0008).
 */
export function fireableTypes(model: Model): string[] {
  return Object.values(model.aggregates).filter((a) => !a.abstract && a.role === "aggregate").map((a) => a.name);
}

/**
 * The type to fire at once the model is `model`: the one chosen, while it can still be fired at —
 * else the first that can. A name the model merely has is not enough: switching models can leave
 * the choice on a type that is abstract, or an entity, in the new one.
 */
export function typeToFire(model: Model, chosen: string): string {
  const types = fireableTypes(model);
  return types.includes(chosen) ? chosen : (types[0] ?? "");
}

export function scheduleLabel(s: Schedule): string {
  return describeSchedule(s);
}

export function describeAction(a: Action): string {
  if (a.kind === "advance") return `advance ${a.label}`;
  if (a.kind === "phase") return `— ${a.name} —`;
  const keys = Object.keys(a.payload);
  return keys.length === 0 ? a.ref : `${a.ref}  ${keys.map((k) => `${k}=${plain(a.payload[k]!)}`).join(" ")}`;
}

/** A payload value as a person would write it: `[widget, gizmo]`, not `["widget","gizmo"]`. */
function plain(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(plain).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${k}: ${plain(x)}`).join(", ")}}`;
  return String(v);
}

/** `Type#id` -> `Type`; policy instances are keyed the same way. */
export function machineOfKey(key: string): string {
  const hash = key.indexOf("#");
  return hash < 0 ? key : key.slice(0, hash);
}
