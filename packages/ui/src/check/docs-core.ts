/**
 * A domain's docs (ADR 0016), as anything may read them — the workbench in a browser included: their
 * shapes, read from files by path, and traced against the model, the scenarios and the drawing issues.
 * Reading them from a folder, and checking them against the schemas, is `docs.ts`.
 */
import { parse as parseYaml } from "yaml";
import type { MachineDef, Model, StateDef, TransitionDef } from "@statestorm/kernel";
import { REFERENCE } from "../groups.ts";
import { eventNames } from "../overview.ts";

export const SCHEMA_NAMES = ["rules", "glossary", "questions", "profile", "vocabulary"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];
type Json = Record<string, any>;

export interface Rule {
  id: string;
  title: string;
  kind: "definitional" | "behavioural" | "table";
  status: "agreed" | "to-confirm" | "deferred" | "superseded";
  text: string;
  table?: { columns: string[]; rows: (string | number | boolean)[][] };
  refines?: string[];
  revises?: string[];
  supersedes?: string[];
  decided?: { session?: number; date: string; questions?: string[] };
  untraced?: string;
  /** The topic file it is in, without `.yaml`. */
  topic: string;
  /** The profile's fields, as written. */
  [field: string]: unknown;
}
export interface Topic { file: string; title: string; canvas?: { purpose?: string; packages?: string[]; types?: string[] }; rules: Rule[] }
export interface Term { term: string; definition: string; aka?: string[]; avoid?: { word: string; why: string }[]; model?: string[]; [field: string]: unknown }
export interface Question {
  id: string; question: string; leaning: string; status: "open" | "answered" | "withdrawn";
  options?: { option: string; consequence: string }[]; about?: string[];
  asked: { session?: number; date: string }; answer?: string; answered?: { session?: number; date: string }; answeredBy?: string[];
  [field: string]: unknown;
}
export interface ProfileField { description: string; type?: "string" | "number" | "boolean"; list?: boolean; enum?: unknown[]; vocabulary?: string; required?: boolean }
export interface Profile {
  fields?: { rule?: Record<string, ProfileField>; term?: Record<string, ProfileField>; question?: Record<string, ProfileField> };
  external?: Record<string, { title: string; url?: string }>;
  topics?: string[];
}
/** The docs as read: what the check, the rulebook and the workbench all start from. */
export interface DocsRead {
  profile: Profile;
  topics: Topic[];
  glossary?: Term[];
  questions: Question[];
  /** Session number → its log's file name, from docs/decisions/NN-<date>-<what>.md. */
  sessions: Map<number, string>;
  /** Each session's log, by its file name — the text, for whoever shows it. */
  logs: Record<string, string>;
  errors: string[];
}

/** What reading may ask of whoever reads: the profile, checked; each file, checked against its schema. */
export interface ReadHooks {
  /** The profile as read (undefined: there is none) — the one to use, and what is wrong with it. */
  profile?: (data: unknown) => { profile: Profile; errors: string[] };
  /** What is wrong with a file's data, against its schema: nothing, it is valid. */
  check?: (name: SchemaName, file: string, data: unknown) => string[];
}

/**
 * The docs from their files, by path under docs/ — `rules/<topic>.yaml`, `glossary.yaml`,
 * `questions.yaml`, `profile.yaml`, `decisions/NN-<date>-<what>.md`. Nothing is required; with
 * hooks, what is there is checked.
 */
