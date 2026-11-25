/**
 * Drawn flows as data (MC-12): the business's own drawings — lanes, the paths their legend names,
 * every arrow with a decision — compared with what the scenarios show on the flow board.
 *
 *   lanes:   lane -> the boxes drawn in it, in the drawing's words (`Name @ Lane` if in two lanes)
 *   outside: triggers drawn on the page that are not statuses (Cancelled order, Parcel flow)
 *   names:   the drawing's word -> the model's status, where they differ
 *   paths:   path -> { colour, meaning, later | open | no } — a decision for all its arrows
 *   arrows:  `A -> B`, or `A -> B: { path, later | open | no }`; no decision = in the model
 *   paths.<name>.scenarios: the scenarios that show a path drawn on many drawings (a referral,
 *            a cancelled request), by file-name prefix: `45`. The rest of the drawing is compared
 *            with the scenarios that name it as theirs — `drawing:` in the scenario (MC-14) — and
 *            with those runs only: the same arrow in another flow does not count for this one.
 *   unmodelled: box -> why — a status the drawing has and the model does not (yet); its arrows
 *            need a decision other than "in the model"
 *   customer: { notice: <event the model raises when the customer is told>, boxes: [...] } — the
 *            boxes the drawing marks as telling the customer, compared with the runs
 */
import { parse as parseYaml } from "yaml";
import { isA, type LogEntry, type Model } from "@statestorm/kernel";
import { eventNames, globMatch } from "../overview.ts";
import type { FlowGraph } from "../flow.ts";

export type Decision =
  | { kind: "model" }
  | { kind: "later" | "open" | "no"; why: string };

export interface DrawnArrow {
  from: string;            // the drawing's words
  to: string;
  fromEvent?: string;      // the model's status; undefined for an outside trigger
  toEvent?: string;
  path: string;
  decision: Decision;
}

export interface Drawing {
  file: string;
  title: string;
  /** Scenario file-name prefixes that walk the drawing; undefined: every scenario; []: none. */
  scenarios?: string[];
  /** Boxes the drawing marks as telling the customer, and the event that says the model did. */
  customer?: { notice: string; events: string[] };
  /** box (drawing's words, without `@ Lane`) per lane, with the model status it stands for. */
  boxes: { label: string; lane: string; event: string }[];
  outside: string[];
  paths: Record<string, { colour: string; meaning: string; decision: Decision; scenarios: string[] }>;
  arrows: DrawnArrow[];
  errors: string[];
}

const DECISIONS = ["later", "open", "no"] as const;

