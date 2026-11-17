/**
 * The model check (MC-7) as a function, for the CLIs: `check(args)` returns the exit code. See
 * cli.ts for the arguments. A domain folder (model.yaml, scenarios/, drawings/, docs/) can stand
 * for the paths. `docs(args)` writes a domain's rulebook, `rules(args)` answers questions about its
 * rules (ADR 0016).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { join } from "node:path";
import { isA, loadModel, narrowedBy, senderOfCommand, type Json } from "@statestorm/kernel";
import { parseScenario, realWorldSchedules, runScenario } from "@statestorm/scenarios";
import { crossings } from "./roles.ts";
import { readModel, readModelFiles, readScenario } from "@statestorm/scenarios/files";
import { buildFlow, flowConfig } from "../flow.ts";
import { REFERENCE, referencesOf } from "../groups.ts";
import { eventNames, overviewConfig } from "../overview.ts";
import { assignScenarios, compareDrawings, issuesMarkdown, offDrawing, parseDrawing, parseIssues, tagFindings } from "./drawings.ts";
import { coverage } from "./coverage.ts";
import { contributions } from "./contribution.ts";
import { unanswered } from "./unanswered.ts";
import { livesOnShape, staleLivesOn, unfinished } from "./endstates.ts";
import { staticChecks } from "./statics.ts";
import { proposalYaml, type NoProposal, type Proposal } from "./propose.ts";
import { readDocs, trace, type Docs, type Trace } from "./docs.ts";
import { rulebook, staleFiles } from "./rulebook.ts";
import { query, type Query } from "./query.ts";
import { outOfScope, parseAgenda } from "../agenda.ts";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";


// The proposal search's worker: beside this file, as TypeScript in the repo or bundled JS.
const WORKER = new URL(import.meta.url.endsWith(".ts") ? "./propose-worker.ts" : "./propose-worker.js", import.meta.url);

/** `<domain folder>` → its model, scenarios and (if any) drawings; otherwise the paths as given. */
export function paths(positional: string[]): (string | undefined)[] {
  const [first] = positional;
  if (positional.length === 1 && first && existsSync(join(first, "model.yaml"))) {
    return [join(first, "model.yaml"), join(first, "scenarios"), ...(existsSync(join(first, "drawings")) ? [join(first, "drawings")] : [])];
  }
  return positional;
}

/** The docs folder (ADR 0016): `--docs-dir=`, or a domain folder's `docs/` where it has one. */
export function docsDir(args: string[]): string | undefined {
  const given = args.find((a) => a.startsWith("--docs-dir="))?.slice(11);
  if (given) return given;
  const positional = args.filter((a) => !a.startsWith("--"));
  return positional.length === 1 && existsSync(join(positional[0]!, "docs")) ? join(positional[0]!, "docs") : undefined;
}

