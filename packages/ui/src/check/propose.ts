/**
 * Proposed scenarios (MC-11): for a drawn arrow `A -> B` that the drawing's own scenarios do not
 * walk, find a run that does — and say what the model did with it.
 *
 * 1. Start from the scenario whose subject (a sample, say) reaches A soonest, cut right after A.
 * 2. Search up to three extra steps that make B the subject's next status:
 *    - an input the scenarios already use that names B (its ids and places taken from this run);
 *    - moving the clock to the next deadline;
 *    - a person's decision on something the previous step opened and left waiting (a command
 *      the scenarios send that kind of instance).
 * 3. Report what moved. B raised with nothing reacting is a gap in the model, not in the scenarios.
 *
 * Nothing here knows a domain: the inputs come from the model's own scenarios, the subjects and
 * statuses from its flow board.
 */
import { stringify } from "yaml";
import type { Json, LogEntry, Model, World } from "@statestorm/kernel";
import { advance, createWorld, fork, send, stateOf } from "@statestorm/kernel";
import type { Scenario } from "@statestorm/scenarios";
import { flowConfig, subjectEvents } from "../flow.ts";
import { overviewConfig } from "../overview.ts";
import { sentByModel } from "./statics.ts";

export type Input =
  | { kind: "send"; ref: string; payload: Record<string, Json> }
  | { kind: "advance"; ms: number; label: string };

export interface Proposal {
  /** What the run left waiting for a person, unanswered by the steps. */
  awaiting: string[];
  from: string;            // event names
  to: string;
  scenario: string;        // the file it starts from
  /** How many of that scenario's `when` steps are kept. */
  keep: number;
  subject: string;         // e.g. Sample#S7
  steps: Input[];
  /** What the proposed steps moved, beyond the subject itself: `Type#id: from → to`. */
  moved: string[];
  /** Final states of what moved, for the proposal's `then:`. */
  states: Record<string, string>;
}

export interface NoProposal { from: string; to: string; reason: string }

const machineOf = (key: string) => key.slice(0, key.indexOf("#"));
const idOf = (key: string) => key.slice(key.indexOf("#") + 1);
const typeOfRef = (ref: string) => ref.slice(0, ref.indexOf("#"));

function startWorld(model: Model, sc: Scenario): World {
  const world = createWorld(model, sc.given.at ?? "2026-01-01T09:00:00Z");
  for (const s of sc.given.send) send(world, s.ref, s.payload);
  return world;
}

function apply(world: World, x: Input | Scenario["when"][number]): void {
  if ("kind" in x) { if (x.kind === "send") send(world, x.ref, x.payload); else advance(world, x.ms); return; }
  if (x.step === "send") send(world, x.ref, x.payload);
  else if (x.step === "advance") advance(world, x.ms);
}

/** The board's view of a model, worked out once per search. */
function boardOf(model: Model) {
  const { config } = overviewConfig(model);
  const { flow } = flowConfig(model);
  /** The subjects' statuses among the log entries from `from` on, in order. */
  return (log: LogEntry[], from = 0) => subjectEvents(model, config, flow, log.slice(from)).events;
}

const follows = (list: string[], a: string, b: string) => {
  for (let i = 1; i < list.length; i++) if (list[i - 1] === a && list[i] === b) return true;
  return false;
};

/** Every input the model's scenarios send, as templates. */
function templatesOf(scenarios: Scenario[]): { ref: string; payload: Record<string, Json> }[] {
  const seen = new Set<string>();
  const out: { ref: string; payload: Record<string, Json> }[] = [];
  for (const sc of scenarios) {
    for (const s of [...sc.given.send, ...sc.when.flatMap((w) => (w.step === "send" ? [{ ref: w.ref, payload: w.payload }] : []))]) {
      const k = `${s.ref.replace(/#[^.]*/, "#")}|${JSON.stringify(s.payload)}`;
      if (!seen.has(k)) { seen.add(k); out.push(s); }
    }
  }
  return out;
}