function decisionOf(rec: Record<string, unknown> | undefined): Decision | undefined {
  if (!rec) return undefined;
  for (const k of DECISIONS) if (rec[k] !== undefined) return { kind: k, why: String(rec[k]) };
  return undefined;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A scenario's file-name prefix. YAML reads `[06, 09]` as numbers — 6 and 9 — which no file name
 *  (`06-…`, `09-…`) starts with: a bare number is given back its two digits. */
const prefixOf = (v: unknown): string => (typeof v === "number" && Number.isInteger(v) ? String(v).padStart(2, "0") : String(v));

export function parseDrawing(model: Model, text: string, file: string): Drawing {
  const raw = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const known = eventNames(model);
  const byShape = new Map(known.map((e) => [squash(e), e]));
  const names = (raw.names ?? {}) as Record<string, string>;
  for (const [word, event] of Object.entries(names)) {
    if (!known.includes(String(event))) errors.push(`${file}: names: \`${word}\` maps to ${event}, which the model never raises`);
  }
  const unmodelled = Object.fromEntries(Object.entries((raw.unmodelled ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  const eventOf = (label: string) => names[label] ?? byShape.get(squash(label));

  // Boxes: `Name @ Lane` is how a box drawn in two lanes is told apart; its label is the name.
  const boxes: Drawing["boxes"] = [];
  const keyOf = new Map<string, { label: string; lane: string; event: string }>();
  for (const [lane, list] of Object.entries((raw.lanes ?? {}) as Record<string, unknown[]>)) {
    for (const item of list ?? []) {
      const key = String(item).trim();
      const label = key.includes(" @ ") ? key.slice(0, key.indexOf(" @ ")).trim() : key;
      const event = eventOf(label) ?? eventOf(key) ?? (unmodelled[label] !== undefined || unmodelled[key] !== undefined ? "" : undefined);
      if (event === undefined) { errors.push(`${file}: \`${key}\` (lane ${lane}) is no status of the model — add it to names:, or to unmodelled: with why`); continue; }
      if (keyOf.has(key)) { errors.push(`${file}: \`${key}\` is drawn in two lanes — write it as \`${label} @ <lane>\``); continue; }
      const box = { label, lane, event };
      boxes.push(box);
      keyOf.set(key, box);
    }
  }
  const outside = ((raw.outside ?? []) as unknown[]).map(String);

  const paths: Drawing["paths"] = {};
  for (const [name, spec] of Object.entries((raw.paths ?? { main: {} }) as Record<string, Record<string, unknown>>)) {
    paths[name] = {
      colour: String(spec?.colour ?? ""), meaning: String(spec?.meaning ?? name), decision: decisionOf(spec) ?? { kind: "model" },
      scenarios: ((spec?.scenarios ?? []) as unknown[]).map(prefixOf),
    };
  }
  if (!paths.main) paths.main = { colour: "black", meaning: "main", decision: { kind: "model" }, scenarios: [] };

  const arrows: DrawnArrow[] = [];
  for (const item of (raw.arrows ?? []) as unknown[]) {
    const [text, opts] = typeof item === "string" ? [item, undefined]
      : Object.entries(item as Record<string, Record<string, unknown>>)[0] ?? ["", undefined];
    const m = /^(.+?)\s*->\s*(.+)$/.exec(String(text));
    if (!m) { errors.push(`${file}: \`${text}\` is not an arrow — write \`A -> B\``); continue; }
    const [from, to] = [m[1]!.trim(), m[2]!.trim()];
    const path = String(opts?.path ?? "main");
    if (!paths[path]) errors.push(`${file}: \`${from} -> ${to}\` is on path \`${path}\`, which paths: does not name`);
    const end = (name: string): string | undefined | null => {
      if (outside.includes(name)) return undefined;
      const box = keyOf.get(name);
      if (box) return box.event || undefined;          // an unmodelled box: no status
      errors.push(`${file}: \`${from} -> ${to}\` — \`${name}\` is in no lane and not outside:`);
      return null;
    };
    const [fe, te] = [end(from), end(to)];
    if (fe === null || te === null) continue;
    const decision = decisionOf(opts) ?? paths[path]?.decision ?? { kind: "model" as const };
    if (decision.kind === "model" && (fe === undefined || te === undefined)) {
      errors.push(`${file}: \`${from} -> ${to}\` starts or ends outside the model's statuses — give it (or its path) a decision`);
    }
    arrows.push({ from, to, ...(fe ? { fromEvent: fe } : {}), ...(te ? { toEvent: te } : {}), path, decision });
  }
  // Which scenarios walk a drawing is said once, by the scenario (MC-14): `assignScenarios`.
  if (raw.scenarios !== undefined) errors.push(`${file}: scenarios: — a scenario names its drawing now (\`drawing:\` in the scenario file)`);
  const scenarios = undefined;
  const cust = raw.customer as { notice?: unknown; boxes?: unknown[] } | undefined;
  let customer: Drawing["customer"];
  if (cust) {
    const events = (cust.boxes ?? []).map(String).flatMap((b) => {
      const box = keyOf.get(b);
      if (!box) { errors.push(`${file}: customer: \`${b}\` is in no lane`); return []; }
      return box.event ? [box.event] : [];
    });
    customer = { notice: String(cust.notice ?? ""), events };
    if (!known.includes(customer.notice)) errors.push(`${file}: customer.notice \`${customer.notice}\` — the model never raises it`);
  }
  return { file, title: String(raw.drawing ?? file), ...(scenarios ? { scenarios } : {}), ...(customer ? { customer } : {}), boxes: boxes.filter((b) => b.event), outside, paths, arrows, errors };
}

// ---------------------------------------------------------------- whose scenarios (MC-14)

/** A scenario and the drawing it names as its own. */
export interface Walker { file: string; drawing?: string; tags?: string[] }

/** Every scenario is one kind: the journey as it should go, or a deviation from it. */
export const KINDS = ["happy", "deviation"] as const;

/**
 * Tags (MC-15): each scenario is `happy` or `deviation`, and every drawing's scenarios include a
 * happy path — the drawing's main flow, walked once without trouble.
 */
export function tagFindings(drawings: Drawing[], walkers: Walker[]): string[] {
  const out: string[] = [];
  for (const w of walkers) {
    const kinds = (w.tags ?? []).filter((t) => (KINDS as readonly string[]).includes(t));
    if (kinds.length !== 1) out.push(`${stemOf(w.file)}: tag it ${KINDS.join(" or ")} — ${kinds.length ? "not both" : "it has neither"}`);
  }
  for (const d of drawings) {
    const mine = walkers.filter((w) => w.drawing === stemOf(d.file));
    if (mine.length && !mine.some((w) => w.tags?.includes("happy"))) out.push(`${d.file}: no happy path among its ${mine.length} scenario${mine.length === 1 ? "" : "s"}`);
  }
  return out;
}

const stemOf = (file: string) => file.replace(/\.yaml$/, "");

/**
 * Each scenario walks one drawing, which it names (`drawing:`): the drawing's scenarios are
 * those. A name that is no drawing is an error; a scenario that names none is said.
 */
export function assignScenarios(drawings: Drawing[], walkers: Walker[]): { errors: string[]; none: string[] } {
  const errors: string[] = [];
  const known = new Set(drawings.map((d) => stemOf(d.file)));
  for (const w of walkers) if (w.drawing !== undefined && !known.has(w.drawing)) errors.push(`${w.file}: drawing \`${w.drawing}\` — there is no such drawing`);
  for (const d of drawings) d.scenarios = walkers.filter((w) => w.drawing === stemOf(d.file)).map((w) => stemOf(w.file));
  return { errors, none: walkers.filter((w) => w.drawing === undefined).map((w) => stemOf(w.file)) };
}

/** An arrow a drawing's own scenarios walk that the drawing does not draw (MC-14). */
export interface OffDrawing { from: string; to: string; scenarios: string[]; elsewhere: string[]; raised: string[] }

/**
 * Per drawing: every arrow its scenarios walk that it does not draw (under any decision) — on
 * another drawing, or on none. `pairsOf` gives a scenario's arrows as `From To` statuses.
 */
export function offDrawing(drawings: Drawing[], walkers: Walker[], pairsOf: (file: string) => Set<string>, issues: DrawingIssue[] = []): Map<string, OffDrawing[]> {
  const drawnBy = (d: Drawing) => new Set(d.arrows.filter((a) => a.fromEvent && a.toEvent).map((a) => `${a.fromEvent} ${a.toEvent}`));
  const drawn = new Map(drawings.map((d) => [stemOf(d.file), drawnBy(d)]));
  const out = new Map<string, OffDrawing[]>();
  for (const d of drawings) {
    const stem = stemOf(d.file);
    const own = drawn.get(stem)!;
    const found = new Map<string, OffDrawing>();
    for (const w of walkers.filter((x) => x.drawing === stem)) {
      for (const pair of pairsOf(w.file)) {
        if (own.has(pair)) continue;
        const [from, to] = pair.split(" ") as [string, string];
        const hit = found.get(pair) ?? {
          from, to, scenarios: [], elsewhere: [...drawn].filter(([k, v]) => k !== stem && v.has(pair)).map(([k]) => k),
          raised: issues.filter((i) => i.status !== "done" && i.arrows.includes(pair) && (i.drawings.includes(stem) || i.drawings.includes("all"))).map((i) => i.id),
        };
        hit.scenarios.push(stemOf(w.file));
        found.set(pair, hit);
      }
    }
    out.set(stem, [...found.values()].sort((a, b) => b.scenarios.length - a.scenarios.length || a.from.localeCompare(b.from)));
  }
  return out;
}

// ---------------------------------------------------------------- the comparison

export interface DrawingReport {
  drawing: Drawing;
  /** In the model by decision, but no scenario shows it: a gap (MC-11 proposes the scenario). */
  missing: DrawnArrow[];
  /** Decided later / open / no — and yet the scenarios show it. */
  shownAnyway: DrawnArrow[];
  /** A box drawn in a lane the board never puts that status in. */
  lanes: { label: string; drawn: string; board: string[] }[];
  /** Customer communication: marked but never told in the runs, and told but not marked. */
  customer?: { markedNotTold: string[]; toldNotMarked: string[] };
  counts: Record<"shown" | "missing" | "later" | "open" | "no", number>;
}

export interface DrawingsReport {
  drawings: DrawingReport[];
  /** Arrows the scenarios show between statuses some drawing has — that no drawing draws. */
  undrawn: { from: string; to: string; count: number }[];
}

const evOf = (id: string) => id.slice(0, id.lastIndexOf("@"));

function shownIn(graph: FlowGraph) {
  const shown = new Map<string, number>();
  for (const e of graph.edges) {
    const k = `${evOf(e.from)} ${evOf(e.to)}`;
    shown.set(k, (shown.get(k) ?? 0) + e.count);
  }
  const lanesOf = new Map<string, Set<string>>();
  for (const n of graph.nodes) (lanesOf.get(n.event) ?? lanesOf.set(n.event, new Set()).get(n.event)!).add(n.lane);
  return { shown, lanesOf };
}

/**
 * `graphOf` gives the board for a set of scenario prefixes (empty: all) — a drawing, and each of
 * its paths, is compared with the scenarios that walk it.
 */
export function compareDrawings(drawings: Drawing[], graphOf: (scenarios?: string[]) => FlowGraph,
  toldOf?: (scenarios: string[] | undefined, notice: string) => Set<string>): DrawingsReport {
  const { shown: shownAll } = shownIn(graphOf(undefined));
  const reports = drawings.map((d): DrawingReport => {
    const own = shownIn(graphOf(d.scenarios));
    const byPath = new Map(Object.entries(d.paths).map(([name, p]) => [name, p.scenarios.length ? shownIn(graphOf(p.scenarios)).shown : own.shown]));
    const lanesOf = own.lanesOf;
    const counts = { shown: 0, missing: 0, later: 0, open: 0, no: 0 };
    const missing: DrawnArrow[] = [];
    const shownAnyway: DrawnArrow[] = [];
    for (const a of d.arrows) {
      const shown = byPath.get(a.path) ?? own.shown;
      const on = !!a.fromEvent && !!a.toEvent && shown.has(`${a.fromEvent} ${a.toEvent}`);
      if (a.decision.kind === "model") {
        if (on) counts.shown++;
        else { counts.missing++; missing.push(a); }
      } else {
        counts[a.decision.kind]++;
        // A path's arrow that the main flow shows (drawn black, and again in a path's colour)
        // is not news; only an arrow drawn on no other path, shown anyway, is.
        const alsoModel = d.arrows.some((b) => b !== a && b.from === a.from && b.to === a.to && b.decision.kind === "model");
        if (on && !alsoModel) shownAnyway.push(a);
      }
    }
    const lanes = d.boxes
      .filter((b) => lanesOf.has(b.event) && !lanesOf.get(b.event)!.has(b.lane))
      .map((b) => ({ label: b.label, drawn: b.lane, board: [...lanesOf.get(b.event)!].sort() }));
    let customer: DrawingReport["customer"];
    if (d.customer && toldOf) {
      const told = toldOf(d.scenarios, d.customer.notice);
      const drawn = new Set(d.boxes.map((b) => b.event));
      customer = {
        markedNotTold: d.customer.events.filter((e) => !told.has(e)),
        toldNotMarked: [...told].filter((e) => drawn.has(e) && !d.customer!.events.includes(e)).sort(),
      };
    }
    return { drawing: d, missing, shownAnyway, lanes, counts, ...(customer ? { customer } : {}) };
  });

  const drawnEvents = new Set(drawings.flatMap((d) => d.boxes.map((b) => b.event)));
  const drawnPairs = new Set(drawings.flatMap((d) => d.arrows.filter((a) => a.fromEvent && a.toEvent).map((a) => `${a.fromEvent} ${a.toEvent}`)));
  const undrawn = [...shownAll]
    .map(([k, count]) => { const [from, to] = k.split(" ") as [string, string]; return { from, to, count }; })
    .filter((e) => drawnEvents.has(e.from) && drawnEvents.has(e.to) && !drawnPairs.has(`${e.from} ${e.to}`))
    .sort((a, b) => b.count - a.count);
  return { drawings: reports, undrawn };
}

// ---------------------------------------------------------------- changes to the drawings

/** A change to the drawings, agreed (or still open) while scrutinising the model. */
export interface DrawingIssue {
  id: string;
  drawings: string[];
  says: string;
  should: string;
  why: string;
  status: "open" | "to confirm" | "confirmed" | "done";
  /** The arrows it raises, as `From To` model statuses (MC-14): walked, not drawn, and raised. */
  arrows: string[];
}

const STATUSES = ["open", "to confirm", "confirmed", "done"] as const;

export function parseIssues(text: string, file: string, drawingFiles: string[], statuses?: string[]): { issues: DrawingIssue[]; errors: string[] } {
  const raw = (parseYaml(text) ?? {}) as { issues?: Record<string, unknown>[] };
  const errors: string[] = [];
  const known = new Set(drawingFiles.map((f) => f.replace(/\.yaml$/, "")));
  const issues = (raw.issues ?? []).map((r): DrawingIssue => {
    const id = String(r.id ?? "?");
    const status = String(r.status ?? "open") as DrawingIssue["status"];
    if (!STATUSES.includes(status)) errors.push(`${file}: ${id} — status \`${status}\` (expected ${STATUSES.join(", ")})`);
    const drawings = ((r.drawings ?? []) as unknown[]).map(String);
    for (const d of drawings) if (d !== "all" && d !== "scenario slides" && !known.has(d)) errors.push(`${file}: ${id} — no drawing called \`${d}\``);
    for (const k of ["says", "should"]) if (!r[k]) errors.push(`${file}: ${id} — says what \`${k}\`?`);
    const arrows = ((r.arrows ?? []) as unknown[]).flatMap((a) => {
      const m = /^\s*(\w+)\s*->\s*(\w+)\s*$/.exec(String(a));
      if (!m) { errors.push(`${file}: ${id} — \`${String(a)}\` is not an arrow: write \`From -> To\` in the model's statuses`); return []; }
      for (const e of [m[1]!, m[2]!]) if (statuses && !statuses.includes(e)) errors.push(`${file}: ${id} — \`${e}\` is no status of the model`);
      return [`${m[1]} ${m[2]}`];
    });
    return { id, drawings, says: String(r.says ?? ""), should: String(r.should ?? ""), why: String(r.why ?? ""), status, arrows };
  });
  const ids = issues.map((i) => i.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`${file}: ${id} is used twice`);
  return { issues, errors };
}

/** The list to take to the stakeholders, as Markdown: per status, then per issue. */
export function issuesMarkdown(issues: DrawingIssue[], titles: Record<string, string>): string {
  const lines: string[] = ["# Changes to the drawings", ""];
  for (const status of STATUSES) {
    const list = issues.filter((i) => i.status === status);
    if (!list.length) continue;
    lines.push(`## ${status[0]!.toUpperCase()}${status.slice(1)} (${list.length})`, "");
    for (const i of list) {
      const where = i.drawings.map((d) => titles[d] ?? d).join("; ");
      lines.push(`- **${i.id}** — ${where}`, `  - *Now:* ${i.says}`, `  - *Should:* ${i.should}`, ...(i.why ? [`  - *Why:* ${i.why}`] : []), "");
    }
  }
  return lines.join("\n");
}

/**
 * The statuses that led to telling the customer in one run: from each `notice` event, up its causes to
 * the nearest status of a subject. An event that names a status — a deviation confirmed, carrying the
 * status it reported — tells for that status: the person's confirmation is not the reason. A subject's
 * own event that the overview hides is its plumbing, not a status (the subject telling every step,
 * ADR 0035): it tells for the status it names, or the walk goes on past it.
 */
export function statusesTold(model: Model, log: LogEntry[], notice: string, subjectTypes: string[], statuses: Set<string>, hidden: string[]): Set<string> {
  const told = new Set<string>();
  const bySeq = new Map(log.map((e) => [e.seq, e]));
  for (const e of log) {
    if (e.kind !== "event" || e.event !== notice) continue;
    for (let at = e.cause, hops = 0; at > 0 && hops < 60; hops++) {
      const c = bySeq.get(at);
      if (!c) break;
      const plumbing = c.kind === "event" && hidden.some((p) => globMatch(p, c.event));
      if (c.kind === "event" && !plumbing && subjectTypes.some((t) => isA(model, c.instance.slice(0, c.instance.indexOf("#")), t))) { told.add(c.event); break; }
      const named = c.kind === "event" ? Object.values(c.payload).find((v) => typeof v === "string" && statuses.has(v)) : undefined;
      if (typeof named === "string") { told.add(named); break; }
      at = c.cause;
    }
  }
  return told;
}
