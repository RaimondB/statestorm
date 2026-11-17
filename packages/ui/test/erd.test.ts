import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModel } from "@statestorm/kernel";
import { DEFAULT_ERD, layoutErd, linesOf, neighbourhood, structureOf } from "../src/erd.ts";

const examples = new URL("../../examples/", import.meta.url);
const load = (name: string) => loadModel(readFileSync(new URL(`models/${name}.yaml`, examples), "utf8"));
const lab = load("lab");

test("ownership, references and inheritance, each drawn once, on the type that declares it", () => {
  const s = structureOf(lab);
  const has = (kind: string, from: string, to: string) => s.rels.some((r) => r.kind === kind && r.from === from && r.to === to);
  assert.ok(has("owns", "Request", "Route"));
  assert.ok(has("extends", "Route", "Step") && has("extends", "SiteVisit", "Step"), "the route is a step too, rolled up the same way");
  assert.ok(has("owns", "Step", "Task"), "declared on the abstract type");
  assert.ok(!s.rels.some((r) => r.kind === "owns" && r.from === "Route" && r.to === "Task"), "inherited, so not drawn again");
  assert.ok(has("refers", "Handling", "Sample"));
  assert.ok(has("owns", "Route", "Link") && has("refers", "Link", "Step") && !has("refers", "Link", "Route"),
    "a link is the route's: it owns it, and it points at the steps it orders");
  assert.ok(has("extends", "CourierRun", "Transfer") && has("extends", "TubeRun", "Transfer"));
  assert.equal(s.rels.find((r) => r.kind === "owns" && r.from === "Step")!.label, "tasks · by stage");
  assert.deepEqual(s.rels.filter((r) => r.kind === "refers" && r.from === "Link").map((r) => r.label), ["before, after"],
    "two references to the same type are one line");
});

test("a box lists everything its type has — what it inherits first, saying from whom, then its own", () => {
  const s = structureOf(lab);
  const fields = (t: string) => s.types.find((x) => x.name === t)!.fields.map((f) => `${f.name}: ${f.type}${f.note ? ` ${f.note}` : ""}${f.inherited ? ` ▷ ${f.inherited}` : ""}`);
  assert.deepEqual(fields("Handling"), ["kind: string", "site: string", "sample: → Sample"]);
  assert.deepEqual(fields("AnalysisHandling"), ["kind: string ▷ Handling", "site: string ▷ Handling", "sample: → Sample ▷ Handling", "stability: string"]);
  assert.ok(fields("CourierRun").includes("origin: string ▷ Transfer"), "from the nearest supertype that declares it");
  assert.ok(s.rels.some((r) => r.kind === "refers" && r.from === "AnalysisHandling" && r.to === "Sample" && r.derivedFrom === "Handling"),
    "an inherited reference is a line from the concrete type too");
  assert.ok(fields("Route").includes('priority: string = "routine"'), "a default is said");
  assert.ok(fields("Request").includes("patient: string"), "no default, nothing said");
  assert.deepEqual(linesOf(s.types.find((x) => x.name === "SiteTask")!, { ...DEFAULT_ERD, inherited: false }), [], "inherited switched off: nothing of its own");
  assert.deepEqual(linesOf(s.types.find((x) => x.name === "Task")!, { ...DEFAULT_ERD, fields: false, states: true }).map((l) => l.text),
    ["created · in progress · completed", "partially completed · failed", "not needed"]);
});

test("laid out top-down: owners above what they own, supertypes above subtypes, nothing on top of anything", async () => {
  const s = structureOf(lab);
  const l = await layoutErd(s);
  const box = (t: string) => l.types.find((x) => x.name === t)!;
  assert.ok(box("Request").y < box("Route").y);
  // Without packages the lines decide the layers; with them, the packages do.
  const flat = await layoutErd(s, { ...DEFAULT_ERD, packages: false });
  const flatBox = (t: string) => flat.types.find((x) => x.name === t)!;
  assert.ok(flatBox("Task").y < flatBox("SiteTask").y);
  for (let i = 0; i < l.types.length; i++) for (let j = i + 1; j < l.types.length; j++) {
    const [a, b] = [l.types[i]!, l.types[j]!];
    const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    assert.ok(apart, `${a.name} and ${b.name} overlap`);
  }
  assert.ok(l.rels.every((r) => r.points.length >= 2), "every line is routed");
  const noInheritance = await layoutErd(s, { ...DEFAULT_ERD, inheritance: false });
  assert.ok(!noInheritance.rels.some((r) => r.kind === "extends"));
});

test("focusing on a type keeps it and everything one line away", () => {
  const near = neighbourhood(structureOf(lab), "Link");
  assert.deepEqual([...near].sort(), ["Link", "Route", "Step"]);
});