export function docsFromFiles(files: Record<string, string>, hooks: ReadHooks = {}): DocsRead {
  const errors: string[] = [];
  const read = (file: string): unknown => {
    try { return parseYaml(files[file]!); } catch (e) { errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`); return undefined; }
  };
  const check = (name: SchemaName, file: string, data: unknown) => {
    const wrong = hooks.check ? hooks.check(name, file, data) : [];
    errors.push(...wrong);
    return wrong.length === 0;
  };
  const profileData = files["profile.yaml"] !== undefined ? read("profile.yaml") : undefined;
  let profile: Profile = (profileData as Profile | undefined) ?? {};
  if (hooks.profile) { const p = hooks.profile(profileData); profile = p.profile; errors.push(...p.errors); }

  // A file that does not match its schema is said once; what in it has an id is still read, so
  // the references to it are not each said again as dangling.
  const withIds = <T>(list: unknown): T[] => (Array.isArray(list) ? list.filter((x) => typeof x?.id === "string") : []);
  const topics: Topic[] = [];
  for (const path of Object.keys(files).filter((f) => /^rules\/[^/]+\.yaml$/.test(f)).sort()) {
    const data = read(path) as Json | undefined;
    if (data === undefined) continue;
    check("rules", path, data);
    const file = path.slice("rules/".length).replace(/\.yaml$/, "");
    topics.push({ title: String(data.title ?? file), ...(data.canvas ? { canvas: data.canvas } : {}), file, rules: withIds<Rule>(data.rules).map((r) => ({ ...r, topic: file })) });
  }
  const order = profile.topics ?? [];
  for (const t of order) if (!topics.some((x) => x.file === t)) errors.push(`profile.yaml: topics names \`${t}\`, and there is no rules/${t}.yaml`);
  const rank = (t: Topic) => (order.includes(t.file) ? order.indexOf(t.file) : order.length);
  topics.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));

  let glossary: Term[] | undefined;
  if (files["glossary.yaml"] !== undefined) {
    const data = read("glossary.yaml");
    if (data !== undefined && check("glossary", "glossary.yaml", data)) glossary = (data as { terms: Term[] }).terms;
  }
  let questions: Question[] = [];
  if (files["questions.yaml"] !== undefined) {
    const data = read("questions.yaml") as Json | undefined;
    if (data !== undefined) { check("questions", "questions.yaml", data); questions = withIds<Question>(data.questions); }
  }
  const sessions = new Map<number, string>();
  const logs: Record<string, string> = {};
  for (const path of Object.keys(files).filter((f) => /^decisions\/[^/]+\.md$/.test(f)).sort()) {
    const f = path.slice("decisions/".length);
    const n = /^(\d+)-/.exec(f);
    if (!n) { errors.push(`decisions/${f}: a log is named NN-<date>-<what>.md, its session's number first`); continue; }
    if (sessions.has(Number(n[1]))) { errors.push(`decisions/${f}: session ${Number(n[1])} has a log already, ${sessions.get(Number(n[1]))}`); continue; }
    sessions.set(Number(n[1]), f);
    logs[f] = files[path]!;
  }
  return { profile, topics, ...(glossary ? { glossary } : {}), questions, sessions, logs, errors };
}

// ---------------------------------------------------------------- tracing (ADR 0016 §10)

export interface Finding { severity: "error" | "warning" | "info"; message: string }
export interface Cited {
  /** Where the model cites it: `Type`, `Type.state`, `Type.state on Command`, `package P`. */
  model: string[];
  /** The scenarios that cite it, by file name without `.yaml`. */
  scenarios: string[];
  /** The drawing issues whose `why` names it. */
  issues: string[];
  /** Model lines where a comment names it, and no `why:` does. */
  comments: string[];
}
export interface Trace {
  /** Every id the domain defines, and what it is. */
  ids: Map<string, { kind: "rule" | "question" | "issue"; rule?: Rule; question?: Question }>;
  cited: Map<string, Cited>;
  /** Derived back-links: rule → the newer rules that refine, revise or supersede it. */
  changedBy: Map<string, { how: "refines" | "revises" | "supersedes"; by: string }[]>;
  findings: Finding[];
}

export interface TraceInput {
  docs: DocsRead;
  model: Model;
  /** The model's files by path — `model.yaml` and the parts it includes (ADR 0019). */
  modelTexts: Record<string, string>;
  scenarios: { file?: string; why?: string[] }[];
  issues: { id: string; why?: string }[];
}

