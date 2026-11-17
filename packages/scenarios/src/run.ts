/**
 * Scenario runner (R30, R31). The same runner backs `node --test` in CI and — once there
 * is a UI — the replay button, because it only depends on the kernel.
 */
import { parse as parseYaml } from "yaml";
import {
  activeOf, advance, createWorld, describeSchedule, eventsOf, parseDuration, send, stateOf,
  type Json, type Model, type Schedule, type World,
} from "@statestorm/kernel";

export interface Scenario {
  name: string;
  file?: string;
  /** The business drawing this scenario walks (MC-14): the one that should draw every arrow it shows. */
  drawing?: string;
  /** `happy` or `deviation`, and what it is about — `cancellation`, `missing` — for grouping. */
  tags?: string[];
  /** The ids of the domain's rules it shows (ADR 0016); the model check traces them. */
  why?: string[];
  /** Omitted means `fifo` — the one readable story. Chaos is a deliberate second pass. */
  schedule?: Schedule;
  /** `phase:` names the set-up, so a viewer can jump past it ("Planning"). `include:` names the shared
   *  set-ups it starts with (ADR 0029); their sends come first in `send`, in the order included. */
  given: { at?: string; phase?: string; include?: string[]; send: { ref: string; payload: Record<string, Json> }[] };
  when: Step[];
  then: Assertion[];
}

export type Step =
  | { step: "send"; ref: string; payload: Record<string, Json> }
  /** A named point in the run — "Collection", "Testing" — for jumping to. No effect on the world. */
  | { step: "phase"; name: string }
  | { step: "advance"; ms: number; label: string }
  | { step: "assert"; assertion: Assertion };

export type Assertion =
  | { kind: "state"; of: Record<string, string> }
  | { kind: "in_state"; of: Record<string, string> }
  | { kind: "not_in_state"; of: Record<string, string> }
  | { kind: "emitted"; events: string[] }
  | { kind: "not_emitted"; events: string[] }
  /** How many times each event was raised — "the customer is told once" needs a number. */
  | { kind: "emitted_count"; of: Record<string, number> }
  | { kind: "data"; of: Record<string, Record<string, Json>> }
  | { kind: "no_findings"; severities: string[] }
  | { kind: "rejected"; of: Record<string, string> };

export interface Result {
  scenario: Scenario;
  schedule: Schedule;
  world: World;
  failures: string[];
  /** Where its phases began and its set-up ended, in the log — for the sequence (ADR 0022 §4). */
  marks: { phases: { name: string; after: number }[]; setup?: number };
}

function schedule(raw: unknown): Schedule | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "fifo") return { kind: "fifo" };
  if (raw === "duplicate") return { kind: "duplicate" };
  const rec = raw as Record<string, unknown>;
  if (rec.random !== undefined) return { kind: "random", seed: Number(rec.random) };
  throw new Error(`unknown schedule: ${JSON.stringify(raw)} (fifo, duplicate, or { random: <seed> })`);
}

function sends(raw: unknown): { ref: string; payload: Record<string, Json> }[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => {
    if (typeof item === "string") return { ref: item, payload: {} };
    const keys = Object.keys(item as object);
    if (keys.length !== 1) throw new Error("a send names one command: `Order#A1.Place: { ... }`");
    const ref = keys[0]!;
    return { ref, payload: ((item as Record<string, Json>)[ref] ?? {}) as Record<string, Json> };
  });
}

function assertion(raw: Record<string, any>): Assertion {
  // `expect_*` reads better mid-run, `state` reads better in `then`. Same assertion.
  if (raw.expect_state) return { kind: "state", of: raw.expect_state };
  if (raw.expect_in_state) return { kind: "in_state", of: raw.expect_in_state };
  if (raw.state) return { kind: "state", of: raw.state };
  if (raw.in_state) return { kind: "in_state", of: raw.in_state };
  if (raw.not_in_state) return { kind: "not_in_state", of: raw.not_in_state };
  if (raw.emitted) return { kind: "emitted", events: raw.emitted.map(String) };
  if (raw.not_emitted) return { kind: "not_emitted", events: raw.not_emitted.map(String) };
  if (raw.emitted_count) return { kind: "emitted_count", of: raw.emitted_count };
  if (raw.data) return { kind: "data", of: raw.data };
  if (raw.no_findings) return { kind: "no_findings", severities: (raw.no_findings as unknown[]).map(String) };
  if (raw.rejected) return { kind: "rejected", of: raw.rejected };
  throw new Error(`unknown assertion: ${Object.keys(raw).join(", ")}`);
}