/** The agendas folder (ADR 0025): `--agendas-dir=`, or a domain folder's `agendas/` where it has one. */
export function agendasDir(args: string[]): string | undefined {
  const given = args.find((a) => a.startsWith("--agendas-dir="))?.slice(14);
  if (given) return given;
  const positional = args.filter((a) => !a.startsWith("--"));
  return positional.length === 1 && existsSync(join(positional[0]!, "agendas")) ? join(positional[0]!, "agendas") : undefined;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
type Say = (sev: "error" | "warning" | "info", text: string) => void;
type Parsed = { model: ReturnType<typeof loadModel>; modelTexts: Record<string, string>; scenarios: ReturnType<typeof parseScenario>[]; issues: { id: string; why?: string }[] };

/** The model, its scenarios and its drawing issues, as the docs are traced against them. */
function parsed(modelFile: string, scenarioDir: string, drawingDir: string | undefined): Parsed {
  const { text: modelText, files: modelTexts } = readModelFiles(modelFile);
  const scenarios = readdirSync(scenarioDir).filter((f) => f.endsWith(".yaml")).sort().map((f) => readScenario(join(scenarioDir, f), f));
  const issuesFile = drawingDir ? join(drawingDir, "issues.yaml") : undefined;
  const issues = issuesFile && existsSync(issuesFile)
    ? parseIssues(readFileSync(issuesFile, "utf8"), "issues.yaml", readdirSync(drawingDir!).filter((f) => f.endsWith(".yaml") && f !== "issues.yaml")).issues
    : [];
  return { model: loadModel(modelText, modelTexts), modelTexts, scenarios, issues };
}

function traced(dir: string, p: Parsed): { docs: Docs; t: Trace } {
  const docs = readDocs(dir);
  return { docs, t: trace({ docs, model: p.model, modelTexts: p.modelTexts, scenarios: p.scenarios, issues: p.issues }) };
}

/**
 * The agendas (ADR 0025): each must read and name scenarios there are, and ids the docs have; a
 * scenario carrying none of an agenda's `scope:` tags is a warning.
 */
function agendasSection(dir: string | undefined, docsFolder: string | undefined, p: Parsed, say: Say): void {
  if (!dir || !existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  if (files.length === 0) return;
  console.log("\nAgendas (ADR 0025)");
  const stems = p.scenarios.map((s) => (s.file ?? "").replace(/\.yaml$/, ""));
  const tags = new Map(p.scenarios.map((s) => [(s.file ?? "").replace(/\.yaml$/, ""), s.tags ?? []]));
  const docs = docsFolder && existsSync(docsFolder) ? readDocs(docsFolder) : undefined;
  const ids = docs ? new Set([...docs.topics.flatMap((t) => t.rules.map((r) => r.id)), ...docs.questions.map((q) => q.id)]) : undefined;
  for (const f of files) {
    const { agenda, errors } = parseAgenda(readFileSync(join(dir, f), "utf8"), f, stems);
    for (const e of errors) say("error", e);
    if (!agenda) continue;
    for (const it of agenda.items) for (const q of it.questions) {
      if (!ids) say("error", `agendas/${f}: ${it.title} raises ${q}, and there is no docs/ to find it in`);
      else if (!ids.has(q)) say("error", `agendas/${f}: ${it.title} raises ${q} — no rule or question has this id`);
    }
    for (const w of outOfScope(agenda, (s) => tags.get(s) ?? [])) say("warning", w);
    const n = new Set(agenda.items.flatMap((it) => it.scenarios)).size;
    console.log(`  ${agenda.name}: ${agenda.title} — ${plural(agenda.items.length, "item")}, ${plural(n, "scenario")}${agenda.scope.length ? ` · scope ${agenda.scope.join(", ")}` : ""}`);
  }
}

/** The docs against the model (ADR 0016 §10), and whether the rulebook is up to date. */
function docsSection(dir: string | undefined, p: Parsed, say: Say): void {
  console.log("\nDocs (ADR 0016)");
  if (!dir || !existsSync(dir)) {
    const cites = p.scenarios.some((s) => s.why?.length) || Object.values(p.modelTexts).some((t) => /^\s*why:/m.test(t));
    if (cites) say("error", "the model or a scenario cites rules (`why:`), and there is no docs/ folder to find them in");
    else console.log("  no docs/ — nothing to trace");
    return;
  }
  const { docs, t } = traced(dir, p);
  for (const f of t.findings) say(f.severity, f.message);
  const stale = docs.errors.length ? [] : staleFiles(dir, rulebook(docs, p.model, t));
  if (stale.length) say("error", `the rulebook is stale — run \`statestorm docs\`: ${stale.join(", ")}`);
  const rules = docs.topics.flatMap((x) => x.rules);
  const active = rules.filter((r) => r.status === "agreed" || r.status === "to-confirm");
  const both = active.filter((r) => t.cited.get(r.id)?.model.length && t.cited.get(r.id)?.scenarios.length);
  const quiet = t.findings.filter((f) => f.severity === "info").length;
  console.log(`  ${rules.length} rules in ${docs.topics.length} topics · ${both.length}/${active.length} agreed or to-confirm rules cited by the model and a scenario · ${plural(docs.questions.filter((q) => q.status === "open").length, "open question")}${quiet ? ` · ${quiet} info findings (--all)` : ""}`);
}

/**
 * `rules`: the docs asked rather than read (ADR 0016 §11). `rules <domain folder> [<id>]
 * [--topic=<t>] [--open] [--json]`; by path, `--docs-dir=` and `--id=`.
 */
export function rules(args: string[]): number {
  const positional = args.filter((a) => !a.startsWith("--"));
  const folder = positional[0] !== undefined && existsSync(join(positional[0], "model.yaml"));
  const [modelFile, scenarioDir, drawingDir] = paths(folder ? [positional[0]!] : positional);
  const dir = docsDir(folder ? [positional[0]!, ...args.filter((a) => a.startsWith("--"))] : args);
  const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!modelFile || !scenarioDir || !dir || !existsSync(dir)) {
    console.error("usage: rules <domain folder with docs/> [<id>] [--topic=<topic>] [--open] [--json]\n       rules <model.yaml> <scenarios dir> [drawings dir] --docs-dir=<dir> [--id=<id>] [--topic=<topic>] [--open] [--json]");
    return 2;
  }
  const id = flag("id") ?? (folder ? positional[1] : undefined);
  const topic = flag("topic");
  const q: Query = id ? { kind: "id", id } : topic ? { kind: "topic", topic } : args.includes("--open") ? { kind: "open" } : { kind: "index" };
  const p = parsed(modelFile, scenarioDir, drawingDir);
  const { docs: d, t } = traced(dir, p);
  if (d.errors.length) console.error(`(${d.errors.length} problem${d.errors.length === 1 ? "" : "s"} in the docs — \`check --docs\` lists them)`);
  const a = query(d, p.model, t, q);
  console.log(args.includes("--json") ? JSON.stringify(a.json, null, 2) : a.text);
  return a.found ? 0 : 1;
}

/** `docs`: writes the rulebook and the merged schemas into the docs folder (ADR 0016 §9). */
export function docs(args: string[]): number {
  const [modelFile, scenarioDir, drawingDir] = paths(args.filter((a) => !a.startsWith("--")));
  const dir = docsDir(args);
  if (!modelFile || !scenarioDir || !dir) {
    console.error("usage: docs <domain folder with docs/> | <model.yaml> <scenarios dir> [drawings dir] --docs-dir=<dir>");
    return 2;
  }
  const p = parsed(modelFile, scenarioDir, drawingDir);
  const { docs: d, t } = traced(dir, p);
  if (d.errors.length) {
    for (const e of d.errors) console.error(`  ✗ ${e}`);
    console.error("docs: not written — the files above do not read");
    return 1;
  }
  const files = rulebook(d, p.model, t);
  const stale = staleFiles(dir, files);
  rmSync(join(dir, "rulebook"), { recursive: true, force: true });
  rmSync(join(dir, ".schemas"), { recursive: true, force: true });
  for (const [f, text] of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  const errors = t.findings.filter((f) => f.severity === "error");
  for (const e of errors) console.error(`  ✗ ${e.message}`);
  console.log(`docs: ${files.size} files in ${dir} (${stale.length ? `${stale.length} changed` : "none changed"})${errors.length ? ` — and ${errors.length} errors, \`check --docs\` lists them all` : ""}`);
  return errors.length ? 1 : 0;
}

export async function check(args: string[]): Promise<number> {
  const [modelFile, scenarioDir, drawingDir] = paths(args.filter((a) => !a.startsWith("--")));
  const all = args.includes("--all");
  const showCoverage = args.includes("--coverage");
  const showIssues = args.includes("--issues");
  const doPropose = args.includes("--propose");
  const showScenarios = args.includes("--scenarios");
  if (!modelFile || !scenarioDir) {
    console.error("usage: check <domain folder> | <model.yaml> <scenarios dir> [drawings dir] [--docs-dir=<dir>] [--agendas-dir=<dir>] [--all] [--coverage] [--scenarios] [--issues] [--docs] [--propose] [--budget=<s>]");
    return 2;
  }
  const docsFolder = docsDir(args);
  const agendaFolder = agendasDir(args);

  // `--docs`: the docs against the model only, no runs — fast enough for a hook after every edit.
  if (args.includes("--docs")) {
    let errors = 0, warnings = 0;
    const say: Say = (sev, text) => {
      if (sev === "error") errors++;
      if (sev === "warning") warnings++;
      if (sev !== "info" || all) console.log(`  ${sev === "error" ? "✗" : sev === "warning" ? "!" : "·"} ${text}`);
    };
    const p = parsed(modelFile, scenarioDir, drawingDir);
    docsSection(docsFolder, p, say);
    agendasSection(agendaFolder, docsFolder, p, say);
    console.log(`\n${errors} errors, ${warnings} warnings`);
    return errors > 0 ? 1 : 0;
  }

  const model = readModel(modelFile);
  const yamls = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".yaml") && f !== "issues.yaml").sort();

  if (showIssues) {
    if (!drawingDir || !existsSync(join(drawingDir, "issues.yaml"))) { console.error("no issues.yaml in the drawings folder"); return 2; }
    const files = yamls(drawingDir);
    const titles = Object.fromEntries(files.map((f) => [f.replace(/\.yaml$/, ""), parseDrawing(model, readFileSync(join(drawingDir, f), "utf8"), f).title]));
    const { issues, errors } = parseIssues(readFileSync(join(drawingDir, "issues.yaml"), "utf8"), "issues.yaml", files);
    for (const e of errors) console.error(`✗ ${e}`);
    console.log(issuesMarkdown(issues, titles));
    return errors.length ? 1 : 0;
  }
  const scenarios = yamls(scenarioDir).map((f) => readScenario(join(scenarioDir, f), f));

  let errors = 0;
  let warnings = 0;
  const say = (sev: "error" | "warning" | "info", text: string) => {
    if (sev === "error") errors++;
    if (sev === "warning") warnings++;
    if (sev !== "info" || all) console.log(`  ${sev === "error" ? "✗" : sev === "warning" ? "!" : "·"} ${text}`);
  };

  // ---- the runs
  console.log(`\n${model.context}: ${scenarios.length} scenarios × ${realWorldSchedules().length} schedules`);
  const runs: { file: string; log: ReturnType<typeof runScenario>["world"]["log"] }[] = [];
  const ends: { file: string; world: ReturnType<typeof runScenario>["world"] }[] = [];
  for (const sc of scenarios) {
    for (const [i, schedule] of realWorldSchedules().entries()) {
      const r = runScenario(model, sc, schedule);
      runs.push({ file: sc.file ?? "", log: r.world.log });
      if (i === 0) ends.push({ file: sc.file ?? "", world: r.world });
      for (const f of r.failures) say("error", `${sc.file}: ${f}`);
    }
  }

  // ---- static checks (MC-2)
  console.log("\nStatic checks");
  const inputs = scenarios.flatMap((s) => [...s.given.send, ...s.when.flatMap((w) => (w.step === "send" ? [{ ref: w.ref, payload: w.payload }] : []))]);
  const statics = staticChecks(model, inputs);
  for (const f of statics) say(f.severity, f.message);
  const quiet = statics.filter((f) => f.severity === "info").length;
  if (quiet && !all) console.log(`  (${quiet} info findings — --all shows them)`);

  // ---- systems (ADR 0018, ADR 0020): who sends what the scenarios send from outside
  if (model.systems) {
    console.log("\nSystems (ADR 0018, ADR 0020)");
    const sys = model.systems;
    const externals = sys.systems.filter((s) => s.external);
    for (const f of model.findings) if (/ADR 0018|ADR 0020|^relations:/.test(f.message)) say(f.severity, f.message);
    // Each command sent from outside, said as Type.Command — and, where a sender is narrowed by a
    // field of the payload, with that field's value: the unit a sender is declared for.
    const kinds = new Map<string, boolean>();
    for (const i of inputs) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)#[^.]*\.([A-Za-z_][A-Za-z0-9_]*)/.exec(i.ref);
      if (!m) continue;
      const by = narrowedBy(model, m[1]!, m[2]!);
      const key = `${m[1]}.${m[2]}${by.length ? ` { ${by.map((f) => `${f}: ${String((i.payload as Record<string, Json>)?.[f])}`).join(", ")} }` : ""}`;
      const sent = !!senderOfCommand(model, m[1]!, m[2]!, (i.payload ?? {}) as Record<string, Json>);
      kinds.set(key, (kinds.get(key) ?? false) || sent);
    }
    const byPerson = [...kinds].filter(([, sent]) => !sent).map(([k]) => k).sort();
    for (const c of byPerson) say("info", `${c}: sent from outside by no external system — drawn as a person`);
    const spanning = sys.contexts.filter((c) => new Set(sys.subsystems.filter((s) => s.context === c.name).map((s) => s.system)).size > 1);
    for (const c of spanning) say("info", `context ${c.name} spans systems ${[...new Set(sys.subsystems.filter((s) => s.context === c.name).map((s) => s.system))].join(", ")}`);
    const ours = sys.subsystems.filter((s) => !s.external).length;
    console.log(`  ${plural(sys.systems.length - externals.length, "system")} of its own in ${plural(ours, "sub-system")}, ${externals.length} outside${sys.domains.length ? `, in ${plural(sys.domains.length, "domain")}` : ""}, ${plural(sys.contexts.length - externals.length, "bounded context")}${spanning.length ? ` (${spanning.length} spanning systems)` : ""} · ${kinds.size - byPerson.length}/${kinds.size} kinds of command from outside have a sender${byPerson.length && !all ? " (--all lists the rest)" : ""}`);
  }

  // ---- roles (ADR 0027): who plays each, and every event that moved what another role works
  if (model.systems?.roles.length) {
    console.log("\nRoles (ADR 0027)");
    const sys = model.systems;
    for (const f of model.findings) if (/ADR 0027/.test(f.message)) say(f.severity, f.message);
    for (const r of sys.roles) {
      const players = sys.subsystems.filter((x) => x.plays?.includes(r.name)).map((x) => x.name);
      console.log(`  ${r.name}: works ${r.works.join(", ") || "nothing"} · sends ${plural(r.sends.length, "kind")} of command · played by ${players.join(", ") || "no part"}`);
    }
    const across = crossings(model, ends);
    const numberOf = (stem: string) => stem.replace(/\.yaml$/, "").replace(/-.*$/, "");
    if (across.length) console.log(`  Events that move what another role works — ${across.length}:`);
    for (const c of across) {
      const list = `${c.scenarios.slice(0, 6).map(numberOf).join(", ")}${c.scenarios.length > 6 ? ", …" : ""}`;
      console.log(`    ${c.input} (${c.owner}) → ${c.moved} ${c.to.join("/")} (${c.movedRole}) — ${plural(c.scenarios.length, "scenario")}: ${list}`);
    }
    if (!across.length) console.log("  every event moves only what its own role works");
  }

  // ---- coverage (MC-3)
  console.log("\nCoverage");
  const cov = coverage(model, runs.map((r) => r.log));
  let rules = 0, ruleTotal = 0, states = 0, stateTotal = 0;
  for (const t of cov.types) {
    rules += t.rules.taken; ruleTotal += t.rules.total; states += t.states.reached; stateTotal += t.states.total;
    const open = t.rules.untaken.filter((u) => !u.ignored);
    const unreached = t.states.unreached.filter((u) => !u.ignored);
    if (showCoverage) {
      for (const u of open) say("info", `${u.id}${u.guard ? `  [when ${u.guard.replace(/\s+/g, " ")}]` : ""} — no scenario takes it`);
      for (const u of unreached) say("warning", `${t.type}.${u.path} — no scenario reaches it`);
    } else {
      for (const u of unreached) say("warning", `${t.type}.${u.path} — no scenario reaches it`);
    }
  }
  for (const s of cov.stale) say("warning", `coverage.ignore: \`${s}\` names no gap — stale`);
  console.log(`  rules taken: ${rules}/${ruleTotal} · states reached: ${states}/${stateTotal}${showCoverage ? "" : " (--coverage lists every untaken rule)"}`);

  // ---- end states (MC-13): every scenario runs to its end
  console.log("\nEnd states");
  let open = 0;
  for (const e of ends) {
    const left = unfinished(model, e.world);
    if (!left.length) continue;
    open++;
    say("warning", `${e.file} ends with ${left.length} not finished: ${left.slice(0, 6).map((u) => `${u.key} (${u.state})`).join(", ")}${left.length > 6 ? ", …" : ""}`);
  }
  const shape = livesOnShape(model);
  if (shape) say("warning", shape);
  for (const t of staleLivesOn(model)) say("warning", `coverage.lives_on: \`${t}\` is no type of the model — stale`);
  console.log(`  ${ends.length - open}/${ends.length} scenarios end with everything finished (coverage.lives_on: types that live on)`);

  // ---- unanswered commands (MC-17): a message lost, or a no-op the model does not say
  console.log("\nUnanswered commands (MC-17)");
  const asserted = new Set(scenarios.flatMap((s) => [...s.when.flatMap((w) => (w.step === "assert" ? [w.assertion] : [])), ...s.then]
    .flatMap((a) => (a.kind === "rejected" ? Object.entries(a.of).map(([k, n]) => `${k} ${n}`) : []))));
  const silent = unanswered(runs, asserted);
  const numberOf = (stem: string) => stem.replace(/-.*$/, "");
  for (const u of silent) {
    const list = `${u.scenarios.slice(0, 6).map(numberOf).join(", ")}${u.scenarios.length > 6 ? ", …" : ""}`;
    say("error", `${u.type}.${u.name} ${u.kind === "unhandled" ? "unanswered" : "refused"} in ${u.where} — ${u.scenarios.length} scenario${u.scenarios.length === 1 ? "" : "s"} (${list})${all ? `: ${u.why}` : ""}`);
  }
  console.log(`  ${silent.length ? `${silent.length} kinds of command went unanswered — answer each, or say the no-op in the model (\`Name: {}\`)${all ? "" : "; --all says why"}` : "every command was answered"}`);
  const walked = new Map<string, Set<string>>();   // per scenario file, the drawn arrows it walks (MC-16)

  // ---- the drawings (MC-12)
  if (drawingDir && existsSync(drawingDir)) {
    console.log("\nDrawings");
    const drawings = yamls(drawingDir).map((f) => parseDrawing(model, readFileSync(join(drawingDir, f), "utf8"), f));
    for (const d of drawings) for (const e of d.errors) say("error", e);
    const walkers = scenarios.map((s) => ({ file: s.file ?? "", ...(s.drawing !== undefined ? { drawing: s.drawing } : {}), ...(s.tags ? { tags: s.tags } : {}) }));
    const assigned = assignScenarios(drawings, walkers);
    for (const e of assigned.errors) say("error", e);
    for (const f of assigned.none) say("warning", `${f}: walks no drawing — name the one it walks (\`drawing:\`)`);
    let issues: ReturnType<typeof parseIssues>["issues"] = [];
    if (existsSync(join(drawingDir, "issues.yaml"))) {
      const parsed = parseIssues(readFileSync(join(drawingDir, "issues.yaml"), "utf8"), "issues.yaml", yamls(drawingDir), eventNames(model));
      issues = parsed.issues;
      const bad = parsed.errors;
      for (const e of bad) say("error", e);
      const by = (st: string) => issues.filter((i) => i.status === st).length;
      console.log(`  changes to the drawings: ${by("open")} open, ${by("to confirm")} to confirm, ${by("confirmed")} confirmed, ${by("done")} done (--issues prints them)`);
    }
    const runsOf = (prefixes?: string[]) => runs.filter((r) => prefixes === undefined || prefixes.some((p) => r.file.startsWith(p)));
    const graphOf = (prefixes?: string[]) => buildFlow(model, overviewConfig(model).config, flowConfig(model).flow, runsOf(prefixes).map((r) => r.log));
    // Which statuses led to telling the customer: an event whose consequences include the notice.
    const subjectTypes = flowConfig(model).flow.of ?? Object.keys(model.aggregates);
    const statuses = new Set(eventNames(model));
    const toldOf = (prefixes: string[] | undefined, notice: string) => {
      const told = new Set<string>();
      for (const r of runsOf(prefixes)) {
        const bySeq = new Map(r.log.map((e) => [e.seq, e]));
        for (const e of r.log) {
          if (e.kind !== "event" || e.event !== notice) continue;
          for (let at = e.cause, hops = 0; at > 0 && hops < 60; hops++) {
            const c = bySeq.get(at);
            if (!c) break;
            if (c.kind === "event" && subjectTypes.some((t) => isA(model, c.instance.slice(0, c.instance.indexOf("#")), t))) { told.add(c.event); break; }
            // An event that names a status (a deviation confirmed, carrying the status it reported)
            // tells for that status: the person's confirmation is not the reason.
            const named = c.kind === "event" ? Object.values(c.payload).find((v) => typeof v === "string" && statuses.has(v)) : undefined;
            if (typeof named === "string") { told.add(named); break; }
            at = c.cause;
          }
        }
      }
      return told;
    };
    const evOf = (id: string) => id.slice(0, id.lastIndexOf("@"));
    const report = compareDrawings(drawings, graphOf, toldOf);
    const pairsByFile = new Map<string, Set<string>>();
    const shownBy = (file: string) => pairsByFile.get(file) ?? pairsByFile.set(file, new Set(
      buildFlow(model, overviewConfig(model).config, flowConfig(model).flow, runs.filter((r) => r.file === file).map((r) => r.log)).edges
        .map((e) => `${evOf(e.from)} ${evOf(e.to)}`))).get(file)!;
    for (const d of drawings) {
      for (const a of d.arrows) {
        if (a.decision.kind !== "model" || !a.fromEvent || !a.toEvent) continue;
        const own = d.paths[a.path]?.scenarios.length ? d.paths[a.path]!.scenarios : d.scenarios ?? [];
        for (const file of scenarios.map((s) => s.file ?? "").filter((f) => own.some((p) => f.startsWith(p)))) {
          if (!shownBy(file).has(`${a.fromEvent} ${a.toEvent}`)) continue;
          const key = `${d.file.replace(/\.yaml$/, "")}: ${a.from} -> ${a.to}${a.path !== "main" ? ` (${a.path})` : ""}`;
          (walked.get(file) ?? walked.set(file, new Set()).get(file)!).add(key);
        }
      }
    }
    for (const r of report.drawings) {
      const c = r.counts;
      console.log(`  ${r.drawing.file}${r.drawing.scenarios ? ` (scenarios ${r.drawing.scenarios.join(", ") || "none yet"})` : ""}: ${c.shown} shown, ${c.missing} missing · later ${c.later} · open ${c.open} · no ${c.no}`);
      for (const a of r.missing) say("warning", `drawn, in the model, never shown: ${a.from} -> ${a.to}${a.path !== "main" ? ` (${a.path})` : ""}`);
      for (const a of r.shownAnyway) say("warning", `decided ${a.decision.kind}${"why" in a.decision ? ` (${a.decision.why})` : ""}, yet a scenario shows it: ${a.from} -> ${a.to}`);
      for (const l of r.lanes) say("info", `${l.label}: drawn in ${l.drawn}, on the board in ${l.board.join(", ")}`);
      for (const e of r.customer?.markedNotTold ?? []) say("warning", `marked as telling the customer (CC), never told in its scenarios: ${e}`);
      for (const e of r.customer?.toldNotMarked ?? []) say("warning", `the model tells the customer, the drawing does not mark it (CC): ${e}`);
    }
    for (const u of report.undrawn) say("info", `shown ${u.count}×, drawn nowhere: ${u.from} -> ${u.to}`);

    // ---- tags (MC-15): happy or deviation, and a happy path per drawing
    console.log("\nScenario tags (MC-15)");
    for (const f of tagFindings(drawings, walkers)) say("warning", f);
    const count = new Map<string, number>();
    for (const w of walkers) for (const t of w.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
    const topics = [...count].filter(([t]) => !REFERENCE.test(t)).sort((a, b) => b[1] - a[1]);
    console.log(`  ${topics.map(([t, n]) => `${t} ${n}`).join(" · ")}`);
    const refs = referencesOf([...count.keys()]);
    if (refs.length) console.log(`  references: ${refs.map((t) => `${t} ${count.get(t)}`).join(" · ")}`);

    // ---- each scenario against its own drawing (MC-14): every arrow it walks should be drawn there
    console.log("\nScenarios against their drawing (MC-14)");
    const fifo = new Map<string, typeof runs[number]["log"]>();
    for (const r of runs) if (!fifo.has(r.file)) fifo.set(r.file, r.log);
    const pairsOf = (file: string) => new Set(buildFlow(model, overviewConfig(model).config, flowConfig(model).flow, [fifo.get(file)!]).edges
      .map((e) => `${evOf(e.from)} ${evOf(e.to)}`).filter((p) => p.split(" ")[0] !== p.split(" ")[1]));
    const off = offDrawing(drawings, walkers, pairsOf, issues);
    for (const d of drawings) {
      const stem = d.file.replace(/\.yaml$/, "");
      const list = off.get(stem) ?? [];
      const raised = list.filter((o) => o.raised.length > 0);
      console.log(`  ${d.file} (${(d.scenarios ?? []).length} scenarios): ${list.length ? `${list.length} arrow${list.length === 1 ? "" : "s"} walked, not drawn — ${raised.length} raised in issues.yaml` : "every arrow walked is drawn"}`);
      for (const o of list) {
        const where = o.elsewhere.length ? `drawn on ${o.elsewhere.join(", ")}` : "drawn nowhere";
        if (o.raised.length) say("info", `${o.from} -> ${o.to}, walked by ${o.scenarios.join(", ")} — raised in ${o.raised.join(", ")}`);
        else say("warning", `${o.from} -> ${o.to}, walked by ${o.scenarios.join(", ")} — ${where}; not raised in issues.yaml`);
      }
    }

    // ---- proposed scenarios (MC-11), the gaps searched in parallel, one worker per core
    if (doPropose) {
      console.log("\nProposed scenarios (MC-11)");
      const out = join(scenarioDir, "proposed");
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      const raws = Object.fromEntries(yamls(scenarioDir).map((f) => [f, parseYaml(readFileSync(join(scenarioDir, f), "utf8")) as Record<string, unknown>]));
      // The whole search has a budget (default 120s, --budget=<seconds>): the build stays short.
      const seconds = Number(args.find((x) => x.startsWith("--budget="))?.slice(9) ?? 120);
      const deadline = Date.now() + seconds * 1000;
      type Job = { key: string; from: string; to: string; prefer: string[]; stem: string; title: string; labels: { from: string; to: string } };
      const jobs: Job[] = [];
      const dupes: { stem: string; label: string; key: string }[] = [];
      for (const r of report.drawings) {
        const stem = r.drawing.file.replace(/\.yaml$/, "");
        for (const a of r.missing) {
          const key = `${a.fromEvent} ${a.toEvent} ${(r.drawing.scenarios ?? []).join(",")}`;
          if (jobs.some((j) => j.key === key)) { dupes.push({ stem, label: `${a.from} -> ${a.to}`, key }); continue; }
          const prefer = a.path !== "main" && r.drawing.paths[a.path]?.scenarios.length ? r.drawing.paths[a.path]!.scenarios : r.drawing.scenarios ?? [];
          jobs.push({ key, from: a.fromEvent!, to: a.toEvent!, prefer, stem, title: r.drawing.title, labels: { from: a.from, to: a.to } });
        }
      }
      const results = new Map<string, Proposal | NoProposal>();
      const took = new Map<string, number>();
      const started = Date.now();
      const threads = Math.max(1, Math.min(jobs.length, availableParallelism()));
      await new Promise<void>((resolve, reject) => {
        let next = 0;
        let live = threads;
        for (let i = 0; i < threads; i++) {
          const w = new Worker(WORKER, { workerData: { modelFile, scenarioDir, deadline } });
          const feed = () => {
            if (next < jobs.length) { const j = jobs[next++]!; w.postMessage({ key: j.key, from: j.from, to: j.to, prefer: j.prefer }); }
            else w.postMessage(null);
          };
          w.on("message", (m: { ready?: true; key?: string; result?: Proposal | NoProposal; ms?: number }) => {
            if (m.key && m.result) { results.set(m.key, m.result); took.set(m.key, m.ms ?? 0); }
            feed();
          });
          w.on("error", reject);
          w.on("exit", () => { if (--live === 0) resolve(); });
        }
      });
      for (const j of jobs) {
        const p = results.get(j.key);
        if (!p || "reason" in p) { say("warning", `${j.stem}: ${j.labels.from} -> ${j.labels.to} — ${p ? p.reason : "not searched: the time budget ran out"}`); continue; }
        const file = `${j.stem}--${j.from}-to-${j.to}.yaml`;
        writeFileSync(join(out, file), proposalYaml(p, raws[p.scenario] ?? {}, j.title, j.labels));
        console.log(`  + ${file}: from ${p.scenario}, ${p.steps.length} step(s) — ${p.moved.length ? `${p.moved.length} things move` : "NOTHING reacts: a gap in the model"}`);
      }
      for (const d of dupes) console.log(`  = ${d.stem}: ${d.label} — as above`);
      const slow = [...took].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, ms]) => `${k.split(" ").slice(0, 2).join(" -> ")} ${(ms / 1000).toFixed(1)}s`);
      console.log(`  ${jobs.length} gaps searched on ${threads} threads in ${((Date.now() - started) / 1000).toFixed(1)}s; slowest: ${slow.join(", ")}`);
    }
  }

  const p = parsed(modelFile, scenarioDir, drawingDir);
  docsSection(docsFolder, p, say);
  agendasSection(agendaFolder, docsFolder, p, say);

  // ---- what each scenario covers that no other does (MC-16)
  console.log("\nWhat each scenario alone covers (MC-16)");
  const mine = contributions(model, runs, walked);
  const none = mine.filter((c) => !c.rules.length && !c.states.length && !c.arrows.length);
  if (showScenarios) {
    for (const c of mine) {
      const stem = c.file.replace(/\.yaml$/, "");
      if (!c.rules.length && !c.states.length && !c.arrows.length) { console.log(`  ${stem}: nothing of its own`); continue; }
      const n = [c.rules.length && `${c.rules.length} rule${c.rules.length === 1 ? "" : "s"}`, c.states.length && `${c.states.length} state${c.states.length === 1 ? "" : "s"}`,
        c.arrows.length && `${c.arrows.length} drawn arrow${c.arrows.length === 1 ? "" : "s"}`].filter(Boolean).join(", ");
      console.log(`  ${stem}: ${n}`);
      for (const x of [...c.rules, ...c.states.map((s) => `${s} (state)`), ...c.arrows]) console.log(`      ${x}`);
    }
  }
  console.log(`  ${none.length}/${mine.length} scenarios cover no rule, state or drawn arrow that another does not${none.length && !showScenarios ? ` — ${none.map((c) => c.file.replace(/-.*$/, "")).join(", ")}` : ""}${showScenarios ? "" : " (--scenarios lists what each covers)"}`);

  console.log(`\n${errors} errors, ${warnings} warnings`);
  return errors > 0 ? 1 : 0;
}