/** What `modelCitations` calls a part of the systems declaration (ADR 0018, ADR 0020). */
const PLACEMENT = /^(system|sub-system|context|domain|relation) /;

/** The model elements that carry `why:` — declared there, not inherited (ADR 0016 §6). */
export function modelCitations(model: Model): { where: string; why: string[] }[] {
  const out: { where: string; why: string[] }[] = [];
  const rule = (t: TransitionDef) => { if (t.why && !t.inheritedFrom) out.push({ where: t.id, why: t.why }); };
  const walk = (m: MachineDef, states: Record<string, StateDef>) => {
    for (const s of Object.values(states)) {
      if (s.why) out.push({ where: `${m.name}.${s.path.join(".")}`, why: s.why });
      for (const list of Object.values(s.on)) list.forEach(rule);
      s.onChildren.forEach((c) => rule(c.transition));
      if (s.onDone) rule(s.onDone);
      s.after.forEach((a) => rule(a.transition));
      walk(m, s.states);
    }
  };
  for (const p of model.packages) if (p.why) out.push({ where: `package ${p.name}`, why: p.why });
  // The systems and what groups them (ADR 0018, ADR 0020) cite rules too: where a part runs is a decision.
  const sys = model.systems;
  if (sys) {
    for (const s of sys.systems) if (s.why) out.push({ where: `system ${s.name}`, why: s.why });
    for (const s of sys.subsystems) if (s.why && s.name !== s.system) out.push({ where: `sub-system ${s.system}.${s.name}`, why: s.why });
    for (const c of sys.contexts) if (c.why) out.push({ where: `context ${c.name}`, why: c.why });
    for (const d of sys.domains) if (d.why) out.push({ where: `domain ${d.name}`, why: d.why });
    for (const r of sys.relations) if (r.why) out.push({ where: `relation ${r.upstream} → ${r.downstream}`, why: r.why });
  }
  for (const m of [...Object.values(model.aggregates), ...Object.values(model.policies)]) {
    if (m.why) out.push({ where: m.name, why: m.why });
    walk(m, m.states);
  }
  return out;
}

/** The words in a piece of prose that could be ids. */
const words = (text: string) => text.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [];

/** The model's states as `Type.path`, for the glossary. */
function statePaths(model: Model): Set<string> {
  const out = new Set<string>();
  const walk = (name: string, states: Record<string, StateDef>) => {
    for (const s of Object.values(states)) { out.add(`${name}.${s.path.join(".")}`); walk(name, s.states); }
  };
  for (const m of Object.values(model.aggregates)) walk(m.name, m.states);
  return out;
}

