import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDomain } from "../src/domains.ts";
import { domainFromFiles } from "../../ui/src/domain.ts";
import { isDomainFile } from "../../ui/src/openFolder.ts";
import { docsDir, paths } from "../../ui/src/check/main.ts";
import { syncSkills } from "../src/skills.ts";

const examples = fileURLToPath(new URL("../../examples/", import.meta.url));
const cli = fileURLToPath(new URL("../src/statestorm.ts", import.meta.url));

/** The lab example laid out as a domain folder — what a domain repo holds. */
function labDomain(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "statestorm-")), "lab");
  mkdirSync(dir);
  cpSync(join(examples, "models/lab.yaml"), join(dir, "model.yaml"));
  cpSync(join(examples, "scenarios/lab"), join(dir, "scenarios"), { recursive: true });
  cpSync(join(examples, "drawings/lab"), join(dir, "drawings"), { recursive: true });
  cpSync(join(examples, "docs/lab"), join(dir, "docs"), { recursive: true });
  cpSync(join(examples, "agendas/lab"), join(dir, "agendas"), { recursive: true });
  return dir;
}

test("a domain folder is read as its name and its files: the model, the scenarios, the drawings, the docs", () => {
  const dir = labDomain();
  mkdirSync(join(dir, "scenarios/proposed"), { recursive: true });
  writeFileSync(join(dir, "scenarios/proposed/x.yaml"), "scenario: generated\n");
  writeFileSync(join(dir, "notes.md"), "not a domain file");
  const d = readDomain(dir);
  assert.equal(d.name, "lab");
  const keys = Object.keys(d.files);
  assert.ok(keys.includes("model.yaml") && keys.includes("drawings/issues.yaml") && keys.includes("scenarios/01-two-tubes-to-the-lab.yaml"));
  assert.ok(!keys.some((k) => k.includes("proposed") || k === "notes.md"), "generated proposals and other files are not the domain's");
  // Its docs' sources come along, for the Docs view; the generated rulebook and the vocabularies do not.
  assert.ok(keys.includes("docs/glossary.yaml") && keys.includes("docs/profile.yaml") && keys.some((k) => /^docs\/rules\/.+\.yaml$/.test(k)));
  assert.ok(keys.some((k) => /^docs\/decisions\/\d+-.+\.md$/.test(k)), "the sessions' logs");
  assert.ok(!keys.some((k) => k.startsWith("docs/rulebook/") || k.startsWith("docs/vocab/")));
  rmSync(join(dir, "model.yaml"));
  assert.throws(() => readDomain(dir), /no model\.yaml/);
});

test("the site reads a served domain exactly as the bundled example it was copied from", () => {
  const d = readDomain(labDomain());
  const ex = domainFromFiles(d.name, d.files);
  assert.equal(ex.text, readFileSync(join(examples, "models/lab.yaml"), "utf8"));
  assert.deepEqual(ex.scenarios.map((s) => s.file), readdirSync(join(examples, "scenarios/lab")).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort());
  assert.deepEqual(ex.drawings.map((x) => x.file), ["hospital-ward.yaml", "sample-to-result.yaml"]);
  assert.match(ex.issues ?? "", /id: L-1/);
  assert.ok(ex.docs?.["glossary.yaml"] && Object.keys(ex.docs).some((k) => k.startsWith("rules/")), "the docs, by path under docs/");
  assert.ok(!Object.keys(ex.parts ?? {}).some((k) => k.startsWith("docs/")), "and not as parts of the model");
});

test("Open folder takes the same files from a folder: the model, and YAML directly in scenarios/ and drawings/", () => {
  assert.ok(isDomainFile("model.yaml") && isDomainFile("scenarios/01-x.yaml") && isDomainFile("drawings/issues.yaml"));
  assert.ok(!isDomainFile("scenarios/proposed/x.yaml") && !isDomainFile("node_modules/a/model.yaml") && !isDomainFile("README.md"));
  assert.ok(isDomainFile("docs/glossary.yaml") && isDomainFile("docs/rules/orders.yaml") && isDomainFile("docs/decisions/01-2026-01-01-start.md"));
  assert.ok(!isDomainFile("docs/rulebook/orders.md") && !isDomainFile("docs/vocab/x.yaml"), "the generated rulebook is not read");
});

