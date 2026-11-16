import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModel } from "@statestorm/kernel";
import { parseScenario } from "@statestorm/scenarios";
import { docsFiles, docsFromFiles, readDocs, trace, type TraceInput } from "../src/check/docs.ts";
import { docsData, rulesAbout, rulesOfPackage, targetOf, termsFor } from "../src/docs-links.ts";
import { rulebook, staleFiles } from "../src/check/rulebook.ts";

// A domain's docs (ADR 0016): a small model and docs written per test into a temporary folder.

const MODEL = `context: T
packages:
  Orders: { types: [Order] }
aggregates:
  Order:
    why: [R1]
    creators: [Place]
    initial: open
    states:
      open:
        on:
          Place: { emit: [Placed] }
          Ship: { target: shipped, why: [R2] }   # R3 is said here only
      shipped: { final: true }
`;

const RULES = `title: Orders
canvas: { purpose: taking and shipping orders, packages: [Orders] }
rules:
  - { id: R1, title: An order is placed, kind: definitional, status: agreed, text: t, decided: { session: 1, date: 2026-03-02 } }
  - { id: R2, title: An order ships, kind: behavioural, status: agreed, text: t }
  - { id: R3, title: A shipped order is final, kind: behavioural, status: agreed, text: t }
`;

type Files = Record<string, string>;
function docsIn(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), "statestorm-docs-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

function run(files: Files, o: { model?: string; scenarios?: string[][]; issues?: TraceInput["issues"] } = {}) {
  const docs = readDocs(docsIn({ "decisions/01-2026-03-02-first.md": "# 1\n", ...files }));
  const modelText = o.model ?? MODEL;
  const scenarios = (o.scenarios ?? [["R1", "R2", "R3"]]).map((why, i) =>
    parseScenario(`scenario: s${i}\nwhy: [${why.join(", ")}]\ngiven: { send: [] }\n`, `0${i}-s.yaml`));
  const t = trace({ docs, model: loadModel(modelText), modelTexts: { "model.yaml": modelText }, scenarios, issues: o.issues ?? [] });
  const said = (sev: string) => t.findings.filter((f) => f.severity === sev).map((f) => f.message);
  return { docs, t, errors: said("error"), warnings: said("warning"), infos: said("info") };
}

test("the model and the scenarios cite rules: who cites what is traced, a rule only in a comment is said (ADR 0016 §10)", () => {
  const { t, errors, warnings } = run({ "rules/orders.yaml": RULES });
  assert.deepEqual(errors, []);
  assert.deepEqual(t.cited.get("R1")!.model, ["Order"]);
  assert.deepEqual(t.cited.get("R2")!.model, ["Order.open on Ship"]);
  assert.deepEqual(t.cited.get("R2")!.scenarios, ["00-s"]);
  assert.deepEqual(warnings, [
    "rules/orders.yaml: Order is one of the topic's types, and no glossary term names it — add the word for it to glossary.yaml",
    "R3 (agreed) — no model element cites it (`why:`), and it says no `untraced:` why",
    "R3 is named in a model comment (line 13) and in no `why:`",
  ]);
});

test("an id nothing defines is an error; an outside prefix the profile declares is a reference (ADR 0016 §6)", () => {
  const { errors } = run({ "rules/orders.yaml": RULES, "profile.yaml": "external: { TP: { title: the test plan } }\n" },
    { scenarios: [["R1", "R2", "R3", "TP-4", "WX-1", "R9"]] });
  assert.deepEqual(errors, [
    "00-s.yaml: why: WX-1 — no rule, question or drawing issue has this id, and docs/profile.yaml declares no outside prefix WX",
    "00-s.yaml: why: R9 — no rule, question or drawing issue has this id",
  ]);
});

test("superseding: the older rule must say so, and what still cites it is stale (ADR 0016 §3, §10)", () => {
  const rules = RULES.replace("  - { id: R3,", "  - { id: R4, title: Old, kind: behavioural, status: agreed, text: t }\n  - { id: R3, supersedes: [R4],");
  assert.match(run({ "rules/orders.yaml": rules }).errors.join("\n"), /R3 supersedes R4, whose status is agreed — make it superseded/);
  const fixed = rules.replace("status: agreed, text: t }\n  - { id: R3", "status: superseded, text: t }\n  - { id: R3");
  const { errors, warnings, t } = run({ "rules/orders.yaml": fixed }, { scenarios: [["R1", "R2", "R3", "R4"]] });
  assert.deepEqual(errors, []);
  assert.deepEqual(t.changedBy.get("R4"), [{ how: "supersedes", by: "R3" }]);
  assert.ok(warnings.includes("stale: 00-s cites R4, which is superseded by R3"), warnings.join("\n"));
});