function whyOf(v: unknown, file?: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !/^\S+$/.test(x))) {
    throw new Error(`${file ?? "scenario"}: \`why:\` is a list of the ids of the rules it shows, e.g. \`why: [R3]\` (ADR 0016)`);
  }
  return v as string[];
}

/**
 * A file of the scenarios folder by its path there (`given/places.yaml`), or undefined if there is none —
 * the disk's on the command line, the files a folder gave in the browser (ADR 0029).
 */
export type ScenarioFiles = (path: string) => string | undefined;

/** `a/b/../c.yaml` → `a/c.yaml`; a path that leaves the scenarios folder is refused. */
function normalise(path: string, where: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) throw new Error(`${where}: \`${path}\` leaves the scenarios folder — a shared set-up lives in it`);
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

function includeList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((p) => {
    const path = String(p);
    if (!path.endsWith(".yaml")) throw new Error(`${where}: include: \`${path}\` — a shared set-up is a .yaml file`);
    return path;
  });
}

/**
 * The sends of the shared set-ups a scenario includes, in order — each one's own includes first.
 * A set-up holds `send:` and may `include:` others, by path relative to its own folder (ADR 0029).
 */
function includedSends(paths: string[], from: string, where: string, read: ScenarioFiles | undefined, seen: string[]): { ref: string; payload: Record<string, Json> }[] {
  const out: { ref: string; payload: Record<string, Json> }[] = [];
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  for (const p of paths) {
    const path = normalise(dir + p, where);
    if (seen.includes(path)) throw new Error(`${where}: include: ${[...seen, path].join(" → ")} — a set-up that includes itself`);
    if (!read) throw new Error(`${where}: include: \`${path}\` — the scenario was read without its folder's files`);
    const text = read(path);
    if (text === undefined) throw new Error(`${where}: include: no \`${path}\` in the scenarios folder`);
    const raw = (parseYaml(text) ?? {}) as Record<string, unknown>;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: a shared set-up is a mapping of \`include:\` and \`send:\``);
    const extra = Object.keys(raw).filter((k) => k !== "include" && k !== "send");
    if (extra.length) throw new Error(`${path}: ${extra.map((k) => `\`${k}:\``).join(", ")} — a shared set-up holds only \`include:\` and \`send:\``);
    out.push(...includedSends(includeList(raw.include, path), path, path, read, [...seen, path]), ...sends(raw.send));
  }
  return out;
}

export function parseScenario(text: string, file?: string, read?: ScenarioFiles): Scenario {
  const raw = parseYaml(text) as Record<string, any>;
  const given = raw.given ?? {};
  const where = file ?? "scenario";
  const include = includeList(given.include, where);
  return {
    name: String(raw.scenario ?? file ?? "unnamed"),
    file,
    ...(raw.drawing !== undefined ? { drawing: String(raw.drawing) } : {}),
    ...(raw.tags !== undefined ? { tags: (Array.isArray(raw.tags) ? raw.tags : [raw.tags]).map(String) } : {}),
    ...(raw.why !== undefined ? { why: whyOf(raw.why, file) } : {}),
    schedule: schedule(raw.schedule),
    given: {
      at: given.at ? String(given.at) : undefined,
      phase: given.phase === undefined ? undefined : String(given.phase),
      ...(include.length ? { include } : {}),
      send: [...includedSends(include, "", where, read, []), ...sends(given.send)],
    },
    when: ((raw.when ?? []) as Record<string, any>[]).map((item): Step => {
      if (item.phase !== undefined) return { step: "phase", name: String(item.phase) };
      if (item.advance !== undefined) {
        return { step: "advance", ms: parseDuration(String(item.advance)), label: String(item.advance) };
      }
      if (item.send !== undefined) {
        const [one] = sends(item.send);
        return { step: "send", ref: one!.ref, payload: one!.payload };
      }
      return { step: "assert", assertion: assertion(item) };
    }),
    then: ((raw.then ?? []) as Record<string, any>[]).map(assertion),
  };
}