test("a domain folder stands for the model, scenarios and drawings — the paths still work", () => {
  const dir = labDomain();
  assert.deepEqual(paths([dir]), [join(dir, "model.yaml"), join(dir, "scenarios"), join(dir, "drawings")]);
  rmSync(join(dir, "drawings"), { recursive: true });
  assert.deepEqual(paths([dir]), [join(dir, "model.yaml"), join(dir, "scenarios")], "no drawings: none given");
  assert.deepEqual(paths(["m.yaml", "s"]), ["m.yaml", "s"]);
  assert.equal(docsDir([dir]), join(dir, "docs"), "its docs, found beside the model");
  assert.equal(docsDir(["m.yaml", "s", "--docs-dir=d"]), "d");
  rmSync(join(dir, "docs"), { recursive: true });
  assert.equal(docsDir([dir]), undefined);
});

test("statestorm docs writes the rulebook; check --docs traces the docs alone, and fails when the rulebook is stale (ADR 0016)", () => {
  const dir = labDomain();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  const d = run("docs", dir);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /none changed/, "the example's rulebook is up to date");
  const c = run("check", dir, "--docs");
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /20 rules in 7 topics/);
  assert.doesNotMatch(c.stdout, /Coverage/, "no runs");
  writeFileSync(join(dir, "docs/rules/patient.yaml"), readFileSync(join(dir, "docs/rules/patient.yaml"), "utf8").replace("A repeat is told once.", "A repeat is told twice."));
  const stale = run("check", dir, "--docs");
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /the rulebook is stale — run `statestorm docs`: rulebook\/patient\.md/);
  rmSync(join(dir, "docs"), { recursive: true });
  const none = run("check", dir, "--docs");
  assert.equal(none.status, 1);
  assert.match(none.stdout, /cites rules \(`why:`\), and there is no docs\/ folder/);
});

test("statestorm test and check run on a domain folder, and say how to call them when not", () => {
  const dir = labDomain();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  const t = run("test", dir);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout, /12\/12 runs passed/);
  const c = run("check", dir);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /0 errors/);
  assert.match(c.stdout, /sample-to-result\.yaml/, "its drawings were found");
  const none = run("frobnicate");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage:/);
  const wrong = run("dev", join(dir, "scenarios"));
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /no model\.yaml/);
});

test("statestorm build writes the site and domains.json, the domain named by --name if given", { skip: !existsSync(fileURLToPath(new URL("../../ui/dist/index.html", import.meta.url))) && "no built site (pnpm build)" }, () => {
  const dir = labDomain();
  const out = join(dir, "..", "site");
  const r = spawnSync(process.execPath, [cli, "build", dir, `--out=${out}`, "--name=samples"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(out, "index.html")));
  const json = JSON.parse(readFileSync(join(out, "domains.json"), "utf8")) as { domains: { name: string; files: Record<string, string> }[] };
  assert.deepEqual(json.domains.map((d) => d.name), ["samples"]);
  assert.ok(json.domains[0]!.files["model.yaml"]);
  const two = spawnSync(process.execPath, [cli, "build", dir, dir, `--out=${out}`, "--name=x"], { encoding: "utf8" });
  assert.equal(two.status, 2);
  assert.match(two.stderr, /--name names one domain folder/);
});