test("one id space across rules, questions and drawing issues; references inside the docs resolve", () => {
  const { errors } = run({
    "rules/orders.yaml": RULES.replace("text: t, decided: { session: 1", "text: t, refines: [Q-1], decided: { session: 2"),
    "questions.yaml": `questions:
  - { id: Q-1, question: q, leaning: l, status: answered, asked: { date: 2026-03-02 }, answer: a, answeredBy: [R7] }
  - { id: R2, question: q, leaning: l, status: open, asked: { date: 2026-03-02 } }
`,
  }, { issues: [{ id: "Q-1", why: "a slip" }] });
  assert.deepEqual(errors, [
    "R2 is defined twice: questions.yaml, and as a rule",
    "Q-1 is defined twice: drawings/issues.yaml, and as a question",
    "rules/orders.yaml: R1.refines: Q-1 is a question, not a rule",
    "rules/orders.yaml: R1: decided in session 2, and decisions/ has no log 02-…md",
    "questions.yaml: Q-1.answeredBy: R7 — no rule has this id",
  ]);
});

test("the files are checked against the schemas, with the profile's fields added (ADR 0016 §8)", () => {
  const profile = `fields:
  rule: { release: { description: the release, enum: ["1", "2"] } }
  term: { scan: { description: the scan, vocabulary: vocab/scans.yaml } }
`;
  const { errors } = run({
    "rules/orders.yaml": RULES.replace("status: agreed, text: t }\n  - { id: R3", "status: agreed, text: t, release: \"3\", owner: me }\n  - { id: R3"),
    "profile.yaml": profile,
    "vocab/scans.yaml": "title: scans\nvalues: [{ value: Shipped }]\n",
    "glossary.yaml": "terms:\n  - { term: Order, definition: d, model: [Order, Placed, Order.open], scan: Shipped }\n  - { term: Parcel, definition: d, model: [Parcel], scan: Lost }\n",
  });
  assert.deepEqual(errors, [
    "rules/orders.yaml: rules[R2].release must be equal to one of the allowed values: 1, 2",
    "rules/orders.yaml: rules[R2] has `owner`, which is no field of it (a domain's own field is declared in docs/profile.yaml)",
    "glossary.yaml: terms[Parcel].scan must be equal to one of the allowed values: Shipped",
  ]);
});

test("the canvas and the glossary name the model's things", () => {
  const { errors } = run({
    "rules/orders.yaml": RULES.replace("packages: [Orders]", "packages: [Orders, Billing], types: [Invoice]"),
    "glossary.yaml": "terms:\n  - { term: Order, definition: d, model: [Order, Placed, Order.open, Order.closed] }\n",
  });
  assert.deepEqual(errors, [
    "rules/orders.yaml: canvas.packages names `Billing`, which is no package of the model",
    "rules/orders.yaml: canvas.types names `Invoice`, which is no type of the model",
    "glossary.yaml: Order names `Order.closed` — no type, event or state of the model",
  ]);
});

test("what waits on the owner: a cited rule to confirm, an open question a drawing issue names", () => {
  const { infos } = run({
    "rules/orders.yaml": RULES.replace("{ id: R2, title: An order ships, kind: behavioural, status: agreed", "{ id: R2, title: An order ships, kind: behavioural, status: to-confirm"),
    "questions.yaml": "questions:\n  - { id: Q-1, question: q, leaning: l, status: open, asked: { date: 2026-03-02 } }\n",
  }, { issues: [{ id: "D-1", why: "Q-1 open" }] });
  assert.deepEqual(infos, [
    "waiting on the owner: Order.open on Ship cites R2, to confirm",
    "waiting on the owner: 00-s cites R2, to confirm",
    "waiting on the owner: D-1 cites Q-1, an open question",
  ]);
});