function check(world: World, a: Assertion, where: string, failures: string[]): void {
  const fail = (msg: string) => failures.push(`${where}: ${msg}`);
  switch (a.kind) {
    case "state":
      for (const [key, want] of Object.entries(a.of)) {
        const got = stateOf(world, key);
        if (got !== want) fail(`${key} should be in \`${want}\` but is in \`${got ?? "(no such instance)"}\``);
      }
      return;
    case "in_state":
      for (const [key, want] of Object.entries(a.of)) {
        if (!activeOf(world, key).has(want)) {
          fail(`${key} should have \`${want}\` active; active: ${[...activeOf(world, key)].join(", ") || "(none)"}`);
        }
      }
      return;
    case "not_in_state":
      for (const [key, want] of Object.entries(a.of)) {
        if (activeOf(world, key).has(want)) fail(`${key} should not have \`${want}\` active`);
      }
      return;
    case "emitted": {
      const seen = eventsOf(world).map((e) => e.event);
      for (const want of a.events) if (!seen.includes(want)) fail(`${want} was never raised; raised: ${seen.join(", ")}`);
      return;
    }
    case "not_emitted": {
      const seen = eventsOf(world).map((e) => e.event);
      for (const want of a.events) if (seen.includes(want)) fail(`${want} should not have been raised`);
      return;
    }
    case "emitted_count": {
      const seen = eventsOf(world).map((e) => e.event);
      for (const [event, want] of Object.entries(a.of)) {
        const got = seen.filter((e) => e === event).length;
        if (got !== Number(want)) fail(`${event} should have been raised ${want} time(s) but was raised ${got}`);
      }
      return;
    }
    case "data":
      for (const [key, fields] of Object.entries(a.of)) {
        const inst = world.aggregates[key] ?? world.policies[key];
        if (!inst) { fail(`${key} does not exist`); continue; }
        for (const [field, want] of Object.entries(fields)) {
          const got = inst.data[field];
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            fail(`${key}.${field} should be ${JSON.stringify(want)} but is ${JSON.stringify(got)}`);
          }
        }
      }
      return;
    case "rejected":
      for (const [key, name] of Object.entries(a.of)) {
        const hit = world.log.some((e) => e.kind === "rejected" && e.instance === key && e.name === name);
        if (!hit) fail(`${key} should have refused ${name}, but no rejection was recorded`);
      }
      return;
    case "no_findings": {
      const bad = world.log.filter((e) => e.kind === "finding" && a.severities.includes(e.severity));
      for (const f of bad) if (f.kind === "finding") fail(`unexpected ${f.severity}: ${f.message}`);
      return;
    }
  }
}

export function runScenario(model: Model, scenario: Scenario, override?: Schedule): Result {
  const chosen: Schedule = override ?? scenario.schedule ?? { kind: "fifo" };
  const world = createWorld(model, scenario.given.at ?? "2026-01-01T09:00:00Z", chosen);
  const failures: string[] = [];
  const lastSeq = () => world.log[world.log.length - 1]?.seq ?? 0;
  const marks: Result["marks"] = { phases: scenario.given.phase ? [{ name: scenario.given.phase, after: 0 }] : [] };
  for (const s of scenario.given.send) send(world, s.ref, s.payload);
  if (scenario.given.send.length > 0) marks.setup = lastSeq();
  scenario.when.forEach((step, i) => {
    switch (step.step) {
      case "send": return send(world, step.ref, step.payload);
      case "advance": return advance(world, step.ms);
      case "assert": return check(world, step.assertion, `when[${i}]`, failures);
      case "phase": marks.phases.push({ name: step.name, after: lastSeq() }); return;
    }
  });
  scenario.then.forEach((a, i) => check(world, a, `then[${i}]`, failures));
  return { scenario, schedule: chosen, world, failures, marks };
}

/**
 * The second pass: once a model reads correctly under `fifo`, run it against the schedules
 * the real infrastructure can produce (ADR 0006). Reordering and redelivery only; messages
 * are never lost, so the search stays bounded.
 */
export function realWorldSchedules(seeds = 5): Schedule[] {
  return [
    { kind: "fifo" },
    { kind: "duplicate" },
    ...Array.from({ length: seeds }, (_, i): Schedule => ({ kind: "random", seed: i + 1 })),
  ];
}

export { describeSchedule };
