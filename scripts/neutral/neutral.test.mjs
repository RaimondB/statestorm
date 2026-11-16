// The neutrality check on a made-up domain: its words are invented here, so the test itself
// leaks nothing. The neutral side is the bundled examples, as the check reads them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { imageFinding, matchersFor, neutralVocabulary, readAllow, scan, systemWordsOf, vocabularyOf } from "./lib.mjs";

const examples = fileURLToPath(new URL("../../packages/examples", import.meta.url));
const neutral = neutralVocabulary(examples);

function domain() {
  const dir = mkdtempSync(join(tmpdir(), "neutral-"));
  writeFileSync(join(dir, "model.yaml"), `
context: Zorbling
systems:
  Quillon: { packages: [Crates] }
  ZRB: { external: true }
aggregates:
  WidgetCrate:
    creators: [Stack]
    initial: stacked
    states:
      stacked: { on: { Stack: {}, Ship: { emit: [ CrateShipped: { crate: "\${id}" } ] } } }
  Sample:
    creators: [Collect]
    initial: a
    states: { a: {} }
`);
  mkdirSync(join(dir, "docs", "rules"), { recursive: true });
  writeFileSync(join(dir, "docs", "glossary.yaml"), "terms:\n  - { term: Crate run, aka: [XRN], definition: d }\n");
  writeFileSync(join(dir, "docs", "rules", "crates.yaml"), "rules:\n  - { id: ZX-12, title: t }\n  - { id: Q42, title: t }\n  - { id: D-1, title: t }\n");
  writeFileSync(join(dir, "docs", "questions.yaml"), "questions:\n  - { id: CRQ-7, question: q }\n");
  return dir;
}

const dir = domain();
const allow = readAllow("/nonexistent");
const matchers = matchersFor([{ ...vocabularyOf(dir), systemWords: systemWordsOf(dir, neutral) }], neutral, ["acmecorp"], allow.term, "the samples are in transit");
const hits = (text) => scan("f", text, matchers, allow).map((f) => f.found);

test("a domain's compound names, in any spelling, its acronyms and its phrases are found", () => {
  assert.deepEqual(hits("the WidgetCrate is stacked"), ["WidgetCrate"]);
  assert.deepEqual(hits("a widget crate, a widget-crate"), ["widget crate"]);
  assert.deepEqual(hits("on CrateShipped"), ["CrateShipped"]);
  assert.deepEqual(hits("ask ZRB first"), ["ZRB"]);
  assert.deepEqual(hits("the crate run leaves"), ["crate run"]);
  assert.deepEqual(hits("an XRN"), ["XRN"]);
});

test("a system's proper name is found as written, an ordinary word is not", () => {
  assert.deepEqual(hits("Quillon plans it"), ["Quillon"]);
  assert.deepEqual(hits("the quill is on the desk"), []);
});

test("a domain's ids are found — but not inside a number, and not a letter and a digit", () => {
  assert.deepEqual(hits("decided as ZX-12."), ["ZX-12"]);
  assert.deepEqual(hits("CRQ-7 asks"), ["CRQ-7"]);
  assert.deepEqual(hits("ZX-123 and ZX-12.5"), [], "another id, a version");
  assert.deepEqual(hits("<path d=\"M0,0 Q42,5\""), [], "an SVG path is not a rule");
  assert.deepEqual(hits("see D-1"), [], "any numbering scheme's");
});

test("what the examples say is the platform's own: never a leak", () => {
  assert.deepEqual(hits("a Sample is collected"), [], "a type the lab has too");
  const transit = matchersFor([{ names: new Set(), phrases: new Set(["In transit"]), ids: new Set() }], neutral, [], new Set(), "the samples are in transit");
  assert.equal(transit.length, 0);
});

test("an allowed term is not looked for, however it is spelled", () => {
  const m = matchersFor([vocabularyOf(dir)], neutral, [], new Set(["widgetcrate"]), "");
  assert.deepEqual(scan("f", "a widget-crate", m, allow), []);
});

test("an extra term is found anywhere, inside an address too", () => {
  assert.deepEqual(hits("Acmecorp says"), ["Acmecorp"]);
  const address = ["jo", "acmecorp.example"].join("@");
  const f = scan("the author", `Jo <${address}>`, matchers, { ...allow, email: new Set([address]) });
  assert.deepEqual(f.map((x) => x.why), ["a word of a domain (acmecorp)"], "the address is allowed, the company in it is not");
});

// The probes are put together at run time, so this file holds none of what it probes for.
const at = (...p) => p.join("@");
const dot = (...p) => p.join(".");

test("without any domain: addresses, private networks, home paths, other GitHub owners, images", () => {
  const a = readAllow("/nonexistent");
  a.github.add("someone");
  const found = (t) => scan("f", t, [], a).map((f) => f.why);
  assert.deepEqual(found(`mail ${at("jo", "example.org")}`), ["an e-mail address"]);
  assert.deepEqual(found(`at http://${dot(192, 168, 1, 20)}:8080 and ${dot(10, 0, 0, 1)}`), ["a private IP address", "a private IP address"]);
  assert.deepEqual(found(`version ${dot(1, 192, 168, 1, 2)}`), [], "not inside a longer number");
  assert.deepEqual(found(`cd /${"home"}/jo/repos`), ["a home directory"]);
  const gh = "github" + ".com";
  assert.deepEqual(found(`${gh}/other/repo and ${gh}:someone/repo`), ["a GitHub owner"]);
  assert.equal(imageFinding("shots/run.png", a).length, 1);
  a.file.add("docs/logo.svg");
  assert.equal(imageFinding("docs/logo.svg", a).length, 0);
});