test("the rulebook is generated from the docs, and a change to them makes it stale (ADR 0016 §9)", () => {
  const { docs, t } = run({ "rules/orders.yaml": RULES });
  const files = rulebook(docs, loadModel(MODEL), t);
  assert.deepEqual([...files.keys()].filter((f) => f.startsWith("rulebook/")), ["rulebook/orders.md", "rulebook/index.md"]);
  const page = files.get("rulebook/orders.md")!;
  assert.match(page, /### R2 — An order ships\n\n`agreed` · behavioural/);
  assert.match(page, /\*\*Model:\*\* `Order.open on Ship`/);
  assert.match(page, /\*\*Events out:\*\* Placed/);
  assert.deepEqual(staleFiles(docs.dir, files).length, files.size);
  for (const [f, text] of files) { mkdirSync(join(docs.dir, f, ".."), { recursive: true }); writeFileSync(join(docs.dir, f), text); }
  assert.deepEqual(staleFiles(docs.dir, files), []);
  writeFileSync(join(docs.dir, "rulebook/orders.md"), "edited by hand");
  writeFileSync(join(docs.dir, "rulebook/old.md"), "no longer generated");
  assert.deepEqual(staleFiles(docs.dir, files), ["rulebook/orders.md", "rulebook/old.md"]);
  assert.match(readFileSync(join(docs.dir, ".schemas/rules.schema.json"), "utf8"), /"\$schema"/);
});

test("a moved topic's types each need a glossary term — a warning until the word is there", () => {
  const { warnings } = run({ "rules/orders.yaml": RULES });
  assert.ok(warnings.includes("rules/orders.yaml: Order is one of the topic's types, and no glossary term names it — add the word for it to glossary.yaml"), warnings.join("\n"));
  const named = run({ "rules/orders.yaml": RULES, "glossary.yaml": "terms:\n  - { term: Order, definition: d, model: [Order] }\n" });
  assert.ok(!named.warnings.some((w) => w.includes("no glossary term")), named.warnings.join("\n"));
});

test("where a part runs is a decision too: a system, a domain or a relation cites rules (ADR 0018, ADR 0020)", () => {
  const model = `${MODEL}systems:
  Shop: { domain: Selling, packages: [Orders], why: [R1] }
  Web: { external: true, sends: [Order.Place], why: [R2] }
domains:
  Selling: { note: n, why: [R3] }
relations:
  - { upstream: Web, downstream: Shop, pattern: conformist, why: [R3] }
`;
  const { t, errors } = run({ "rules/orders.yaml": RULES }, { model });
  assert.deepEqual(errors, []);
  assert.deepEqual(t.cited.get("R1")!.model, ["system Shop", "Order"]);
  assert.deepEqual(t.cited.get("R2")!.model, ["system Web", "Order.open on Ship"]);
  assert.deepEqual(t.cited.get("R3")!.model, ["domain Selling", "relation Web → Shop"]);
});

test("a rule only the systems declaration cites needs no scenario; one a type cites too still does (ADR 0020 §7)", () => {
  const model = `${MODEL}systems:
  Shop: { packages: [Orders], why: [R1, R3] }
`;
  const { warnings } = run({ "rules/orders.yaml": RULES }, { model, scenarios: [["R2"]] });
  assert.ok(!warnings.some((w) => w.startsWith("R3 (agreed)")), "R3: where it runs, proven by the check");
  assert.ok(warnings.includes("R1 (agreed) — no scenario cites it (`why:`), and it says no `untraced:` why"), "R1 is behaviour of a type too");
});

test("the workbench reads the docs from their files as the check reads the folder, and links them to the model (ADR 0016 §9)", () => {
  const dir = new URL("../../examples/docs/lab/", import.meta.url).pathname;
  const onDisk = readDocs(dir);
  const inBrowser = docsFromFiles(docsFiles(dir));
  assert.deepEqual(inBrowser.topics, onDisk.topics);
  assert.deepEqual(inBrowser.glossary, onDisk.glossary);
  assert.deepEqual(inBrowser.questions, onDisk.questions);
  assert.deepEqual([...inBrowser.sessions], [...onDisk.sessions]);
  assert.ok(Object.values(inBrowser.logs).every((text) => text.length > 0), "each session's log, to show");

  const lab = loadModel(readFileSync(new URL("../../examples/models/lab.yaml", import.meta.url), "utf8"));
  const t = trace({ docs: inBrowser, model: lab, modelTexts: {}, scenarios: [], issues: [] });
  const d = docsData(inBrowser, t, lab);
  // Every citation the model makes points somewhere in the workbench, or says it does not.
  for (const cited of t.cited.values()) for (const where of cited.model) {
    const target = targetOf(lab, where);
    if (/^(system|sub-system|context|domain|relation) /.test(where)) assert.equal(target.kind, "none");
    else assert.notEqual(target.kind, "none", `${where} points nowhere`);
  }
  const transition = [...t.cited.values()].flatMap((c) => c.model).find((w) => / on /.test(w))!;
  assert.equal(targetOf(lab, transition).kind, "transition");
  // The other way: a type's rules, its package's, its words.
  const [type] = [...t.cited.values()].flatMap((c) => c.model).filter((w) => lab.aggregates[w]);
  assert.ok(type && rulesAbout(d, type).length > 0, "a type cited by a rule has that rule");
  const pkg = d.packageOf.get(type)!;
  assert.ok(rulesOfPackage(d, pkg).length >= rulesAbout(d, type).length, "its package has its rules, and its other types'");
  const named = (inBrowser.glossary ?? []).flatMap((term) => term.model ?? []).find((m) => lab.aggregates[m]);
  assert.ok(named && termsFor(d, named).length > 0, "a type the glossary names has its term");
});