test("statestorm share writes one HTML file with the domain inside: nothing beside it to load", { skip: !existsSync(fileURLToPath(new URL("../../ui/dist-standalone/index.html", import.meta.url))) && "no standalone site (pnpm build)" }, () => {
  const dir = labDomain();
  writeFileSync(join(dir, "scenarios/99-closing.yaml"), "scenario: a model may say </script> in a comment\n");
  const out = join(dir, "..", "lab-to-share.html");
  const r = spawnSync(process.execPath, [cli, "share", dir, `--out=${out}`, "--name=samples"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const page = readFileSync(out, "utf8");
  assert.ok(!/<script[^>]*\ssrc=|<link[^>]*stylesheet/.test(page), "no script or style file to fetch");
  assert.match(page, /<title>samples — statestorm<\/title>/);
  const json = /<script type="application\/json" id="statestorm-domains">(.*?)<\/script>/s.exec(page)?.[1];
  assert.ok(json, "the domains are inside, in one script that a model's text cannot close");
  const inside = JSON.parse(json) as { domains: { name: string; files: Record<string, string> }[]; examples: boolean };
  assert.deepEqual(inside.domains.map((d) => d.name), ["samples"]);
  assert.match(inside.domains[0]!.files["scenarios/99-closing.yaml"]!, /<\/script>/);
  assert.equal(inside.examples, false, "the bundled examples are left out unless asked for");
});

test("statestorm share --without leaves views out of the file, and says so before it builds one", { skip: !existsSync(fileURLToPath(new URL("../../ui/dist-standalone/index.html", import.meta.url))) && "no standalone site (pnpm build)" }, () => {
  const dir = labDomain();
  const out = join(dir, "..", "lab-without.html");
  const r = spawnSync(process.execPath, [cli, "share", dir, `--out=${out}`, "--without=context-map, sequence"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /without context-map, sequence/, "it says what the reader will not see");
  const json = /<script type="application\/json" id="statestorm-domains">(.*?)<\/script>/s.exec(readFileSync(out, "utf8"))?.[1];
  const inside = JSON.parse(json!) as { domains: { without?: string[] }[] };
  assert.deepEqual(inside.domains[0]!.without, ["context-map", "sequence"]);
  // A view nobody has is a mistake worth saying, and a file with no view at all is not a share.
  const wrong = spawnSync(process.execPath, [cli, "share", dir, `--out=${out}`, "--without=erd"], { encoding: "utf8" });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /no view called erd — the views are overview, journey, flow/);
  const every = spawnSync(process.execPath, [cli, "share", dir, `--out=${out}`,
    "--without=overview,journey,flow,structure,statecharts,context-map,c4,sequence,docs"], { encoding: "utf8" });
  assert.equal(every.status, 2);
  assert.match(every.stderr, /that is every view/);
});

const standalone = existsSync(fileURLToPath(new URL("../../ui/dist-standalone/index.html", import.meta.url)));

test("statestorm share names the file by the time, says the commits it comes from, and warns of what is not committed", { skip: !standalone && "no standalone site (pnpm build)" }, () => {
  const dir = labDomain();
  const sh = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  sh("init", "-q"); sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  sh("add", "."); sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "the lab");
  const commit = sh("rev-parse", "HEAD").stdout.trim();
  const outDir = join(dir, "..", "shared");
  const env = { ...process.env, STATESTORM_SHARE_DIR: outDir, XDG_CONFIG_HOME: join(dir, "..", "no-config") };
  const share = () => spawnSync(process.execPath, [cli, "share", dir], { encoding: "utf8", env });

  const clean = share();
  assert.equal(clean.status, 0, clean.stderr);
  const files = readdirSync(outDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^lab-\d{12}\.html$/, "named <name>-<yyyymmddhhmm>.html, in the configured folder");
  const page = readFileSync(join(outDir, files[0]!), "utf8");
  assert.match(page, new RegExp(`<meta name="statestorm:source" content="lab@${commit.slice(0, 12)} \\(`));
  assert.match(page, /<meta name="statestorm:platform" content="[0-9a-f]{40}">/, "the platform's commit too");
  const json = JSON.parse(/<script type="application\/json" id="statestorm-domains">(.*?)<\/script>/s.exec(page)![1]!) as { domains: { source: { commit: string; uncommitted: string[] } }[] };
  assert.deepEqual([json.domains[0]!.source.commit, json.domains[0]!.source.uncommitted], [commit, []]);
  assert.doesNotMatch(clean.stderr, /uncommitted/);
  assert.match(clean.stderr, /is not pushed/, "no remote has it");

  writeFileSync(join(dir, "model.yaml"), `${readFileSync(join(dir, "model.yaml"), "utf8")}# a change\n`);
  writeFileSync(join(dir, "scenarios/99-new.yaml"), "scenario: not yet added\n");
  writeFileSync(join(dir, "notes.md"), "not shared, so not reported");
  const dirty = spawnSync(process.execPath, [cli, "share", dir, `--out=${join(dir, "..", "exact.html")}`], { encoding: "utf8", env });
  assert.equal(dirty.status, 0, "a warning, not an error");
  assert.match(dirty.stderr, /lab has uncommitted work — the file shows it, commit [0-9a-f]{7} does not:\n {4}model\.yaml\n {4}scenarios\/99-new\.yaml$/m);
  assert.match(readFileSync(join(dir, "..", "exact.html"), "utf8"), /\+ uncommitted changes to 2 files/, "--out=<file> is the file itself, and it says so too");

  const outside = spawnSync(process.execPath, [cli, "share", labDomain(), `--out=${outDir}/`], { encoding: "utf8", env });
  assert.match(outside.stderr, /lab is not in git — nothing in the file traces it to a commit/);
});

test("the share folder can be set once per machine, in ~/.config/statestorm/config.json", { skip: !standalone && "no standalone site (pnpm build)" }, () => {
  const dir = labDomain();
  const config = join(dir, "..", "config");
  mkdirSync(join(config, "statestorm"), { recursive: true });
  writeFileSync(join(config, "statestorm", "config.json"), JSON.stringify({ shareDir: join(dir, "..", "from-config") }));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: config };
  delete env.STATESTORM_SHARE_DIR;
  const r = spawnSync(process.execPath, [cli, "share", dir], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readdirSync(join(dir, "..", "from-config"))[0]!, /^lab-\d{12}\.html$/);
});