export function trace({ docs, model, modelTexts, scenarios, issues }: TraceInput): Trace {
  const findings: Finding[] = docs.errors.map((message) => ({ severity: "error" as const, message }));
  const say = (severity: Finding["severity"], message: string) => findings.push({ severity, message });
  const rules = docs.topics.flatMap((t) => t.rules);

  // ---- the ids, one space across rules, questions and drawing issues
  const ids: Trace["ids"] = new Map();
  const define = (id: string, kind: "rule" | "question" | "issue", where: string, extra: { rule?: Rule; question?: Question } = {}) => {
    const had = ids.get(id);
    if (had) { say("error", `${id} is defined twice: ${where}, and as a ${had.kind}`); return; }
    ids.set(id, { kind, ...extra });
  };
  for (const r of rules) define(r.id, "rule", `rules/${r.topic}.yaml`, { rule: r });
  for (const q of docs.questions) define(q.id, "question", "questions.yaml", { question: q });
  for (const i of issues) define(i.id, "issue", "drawings/issues.yaml");
  const external = (id: string) => { const m = REFERENCE.exec(id); return !!m && !!docs.profile.external?.[m[1]!]; };

  // ---- what cites what
  const cited: Trace["cited"] = new Map();
  const at = (id: string) => cited.get(id) ?? cited.set(id, { model: [], scenarios: [], issues: [], comments: [] }).get(id)!;
  const resolve = (id: string, where: string) => {
    if (ids.has(id) || external(id)) return true;
    say("error", `${where}: why: ${id} — no rule, question or drawing issue has this id${REFERENCE.test(id) ? `, and docs/profile.yaml declares no outside prefix ${REFERENCE.exec(id)![1]}` : ""}`);
    return false;
  };
  for (const c of modelCitations(model)) for (const id of c.why) if (resolve(id, c.where)) at(id).model.push(c.where);
  for (const s of scenarios) {
    const stem = (s.file ?? "").replace(/\.yaml$/, "");
    for (const id of s.why ?? []) if (resolve(id, s.file ?? "a scenario")) at(id).scenarios.push(stem);
  }
  for (const i of issues) for (const w of new Set(words(i.why ?? ""))) if (ids.has(w) && w !== i.id) at(w).issues.push(i.id);
  // A line of model.yaml is its number; a line of a part, `part:number`.
  for (const [file, text] of Object.entries(modelTexts)) {
    text.split("\n").forEach((line, n) => {
      const comment = /(?:^|\s)#(.*)$/.exec(line)?.[1];
      if (comment) for (const w of new Set(words(comment))) if (ids.get(w)?.kind === "rule" || ids.get(w)?.kind === "question") at(w).comments.push(file === "model.yaml" ? String(n + 1) : `${file}:${n + 1}`);
    });
  }

  // ---- references inside the docs
  const changedBy: Trace["changedBy"] = new Map();
  const mustBe = (kind: "rule" | "question", id: string, where: string) => {
    const got = ids.get(id);
    if (!got) say("error", `${where}: ${id} — no ${kind} has this id`);
    else if (got.kind !== kind) say("error", `${where}: ${id} is a ${got.kind}, not a ${kind}`);
    return got?.kind === kind;
  };
  for (const r of rules) {
    const where = `rules/${r.topic}.yaml: ${r.id}`;
    for (const how of ["refines", "revises", "supersedes"] as const) {
      for (const id of r[how] ?? []) {
        if (!mustBe("rule", id, `${where}.${how}`)) continue;
        (changedBy.get(id) ?? changedBy.set(id, []).get(id)!).push({ how, by: r.id });
        if (how === "supersedes" && ids.get(id)!.rule!.status !== "superseded") say("error", `${where} supersedes ${id}, whose status is ${ids.get(id)!.rule!.status} — make it superseded`);
      }
    }
    for (const q of r.decided?.questions ?? []) mustBe("question", q, `${where}.decided.questions`);
    if (r.decided?.session !== undefined && !docs.sessions.has(r.decided.session)) say("error", `${where}: decided in session ${r.decided.session}, and decisions/ has no log ${String(r.decided.session).padStart(2, "0")}-…md`);
  }
  // After every rule is read: a later one may supersede it.
  for (const r of rules) {
    if (r.status === "superseded" && !(changedBy.get(r.id) ?? []).some((c) => c.how === "supersedes")) say("warning", `${r.id} is superseded, and no rule says it supersedes it`);
  }
  for (const q of docs.questions) {
    for (const id of q.about ?? []) mustBe("rule", id, `questions.yaml: ${q.id}.about`);
    for (const id of q.answeredBy ?? []) mustBe("rule", id, `questions.yaml: ${q.id}.answeredBy`);
    for (const s of [q.asked?.session, q.answered?.session]) if (s !== undefined && !docs.sessions.has(s)) say("error", `questions.yaml: ${q.id} names session ${s}, and decisions/ has no log for it`);
  }

  // ---- the canvas and the glossary name the model's things
  const packages = new Set(model.packages.map((p) => p.name));
  const types = new Set([...Object.keys(model.aggregates), ...Object.keys(model.values)]);
  for (const t of docs.topics) {
    for (const p of t.canvas?.packages ?? []) if (!packages.has(p)) say("error", `rules/${t.file}.yaml: canvas.packages names \`${p}\`, which is no package of the model`);
    for (const ty of t.canvas?.types ?? []) if (!types.has(ty)) say("error", `rules/${t.file}.yaml: canvas.types names \`${ty}\`, which is no type of the model`);
  }
  // ---- every topic brings its words: the types it is about each have a term (a warning);
  // the other packaged aggregates are noted (info), until their topic moves.
  const named = new Set<string>();
  if (docs.glossary) {
    const events = new Set(eventNames(model));
    const states = statePaths(model);
    for (const term of docs.glossary) {
      for (const n of term.model ?? []) {
        named.add(n);
        if (!types.has(n) && !events.has(n) && !states.has(n)) say("error", `glossary.yaml: ${term.term} names \`${n}\` — no type, event or state of the model`);
      }
    }
  }
  const ofTopic = new Map<string, string>();
  for (const t of docs.topics) {
    const listed = [...model.packages.filter((p) => t.canvas?.packages?.includes(p.name)).flatMap((p) => p.types), ...(t.canvas?.types ?? [])];
    for (const ty of listed) if (model.aggregates[ty] && !ofTopic.has(ty)) ofTopic.set(ty, t.file);
  }
  for (const [ty, topic] of ofTopic) {
    if (!named.has(ty)) say("warning", `rules/${topic}.yaml: ${ty} is one of the topic's types, and no glossary term names it — add the word for it to glossary.yaml`);
  }
  if (docs.glossary) {
    for (const p of model.packages) {
      for (const ty of p.types) {
        const m = model.aggregates[ty];
        if (m && m.role === "aggregate" && !m.abstract && !named.has(ty) && !ofTopic.has(ty)) say("info", `glossary: no term names ${ty} (package ${p.name})`);
      }
    }
  }

  // ---- the gaps
  for (const r of rules) {
    const c = cited.get(r.id);
    if (r.status === "agreed" || r.status === "to-confirm") {
      // Where a part runs changes nothing at run time (ADR 0018 §7): a rule only the systems
      // declaration cites is proven by the check of it, not by a scenario (ADR 0020 §7).
      const placement = !!c?.model.length && c.model.every((w) => PLACEMENT.test(w));
      const none = [!c?.model.length && "no model element", !c?.scenarios.length && !placement && "no scenario"].filter(Boolean);
      if (none.length && !r.untraced) say("warning", `${r.id} (${r.status}) — ${none.join(" and ")} cites it (\`why:\`), and it says no \`untraced:\` why`);
    }
    if (r.status === "superseded" && c && (c.model.length || c.scenarios.length)) {
      const by = (changedBy.get(r.id) ?? []).filter((x) => x.how === "supersedes").map((x) => x.by);
      say("warning", `stale: ${[...c.model, ...c.scenarios].join(", ")} cite${c.model.length + c.scenarios.length === 1 ? "s" : ""} ${r.id}, which is superseded${by.length ? ` by ${by.join(", ")}` : ""}`);
    }
    if (c?.comments.length && !c.model.length) say("warning", `${r.id} is named in a model comment (line ${c.comments.join(", ")}) and in no \`why:\``);
    if (r.status === "to-confirm" && c) for (const w of [...c.model, ...c.scenarios]) say("info", `waiting on the owner: ${w} cites ${r.id}, to confirm`);
  }
  for (const q of docs.questions) {
    const c = cited.get(q.id);
    if (q.status === "open" && c) for (const w of [...c.model, ...c.scenarios, ...c.issues]) say("info", `waiting on the owner: ${w} cites ${q.id}, an open question`);
  }
  return { ids, cited, changedBy, findings };
}