let fresh = 0;

/** Inputs that might raise `b` for the subject next, given where the world is now. */
function candidates(model: Model, world: World, subject: string, b: string, templates: ReturnType<typeof templatesOf>, opened: string[]): Input[] {
  const out: Input[] = [];
  const seenFor = (field: string) => {
    const vals: string[] = [];
    for (const e of [...world.log].reverse()) {
      if (e.kind !== "event") continue;
      const v = e.payload[field];
      if (typeof v === "string" && (e.instance === subject || Object.values(e.payload).includes(idOf(subject))) && !vals.includes(v)) vals.push(v);
    }
    return vals.slice(0, 3);
  };
  // An input the scenarios use that names b — on this subject, or on an instance of the same type here.
  for (const t of templates) {
    if (!Object.values(t.payload).includes(b)) continue;
    const type = typeOfRef(t.ref);
    const cmd = t.ref.slice(t.ref.lastIndexOf("."));
    const targets = type === machineOf(subject) ? [idOf(subject)]
      : Object.keys(world.aggregates).filter((k) => machineOf(k) === type).map(idOf).slice(0, 3);
    for (const id of targets) {
      // Values from this run first — the place where the subject is — the template's own last.
      const variants: Record<string, Json>[] = [];
      for (const [f, v] of Object.entries(t.payload)) {
        if (typeof v !== "string" || v === b || /id$/i.test(f)) continue;
        for (const alt of seenFor(f)) if (alt !== v) variants.push({ ...t.payload, [f]: alt });
      }
      variants.push({ ...t.payload });
      for (const p of variants) {
        const payload = Object.fromEntries(Object.entries(p).map(([f, v]) => [f, /id$/i.test(f) ? `proposed-${++fresh}` : v]));
        out.push({ kind: "send", ref: `${type}#${id}${cmd}`, payload });
      }
    }
  }
  // The next deadline.
  const due = world.timers.map((t) => t.at).sort((x, y) => x - y)[0];
  if (due !== undefined && due > world.now) {
    const ms = due - world.now;
    const label = ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.ceil(ms / 60_000)}m`;
    out.push({ kind: "advance", ms, label });
  }
  // A person's decision on what the last step opened.
  for (const key of opened) {
    const type = machineOf(key);
    for (const t of templates) {
      if (typeOfRef(t.ref) !== type || model.aggregates[type]?.creators.includes(t.ref.slice(t.ref.lastIndexOf(".") + 1))) continue;
      out.push({ kind: "send", ref: `${key}${t.ref.slice(t.ref.lastIndexOf("."))}`, payload: { ...t.payload } });
    }
  }
  const seen = new Set<string>();
  return out.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** A deadline shared by every search of one check run; `spent` once it has passed. */
export interface Budget { deadline: number; spent?: boolean }

export function propose(model: Model, scenarios: Scenario[], from: string, to: string, prefer: string[] = [], budget?: Budget): Proposal | NoProposal {
  const templates = templatesOf(scenarios);
  const statuses = boardOf(model);
  fresh = 0;                     // ids numbered per proposal: the same gap gives the same file
  const order = [...scenarios].sort((x, y) => {
    const px = prefer.some((p) => (x.file ?? "").startsWith(p)) ? 0 : 1;
    const py = prefer.some((p) => (y.file ?? "").startsWith(p)) ? 0 : 1;
    return px - py || (x.file ?? "").localeCompare(y.file ?? "");
  });
  // The run's budget, and one of this gap's own: ten seconds and 2000 tries, so one gap that
  // cannot be closed does not hold up the rest.
  const ownDeadline = Date.now() + 10_000;
  let tries = 0;
  const over = () => (budget !== undefined && Date.now() > budget.deadline && (budget.spent = true)) || Date.now() > ownDeadline || tries > 2000;
  let starts = 0;
  for (const sc of order) {
    if (over()) break;
    // Run the scenario once, step by step, until some subject's latest status is `from`.
    const world = startWorld(model, sc);
    const latest = new Map<string, string>();
    for (const e of statuses(world.log)) latest.set(e.instance, e.event);
    let keep = -1;
    let subject = "";
    let openedAt = 0;
    for (let k = 0; k <= sc.when.length; k++) {
      const hit = [...latest].find(([, ev]) => ev === from);
      if (hit) { keep = k; subject = hit[0]; break; }
      if (k === sc.when.length) break;
      openedAt = world.log.length;
      apply(world, sc.when[k]!);
      for (const e of statuses(world.log, openedAt)) latest.set(e.instance, e.event);
    }
    if (keep < 0) continue;
    starts++;
    const baseSeq = world.log.length;
    // Breadth first from snapshots (fork), up to three steps; of the shortest that work, the one
    // that moves the most. Only the log written since the snapshot is read.
    let frontier: { steps: Input[]; world: World }[] = [{ steps: [], world }];
    for (let depth = 0; depth < 3 && !over(); depth++) {
      const next: { steps: Input[]; world: World }[] = [];
      let best: Proposal | undefined;
      for (const node of frontier) {
        const opened = node.world.log.slice(openedAt).filter((e) => e.kind === "created").map((e) => (e as { instance: string }).instance);
        for (const c of candidates(model, node.world, subject, to, templates, opened)) {
          if (over()) break;
          tries++;
          const w = fork(node.world);
          apply(w, c);
          const tried = [...node.steps, c];
          const after = statuses(w.log, baseSeq).filter((e) => e.instance === subject).map((e) => e.event);
          // Raised by the subject but placed nowhere on the board — nothing reacted to it here:
          // that is the answer too ("nothing reacts"), not a reason to search on.
          const raised = w.log.slice(baseSeq).find((e) => e.kind === "event" && e.instance === subject);
          const unplaced = after.length === 0 && raised?.kind === "event" && raised.event === to;
          if (unplaced || follows([from, ...after], from, to)) {
            const p = describe(model, sc, keep, subject, tried, w, baseSeq, from, to, openedAt);
            if (!best || p.moved.length > best.moved.length) best = p;
          } else next.push({ steps: tried, world: w });
        }
      }
      if (best) return best;
      frontier = next.slice(0, 60);
    }
  }
  return {
    from, to,
    reason: budget?.spent ? "the time budget ran out before a proposal was found"
      : tries > 2000 || Date.now() > ownDeadline ? "searched 2000 steps (or ten seconds) without one — needs a step the model does not offer, or a new journey"
      : starts === 0
      ? `no scenario brings anything to ${from} — needs a new journey`
      : `from ${from}, no input the scenarios use (within three steps) makes ${to} come next — needs a step the model does not offer, or a new journey`,
  };
}

function describe(model: Model, sc: Scenario, keep: number, subject: string, steps: Input[], w: World, baseSeq: number, from: string, to: string, openedAt: number): Proposal {
  const firstFrom = new Map<string, string>();
  const lastTo = new Map<string, string>();
  for (const e of w.log.slice(baseSeq)) {
    if (e.kind !== "transition" || e.internal || !model.aggregates[machineOf(e.instance)]) continue;
    if (!firstFrom.has(e.instance)) firstFrom.set(e.instance, e.from);
    lastTo.set(e.instance, e.to);
  }
  const moved = [...lastTo].filter(([k]) => k !== subject).map(([k, v]) => `${k}: ${firstFrom.get(k)} → ${v}`);
  const states = Object.fromEntries([...lastTo].filter(([k]) => k !== subject).slice(0, 8));
  // Opened by the run, still in their first state, and that state answers a command the model never
  // sends itself: waiting for a person (a deviation to confirm or resolve).
  const sentHere = sentByModel(model);
  const waitsForPerson = (k: string) => {
    let states = model.aggregates[machineOf(k)]?.states;
    for (const name of (stateOf(w, k) ?? "").split(".")) {
      const st = states?.[name];
      if (!st) return false;
      if (Object.keys(st.on).some((cmd) => !sentHere.has(cmd.split("#")[0]!))) return true;
      states = st.states;
    }
    return false;
  };
  const awaiting = w.log.slice(openedAt).filter((e) => e.kind === "created").map((e) => (e as { instance: string }).instance)
    .filter((k) => !lastTo.has(k) && !steps.some((x) => x.kind === "send" && x.ref.startsWith(`${k}.`)))
    .filter((k) => model.aggregates[machineOf(k)]?.role === "aggregate" && waitsForPerson(k));
  return { from, to, scenario: sc.file ?? "", keep, subject, steps, moved, states, awaiting };
}

// ---------------------------------------------------------------- the file

const flow = (v: Json) => stringify(v, { collectionStyle: "flow", lineWidth: 0 }).trim();

/** The proposal as a scenario file: the original's start, the found steps, what they did. */
export function proposalYaml(p: Proposal, raw: Record<string, unknown>, drawing: string, labels: { from: string; to: string }): string {
  const given = (raw.given ?? {}) as Record<string, unknown>;
  const when = ((raw.when ?? []) as Record<string, Json>[]).slice(0, p.keep);
  const lines: string[] = [];
  const quiet = p.moved.length === 0;
  lines.push(
    `# PROPOSED by the model check (MC-11) — not part of the suite until a person keeps it.`,
    `# Gap: "${labels.from} -> ${labels.to}" in ${drawing}, never walked by its scenarios.`,
    `# Starts from ${p.scenario} (its first ${p.keep} steps, where ${p.subject} reaches ${p.from}), then ${p.steps.length} step(s).`,
    quiet
      ? `# What the model did: NOTHING beyond ${p.subject} raising ${p.to} — no step reacts to it here. A gap in the model, not only in the scenarios.`
      : `# What the model did: ${p.moved.slice(0, 6).join("; ")}${p.moved.length > 6 ? "; …" : ""}`,
    ...(p.awaiting.length ? [`# Left waiting for a person: ${p.awaiting.join(", ")} — add the decision if the story needs it.`] : []),
    `# Whether that is right is the domain owner's call; correct it, give it a name, then keep it.`,
    `scenario: "proposed — ${labels.from}, then ${labels.to} (${p.subject.slice(p.subject.indexOf("#") + 1)}, from ${p.scenario.replace(/\.yaml$/, "")})"`,
    `given:`,
  );
  if (given.at !== undefined) lines.push(`  at: ${String(given.at)}`);
  if (given.phase !== undefined) lines.push(`  phase: ${String(given.phase)}`);
  lines.push(`  send:`);
  const entry = (item: Record<string, Json>) => {
    const keys = Object.keys(item);
    return keys.length === 1 ? `${keys[0]}: ${flow(item[keys[0]!]!)}` : flow(item);
  };
  for (const item of (given.send ?? []) as Record<string, Json>[]) lines.push(`    - ${entry(item)}`);
  lines.push(`when:`);
  for (const item of when) lines.push(`  - ${entry(item)}`);
  lines.push(`  - phase: Proposed — ${labels.from}, then ${labels.to}`);
  for (const s of p.steps) {
    lines.push(s.kind === "send" ? `  - send: ${flow({ [s.ref]: s.payload })}` : `  - advance: ${s.label}`);
  }
  lines.push(`then:`, `  - emitted: [${p.to}]`);
  if (Object.keys(p.states).length) {
    lines.push(`  - in_state:`);
    for (const [k, v] of Object.entries(p.states)) lines.push(`      ${k}: ${v}`);
  }
  lines.push(`  - no_findings: [error]`, ``);
  return lines.join("\n");
}