const templates = fileURLToPath(new URL("../../../templates/", import.meta.url));

test("the Claude Code hook regenerates the rulebook and traces the docs after an edit; other edits run nothing (ADR 0016)", () => {
  const dir = labDomain();
  const hook = (file: string) => spawnSync(process.execPath, [join(templates, "github/hooks/check-docs.mjs")], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, file) } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, STATESTORM: cli }, encoding: "utf8",
  });
  assert.equal(hook("README.md").status, 0, "not a domain file: nothing runs");
  const patient = join(dir, "docs/rules/patient.yaml");
  writeFileSync(patient, readFileSync(patient, "utf8").replace("A repeat is told once.", "A repeat is told twice."));
  const edited = hook("docs/rules/patient.yaml");
  assert.equal(edited.status, 0, `the rulebook is regenerated, so nothing is stale: ${edited.stderr}`);
  assert.match(readFileSync(join(dir, "docs/rulebook/patient.md"), "utf8"), /told twice/);
  writeFileSync(join(dir, "model.yaml"), readFileSync(join(dir, "model.yaml"), "utf8").replace("why: [R15]", "why: [R99]"));
  const broken = hook("model.yaml");
  assert.equal(broken.status, 2, "exit 2: Claude Code shows the agent stderr");
  assert.match(broken.stderr, /after editing model\.yaml/);
  assert.match(broken.stderr, /PatientView: why: R99 — no rule, question or drawing issue has this id/);
});