test("every box says what it is, and an aggregate that owns entities is drawn as its boundary", () => {
  const s = structureOf(lab);
  const t = (n: string) => s.types.find((x) => x.name === n)!;
  assert.deepEqual([t("Route").role, t("SiteHandling").role, t("TubeRow").role], ["aggregate", "entity", "value"]);
  assert.deepEqual(s.frames.sort(), ["Analysis", "Route", "SiteVisit", "Step", "Transfer"]);
  assert.equal(t("Task").frame, "Step", "abstract: nothing creates it, so it stays with the relation the abstract Step declares");
  assert.equal(t("SiteTask").frame, "SiteVisit", "a site visit creates its tasks (ADR 0013 §2)");
  assert.equal(t("SiteHandling").frame, "SiteVisit", "created by a site task, so inside the task's aggregate");
  assert.equal(t("AnalysisHandling").frame, "Analysis");
  assert.equal(t("RouteHandling").frame, "Route");
  assert.equal(t("Link").frame, "Route");
  assert.equal(t("TransferTask").frame, "Transfer", "planned by a courier run and a tube run alike: with the nearest supertype both are");
  assert.equal(t("TransferHandling").frame, "Transfer", "made by the shared task, so with it");
  assert.equal(t("Sample").frame, undefined, "an aggregate without entities needs no frame");
  const uses = (from: string, to: string) => s.rels.some((r) => r.kind === "uses" && r.from === from && r.to === to);
  assert.ok(uses("Route", "TubeRow") && uses("Route", "Instruction") && uses("Sample", "Scan"));
  assert.deepEqual(t("Scan").fields.map((f) => `${f.name}: ${f.type}`), ["scanId: string", "event: string", "site: string", "reason: string?"]);
});

test("laid out with each box inside its aggregate's frame", async () => {
  const l = await layoutErd(structureOf(lab));
  for (const t of l.types.filter((x) => x.frame)) {
    const f = l.frames.find((x) => x.name === t.frame)!;
    assert.ok(t.x >= f.x && t.y >= f.y && t.x + t.width <= f.x + f.width && t.y + t.height <= f.y + f.height, `${t.name} inside ${f.name}`);
  }
});

test("packages hold what they list and the entities of their aggregates — so ownership reads at a glance", () => {
  const s = structureOf(lab);
  const pkg = (n: string) => s.packages.find((p) => p.name === n)!.types.sort();
  assert.deepEqual(pkg("Steps"), ["Handling", "Step", "Task"], "the generic component");
  assert.deepEqual(pkg("Transfers"), ["CourierRun", "Transfer", "TransferHandling", "TransferTask", "TubeRun"], "the shared tasks come with the type both runs are");
  assert.deepEqual(pkg("Sites"), ["Clinic", "Lab", "Site", "SiteHandling", "SiteTask", "SiteVisit"]);
  assert.deepEqual(pkg("Analysis"), ["Analysis", "AnalysisHandling", "AnalysisTask"]);
  assert.deepEqual(pkg("Requests"), ["Instruction", "Link", "Request", "Route", "RouteHandling", "RouteTask", "TubeRow"]);
  const route = s.types.find((t) => t.name === "Route")!;
  assert.ok(route.fields.some((f) => f.name === "instructions" && f.type === "[Instruction] by kind"), "a list of values, one per kind (ADR 0015)");
  assert.deepEqual(s.errors, []);
  const wrong = loadModel(readFileSync(new URL("models/lab.yaml", examples), "utf8")
    .replace("types: [Step, Task, Handling]", "types: [Step, Task, Handling, SiteHandling]"));
  assert.deepEqual(structureOf(wrong).errors,
    ["packages: SiteHandling is listed in Steps, but it belongs to SiteVisit's aggregate, in Sites — an entity goes where its aggregate is (ADR 0013)"]);
});

test("laid out with each frame inside its package, and packages that can be switched off", async () => {
  const s = structureOf(lab);
  const l = await layoutErd(s);
  const inside = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
  const sites = l.packages.find((p) => p.name === "Sites")!;
  assert.ok(inside(l.frames.find((f) => f.name === "SiteVisit")!, sites));
  assert.ok(inside(l.types.find((t) => t.name === "SiteHandling")!, sites));
  // A refinement across packages is said in the box, not drawn: the generic package is a component.
  assert.ok(!l.rels.some((r) => r.kind === "extends" && r.from === "SiteTask"));
  assert.ok(l.types.find((t) => t.name === "SiteTask")!.refinesElsewhere);
  assert.ok(l.rels.some((r) => r.kind === "extends" && r.from === "CourierRun" && r.to === "Transfer"), "inside one package the line stays");
  const plain = await layoutErd(s, { ...DEFAULT_ERD, packages: false });
  assert.deepEqual(plain.packages, []);
  assert.ok(plain.rels.some((r) => r.kind === "extends" && r.from === "SiteTask"), "without packages, every refinement is a line");
});

test("inside a concrete package, the generic relation is drawn between the concrete types that use it", () => {
  const s = structureOf(lab);
  const derived = (from: string, to: string) => s.rels.find((r) => r.kind === "owns" && r.from === from && r.to === to);
  assert.deepEqual([derived("SiteVisit", "SiteTask")?.label, derived("SiteVisit", "SiteTask")?.derivedFrom], ["tasks", "Step"]);
  assert.equal(derived("SiteTask", "SiteHandling")?.derivedFrom, "Task");
  assert.ok(derived("CourierRun", "TransferTask") && derived("TubeRun", "TransferTask"), "both runs plan the shared task");
  assert.ok(derived("Analysis", "AnalysisTask") && derived("AnalysisTask", "AnalysisHandling") && derived("RouteTask", "RouteHandling"));
  assert.ok(!derived("SiteVisit", "SiteHandling"), "a handling's owner is its task, not the step that planned it");
  assert.equal(s.rels.filter((r) => r.kind === "owns" && r.from === "Route" && r.to === "Link").length, 1, "a relation the type declares itself is drawn once");
});