test("the same hook answers GitHub Copilot in its own shape: camelCase payload, additionalContext on stdout", () => {
  const dir = labDomain();
  writeFileSync(join(dir, "model.yaml"), readFileSync(join(dir, "model.yaml"), "utf8").replace("why: [R15]", "why: [R99]"));
  const env: NodeJS.ProcessEnv = { ...process.env, STATESTORM: cli };
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [join(templates, "github/hooks/check-docs.mjs")], {
    input: JSON.stringify({ toolName: "edit", toolArgs: JSON.stringify({ path: "model.yaml" }), cwd: dir }), env, encoding: "utf8",
  });
  assert.equal(r.status, 0, "Copilot reads stdout on success");
  assert.match((JSON.parse(r.stdout) as { additionalContext: string }).additionalContext, /PatientView: why: R99 — no rule/);
});

test("the git pre-commit hook refuses a commit while the docs do not check (ADR 0016)", () => {
  const dir = labDomain();
  const commit = () => spawnSync("sh", [join(templates, "git/pre-commit")], { cwd: dir, env: { ...process.env, STATESTORM: cli }, encoding: "utf8" });
  assert.equal(commit().status, 0, commit().stdout);
  writeFileSync(join(dir, "docs/rulebook/index.md"), "edited by hand");
  const stale = commit();
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /the rulebook is stale/);
  assert.match(stale.stderr, /statestorm docs \. regenerates the rulebook/);
});

test("statestorm rules asks the docs: the index, one id, a topic, what is open (ADR 0016 §11)", () => {
  const dir = labDomain();
  const rules = (...args: string[]) => spawnSync(process.execPath, [cli, "rules", dir, ...args], { encoding: "utf8" });
  assert.match(rules().stdout, /^20 rules in 7 topics: 17 agreed, 1 to confirm, 1 deferred, 1 superseded · 1 open question/);
  const r10 = rules("R10");
  assert.match(r10.stdout, /^R10 — Stability counts from when the run is expected\nagreed · behavioural · topic analysis · decided in session 2, 2026-03-09, answering Q-2 · supersedes R11\nrelease: 1/);
  assert.match(r10.stdout, /scenarios: {2}04-stability-expired/);
  assert.match(rules("R11").stdout, /since: {6}superseded by R10/);
  assert.match(rules("Q-1").stdout, /cited by: {3}L-3/);
  assert.match(rules("--topic=analysis").stdout, /events: {5}AnalysisMisplanned, AnalysisPlanned, SampleStopped, StabilityExpired/);
  assert.match(rules("--open").stdout, /^1 rule to confirm, 1 open question\n\nR16 — /);
  const json = JSON.parse(rules("R16", "--json").stdout) as { status: string; refines: string[]; openQuestions: string[] };
  assert.deepEqual([json.status, json.refines, json.openQuestions], ["to-confirm", ["R15"], ["Q-1"]]);
  const none = rules("R99");
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no rule, question or drawing issue has the id R99/);
});

// ---------------------------------------------------------------- skills (ADR 0017)

const platformSkills = fileURLToPath(new URL("../../../.claude/skills/", import.meta.url));
const skillNames = readdirSync(platformSkills).filter((n) => existsSync(join(platformSkills, n, "SKILL.md"))).sort();

/** A domain repo with an older copy of one skill, a skill of its own, and an AGENTS.md with the rules block. */
function domainWithSkills(): string {
  const dir = labDomain();
  mkdirSync(join(dir, ".claude/skills/model-check"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/model-check/SKILL.md"), "---\nname: model-check\n---\nan old copy\n");
  mkdirSync(join(dir, ".claude/skills/our-conventions"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/our-conventions/SKILL.md"), "the domain's own\n");
  writeFileSync(join(dir, "AGENTS.md"), "# Ours\n\n## The rules\n\n<!-- statestorm:rules -->\nold rules\n<!-- /statestorm:rules -->\n\n## Ours again\n");
  return dir;
}

test("statestorm skills copies the platform's skills and shared rules in; the domain's own are left alone (ADR 0017)", () => {
  const dir = domainWithSkills();
  const r = syncSkills(dir);
  assert.deepEqual(r.edited, []);
  assert.deepEqual(r.changes, [...skillNames.map((n) => `${n === "model-check" ? "updated" : "added"} skill ${n}`), "updated the shared rules in AGENTS.md"]);
  const copy = readFileSync(join(dir, ".claude/skills/scenario-loop/SKILL.md"), "utf8");
  assert.match(copy, /^---\nname: scenario-loop\n/, "the front matter stays first, so the skill still loads");
  assert.match(copy, /\n---\n\n<!-- Copied from statestorm by `statestorm skills` \(ADR 0017\)/);
  assert.equal(readFileSync(join(dir, ".claude/skills/our-conventions/SKILL.md"), "utf8"), "the domain's own\n");
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.match(agents, /^# Ours\n\n## The rules\n\n<!-- statestorm:rules — the same in every repo/);
  assert.match(agents, /7\. \*\*Commit in pieces\*\*[^]*<!-- \/statestorm:rules -->\n\n## Ours again\n$/);
  assert.deepEqual(syncSkills(dir).changes, [], "run again: nothing to do");
  assert.deepEqual(syncSkills(dir, { check: true }), { changes: [], edited: [], notes: [] });
});

test("a copy edited in the domain repo is said, not overwritten; DOMAIN.md is where a domain adds (ADR 0017)", () => {
  const dir = domainWithSkills();
  syncSkills(dir);
  const file = join(dir, ".claude/skills/model-check/SKILL.md");
  writeFileSync(file, `${readFileSync(file, "utf8")}\nOur own line.\n`);
  const r = syncSkills(dir);
  assert.deepEqual(r.edited, [".claude/skills/model-check/SKILL.md"]);
  assert.match(readFileSync(file, "utf8"), /Our own line\./, "kept");
  const cli1 = spawnSync(process.execPath, [cli, "skills", dir], { encoding: "utf8" });
  assert.equal(cli1.status, 1);
  assert.match(cli1.stdout, /model-check\/SKILL\.md was edited in this repo — not overwritten\. Move the change into DOMAIN\.md/);
  writeFileSync(join(dir, ".claude/skills/model-check/DOMAIN.md"), "Our own line.\n");
  assert.deepEqual(syncSkills(dir, { force: true }).changes, ["updated skill model-check"]);
  assert.match(readFileSync(file, "utf8"), /## This repo's additions\n\nRead \[DOMAIN\.md\]\(DOMAIN\.md\) too/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /Our own line/);
});

test("statestorm skills --check fails while behind; a skill the platform dropped is removed (ADR 0017)", () => {
  const dir = domainWithSkills();
  syncSkills(dir);
  const manifest = join(dir, ".claude/skills/.statestorm.json");
  const m = JSON.parse(readFileSync(manifest, "utf8")) as { skills: Record<string, string> };
  mkdirSync(join(dir, ".claude/skills/retired"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/retired/SKILL.md"), "gone from the platform\n");
  m.skills.retired = createHash("sha256").update("gone from the platform\n").digest("hex").slice(0, 16);
  writeFileSync(manifest, JSON.stringify(m));
  const check = spawnSync(process.execPath, [cli, "skills", dir, "--check"], { encoding: "utf8" });
  assert.equal(check.status, 1);
  assert.match(check.stdout, /behind: removed skill retired/);
  assert.ok(existsSync(join(dir, ".claude/skills/retired/SKILL.md")), "--check writes nothing");
  assert.equal(spawnSync(process.execPath, [cli, "skills", dir], { encoding: "utf8" }).status, 0);
  assert.ok(!existsSync(join(dir, ".claude/skills/retired")));
  assert.equal(spawnSync(process.execPath, [cli, "skills", dir, "--check"], { encoding: "utf8" }).status, 0);
});

test("by default statestorm share writes into the domain's exports/, and says so when git does not ignore it", { skip: !standalone && "no standalone site (pnpm build)" }, () => {
  const dir = labDomain();
  const sh = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  sh("init", "-q"); sh("add", "."); sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "the lab");
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, "..", "no-config") };
  delete env.STATESTORM_SHARE_DIR;
  const share = () => spawnSync(process.execPath, [cli, "share", dir], { encoding: "utf8", env });
  const first = share();
  assert.equal(first.status, 0, first.stderr);
  assert.match(readdirSync(join(dir, "exports"))[0]!, /^lab-\d{12}\.html$/);
  assert.match(first.stderr, /exports\/ is not git-ignored — add `exports\/` to \.gitignore/);
  writeFileSync(join(dir, ".gitignore"), "exports/\n");
  assert.doesNotMatch(share().stderr, /not git-ignored/);
});

test("statestorm sequence opens the lifelines it is told to, folds what repeats, and says what it left out (ADR 0022)", () => {
  const dir = labDomain();
  const seq = (...flags: string[]) => spawnSync(process.execPath, [cli, "sequence", dir, "01", ...flags], { encoding: "utf8" });
  const plain = seq();
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^sequenceDiagram\n/);
  assert.match(plain.stdout, /participant system_Lab as Lab/);
  assert.match(plain.stdout, /loop repeated for S1, S2/);
  const bench = seq("--open=Bench");
  assert.match(bench.stdout, /box transparent Diagnostics \/ Lab/, "a node opened by name opens what it is inside, too");
  assert.match(bench.stdout, /participant aggregate_Analysis as Analysis/);
  assert.match(bench.stdout, /%% left out: \d+ arrows of commands their receiver ignored/);
  assert.doesNotMatch(seq("--unfold").stdout, /loop /);
  const context = seq("--level=context");
  assert.equal(context.status, 2);
  assert.match(context.stderr, /a context is drawn as a band/);
  assert.match(seq("--open=Nowhere").stderr, /Nowhere: no domain, system, sub-system or aggregate/);
});

test("statestorm c4 puts the systems and contexts it is told to in focus, as Mermaid C4 (ADR 0036)", () => {
  const dir = labDomain();
  const c4 = (...flags: string[]) => spawnSync(process.execPath, [cli, "c4", dir, ...flags], { encoding: "utf8" });
  const context = c4("--system=Lab");
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /^C4Context\n  title System context of Lab\n  System\(system_Lab, "Lab"/);
  assert.doesNotMatch(context.stdout, /Messaging/, "a system that never talks to the focus is left out");
  const bench = c4("--diagram=container", "--context=Testing");
  assert.match(bench.stdout, /^C4Container\n/);
  assert.match(bench.stdout, /System_Boundary\(boundary_Lab, "Lab"\) \{\n    Container\(subsystem_Lab_Bench, "Bench"/);
  assert.doesNotMatch(bench.stdout, /Ordering/, "a sibling part the bench never talks to is left out");
  assert.equal(c4().status, 2, "nothing in focus");
  assert.match(c4("--diagram=deployment", "--system=Lab").stderr, /--diagram=deployment: context or container/);
  assert.match(c4("--context=Nowhere").stderr, /no bounded context called `Nowhere`/);
});

test("a domain's agendas are read with it, and are no part of the model (ADR 0025)", () => {
  const dir = labDomain();
  const d = readDomain(dir);
  assert.ok(d.files["agendas/ward-review.yaml"]);
  assert.ok(isDomainFile("agendas/ward-review.yaml"));
  const ex = domainFromFiles(d.name, d.files);
  assert.deepEqual(ex.agendas?.map((a) => a.file), ["ward-review"]);
  assert.ok(!Object.keys(ex.parts ?? {}).some((p) => p.startsWith("agendas/")), "an agenda is not a part the model may include");
});

test("check reads the agendas: one that names no scenario fails, one outside its scope warns (ADR 0025)", () => {
  const dir = labDomain();
  const ok = spawnSync(process.execPath, [cli, "check", dir, "--docs"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Agendas \(ADR 0025\)\n  ward-review: Ward review — from the ward to the result — 3 items, 6 scenarios · scope happy, deviation/);
  writeFileSync(join(dir, "agendas", "broken.yaml"), "title: Broken\nscope: [happy]\nitems:\n  - title: A\n    scenarios: [02, 99]\n    questions: [Q-404]\n");
  const bad = spawnSync(process.execPath, [cli, "check", dir, "--docs"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /✗ agendas\/broken\.yaml: item 1 \(A\): no scenario `99`/);
  assert.match(bad.stdout, /✗ agendas\/broken\.yaml: A raises Q-404 — no rule or question has this id/);
  assert.match(bad.stdout, /! agendas\/broken\.yaml: 02-haemolysed-at-the-lab carries none of the agenda's scope \(happy\)/);
});

test("statestorm share --agenda shares only the agenda's scenarios, opening on it (ADR 0025)", { skip: !standalone && "no standalone site (pnpm build)" }, () => {
  const dir = labDomain();
  const out = join(dir, "..", "meeting.html");
  const r = spawnSync(process.execPath, [cli, "share", dir, `--out=${out}`, "--agenda=ward-review"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the agenda ward-review only: 6 scenarios, opening on its first/);
  const json = JSON.parse(/<script type="application\/json" id="statestorm-domains">(.*?)<\/script>/s.exec(readFileSync(out, "utf8"))![1]!.replace(/\\u003c/g, "<"));
  const files = Object.keys(json.domains[0].files);
  assert.equal(json.domains[0].opens, "ward-review");
  assert.deepEqual(files.filter((f) => f.startsWith("scenarios/")).map((f) => f.slice(10, 12)).sort(), ["01", "02", "03", "04", "05", "07"]);
  assert.deepEqual(files.filter((f) => f.startsWith("agendas/")), ["agendas/ward-review.yaml"]);
  const wrong = spawnSync(process.execPath, [cli, "share", dir, `--out=${out}`, "--agenda=nope"], { encoding: "utf8" });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /--agenda: no agendas\/nope\.yaml in lab — there are ward-review/);
});

test("statestorm skills in a folder with no model yet says what is missing, not only how to call it", () => {
  const dir = mkdtempSync(join(tmpdir(), "statestorm-new-"));
  const r = spawnSync(process.execPath, [cli, "skills", dir], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a domain folder yet — it has no model\.yaml/);
  const none = spawnSync(process.execPath, [cli, "skills"], { encoding: "utf8" });
  assert.match(none.stderr, /^usage: statestorm skills/);
});

test("statestorm dev on a port already in use says so and how to choose another", async () => {
  const { createServer } = await import("node:net");
  const busy = createServer();
  await new Promise<void>((ok) => busy.listen(0, () => ok()));
  const port = (busy.address() as { port: number }).port;
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [cli, "dev", labDomain(), `--port=${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((ok) => {
      const t = setTimeout(() => { child.kill(); ok(null); }, 10000);
      child.on("exit", (c) => { clearTimeout(t); ok(c); });
    });
    assert.equal(code, 1, "it stops rather than hanging or throwing");
    assert.match(err, new RegExp(`port ${port} is in use .* --port=<n>`));
  } finally {
    busy.close();
  }
});

test("check says in its Systems section where two parts depend on each other (ADR 0035)", () => {
  const dir = labDomain();
  const file = join(dir, "model.yaml");
  // The stop heard step to step, as before the sample was its hub.
  writeFileSync(file, readFileSync(file, "utf8").replace("    in: source\n    on: SampleStopped\n    command: \"Sample#${event.sample}.Stop\"",
    "    in: target\n    on: SampleStopped\n    for_each_referrer: { via: Handling.sample, of: \"${event.sample}\" }\n    command: \"${item}.SampleStopped\""));
  const out = spawnSync(process.execPath, [cli, "check", dir], { encoding: "utf8" }).stdout;
  assert.match(out, /Systems \(ADR 0018, ADR 0020, ADR 0035\)\n(  .*\n)*  ! Bench and Ordering depend on each other — Bench through report_stop, Ordering through report_stop/);
});
