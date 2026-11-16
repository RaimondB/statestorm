// The neutrality check: nothing of a real domain — its words, its ids, its people's addresses — may
// enter this repository. The words to look for are never written down here, since that list would
// itself leak them: they are read, on the machine that commits, from the domain folders named in
// ~/.config/statestorm/config.json (`neutral.domains`), plus any extra `neutral.terms` there. Words
// the bundled examples use are the platform's own and always allowed. Some checks need no list at
// all: e-mail addresses, private IP addresses, home paths, GitHub owners, and images.
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(new URL("../../packages/kernel/package.json", import.meta.url));
const YAML = require("yaml");

const readYaml = (file) => {
  try {
    return YAML.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** `QCVisit` → ["QC", "Visit"]; `XRayTask#plan` → ["X", "Ray", "Task"]. */
export function partsOf(name) {
  return name.replace(/#.*$/, "").match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+[0-9]*/g) ?? [];
}

const IDENT = /^[A-Z][A-Za-z0-9]*(#[\w-]+)?$/;
const PHRASE = /^[A-Z][\w-]*( [\w-]+)+$/;

/** Every name a model gives: its types, commands, events, systems, packages, contexts, roles. */
function namesOfModel(file, seen = new Set()) {
  const names = new Set();
  if (seen.has(file) || !existsSync(file)) return names;
  seen.add(file);
  const doc = readYaml(file);
  const walk = (v) => {
    if (typeof v === "string") {
      for (const s of v.split(/[.\s,[\]]+/)) if (IDENT.test(s)) names.add(s.replace(/#.*$/, ""));
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, sub] of Object.entries(v)) {
        if (IDENT.test(k)) names.add(k.replace(/#.*$/, ""));
        else if (PHRASE.test(k)) names.add(k);
        walk(sub);
      }
    }
  };
  walk(doc);
  for (const part of [doc?.include ?? []].flat()) {
    if (typeof part === "string") for (const n of namesOfModel(resolve(dirname(file), part), seen)) names.add(n);
  }
  return names;
}

/** The glossary's terms and their other names, and every id the docs define. */
function termsOfDocs(docsDir) {
  const phrases = new Set();
  const ids = new Set();
  const g = readYaml(join(docsDir, "glossary.yaml"));
  for (const t of g?.terms ?? []) {
    for (const w of [t.term, ...(t.aka ?? [])]) if (typeof w === "string") phrases.add(w);
  }
  const files = [join(docsDir, "questions.yaml")];
  const rules = join(docsDir, "rules");
  if (existsSync(rules)) for (const f of readdirSync(rules)) if (f.endsWith(".yaml")) files.push(join(rules, f));
  for (const f of files) {
    const d = readYaml(f);
    for (const item of [...(d?.rules ?? []), ...(d?.questions ?? [])]) if (typeof item?.id === "string") ids.add(item.id);
  }
  return { phrases, ids };
}

/** A domain folder's vocabulary: model names, glossary phrases, rule and question ids. */
export function vocabularyOf(dir) {
  const names = namesOfModel(join(dir, "model.yaml"));
  const { phrases, ids } = existsSync(join(dir, "docs")) ? termsOfDocs(join(dir, "docs")) : { phrases: new Set(), ids: new Set() };
  const issues = readYaml(join(dir, "drawings", "issues.yaml"));
  for (const i of issues?.issues ?? []) if (typeof i?.id === "string") ids.add(i.id);
  return { names, phrases, ids };
}

/** What the bundled examples say: always allowed, whatever a domain also says. */
export function neutralVocabulary(examplesDir) {
  const names = new Set();
  const phrases = new Set();
  const ids = new Set();
  const models = join(examplesDir, "models");
  for (const f of existsSync(models) ? readdirSync(models) : []) {
    if (f.endsWith(".yaml")) for (const n of namesOfModel(join(models, f))) names.add(n);
  }
  const docs = join(examplesDir, "docs");
  for (const d of existsSync(docs) ? readdirSync(docs) : []) {
    const t = termsOfDocs(join(docs, d));
    t.phrases.forEach((p) => phrases.add(p));
    t.ids.forEach((i) => ids.add(i));
  }
  const words = new Set([...names, ...phrases].flatMap((n) => [n, ...partsOf(n), ...n.split(" ")]).map((w) => w.toLowerCase()));
  return { names, phrases, ids, words };
}

/** `Flow board`, `flow-board`, `FlowBoard` are one term to allow. */
export const normal = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ACRONYM = /^[A-Z][A-Z0-9]+$/;

/**
 * The patterns to look for. An acronym (`QC`) matches as written; a compound (`CrateRun`) as one
 * word or as its parts (`crate run`, `crate-run`), in any case; a phrase in any case; a single
 * ordinary word only when the model names a system or a domain by it, as written. An id (`AB-12`)
 * matches as written, but not inside a number (`Q42,5` in an SVG path is not `Q42`).
 */
export function matchersFor(vocabularies, neutral, extraTerms = [], allowed = new Set(), neutralText = "") {
  const out = new Map();
  const add = (label, re) => {
    const key = normal(label);
    // What the examples themselves say is the platform's own language (`in transit`, `L1`).
    if (allowed.has(key) || out.has(key) || re.test(neutralText)) return;
    out.set(key, { label, re });
  };
  for (const v of vocabularies) {
    for (const name of v.names) {
      if (neutral.names.has(name) || neutral.words.has(name.toLowerCase())) continue;
      if (name.includes(" ")) {
        add(name, new RegExp(`(?<![\\w])${name.split(" ").map(esc).join("[ _-]+")}(?![\\w])`, "i"));
        continue;
      }
      const parts = partsOf(name);
      for (const p of parts) if (ACRONYM.test(p) && p.length >= 2 && !neutral.words.has(p.toLowerCase()) && !/^[A-Z]\d+$/.test(p)) add(p, new RegExp(`(?<![\\w])${esc(p)}(?![\\w])`));
      if (parts.length >= 2) add(name, new RegExp(`(?<![\\w])${parts.map(esc).join("[ _-]?")}(?![\\w])`, "i"));
    }
    for (const phrase of v.phrases) {
      if (neutral.phrases.has(phrase) || neutral.words.has(phrase.toLowerCase())) continue;
      if (ACRONYM.test(phrase)) add(phrase, new RegExp(`(?<![\\w])${esc(phrase)}(?![\\w])`));
      else if (phrase.includes(" ")) add(phrase, new RegExp(`(?<![\\w])${phrase.split(/\s+/).map(esc).join("[ _-]+")}(?![\\w])`, "i"));
    }
    for (const id of v.ids) {
      // A letter and a digit (`D-1`, `F-3`) is any numbering scheme's; longer ids are a domain's own.
      if (neutral.ids.has(id) || /^[A-Z]-?\d$/.test(id)) continue;
      add(id, new RegExp(`(?<![\\w-])${esc(id)}(?![\\w-]|[,.]?\\d)`));
    }
    for (const sys of v.systemWords ?? []) add(sys, new RegExp(`(?<![\\w])${esc(sys)}(?![\\w])`));
  }
  // Extra terms are looked for anywhere, inside words too (a company in an e-mail address).
  for (const t of extraTerms) out.set(`extra:${normal(t)}`, { label: t, re: new RegExp(esc(t), "i") });
  return [...out.values()];
}

/** Single-word names of systems and domains: proper names, looked for even when ordinary words. */
export function systemWordsOf(dir, neutral) {
  const doc = readYaml(join(dir, "model.yaml"));
  const words = new Set();
  const walk = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, sub] of Object.entries(v)) {
      if (/^[A-Z][A-Za-z0-9]{2,}$/.test(k) && !neutral.names.has(k) && !neutral.words.has(k.toLowerCase())) words.add(k);
      if (sub && typeof sub === "object" && !Array.isArray(sub)) walk(sub.parts ?? sub.subsystems ?? {});
    }
  };
  walk(doc?.systems);
  walk(doc?.domains);
  return words;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|pdf|heic|svg)$/i;
const BUILTINS = [
  { label: "an e-mail address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, kind: "email" },
  { label: "a private IP address", re: /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/g },
  { label: "a home directory", re: /(\/home\/[a-z_][\w-]*|\/Users\/[A-Za-z][\w-]*|[A-Za-z]:\\Users\\[\w-]+)/g },
  { label: "a GitHub owner", re: /github\.com[:/]([A-Za-z0-9-]+)\//g, kind: "github" },
];

/** The allow file: `email: x`, `github: owner`, `file: path`, `term: word` (a line each). */
export function readAllow(file) {
  const allow = { email: new Set(), github: new Set(), file: new Set(), term: new Set() };
  if (!existsSync(file)) return allow;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(email|github|file|term):\s*(.+?)\s*$/.exec(line);
    if (m) allow[m[1]].add(m[1] === "term" ? normal(m[2]) : m[2]);
  }
  return allow;
}

/** The findings in one text: `{ where, line, found, why }`. */
export function scan(where, text, matchers, allow) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of matchers) {
      const hit = m.re.exec(line);
      if (hit) found.push({ where, line: i + 1, found: hit[0], why: `a word of a domain (${m.label})` });
    }
    for (const b of BUILTINS) {
      b.re.lastIndex = 0;
      for (const hit of line.matchAll(b.re)) {
        if (b.kind === "email" && allow.email.has(hit[0])) continue;
        if (b.kind === "github" && allow.github.has(hit[1])) continue;
        found.push({ where, line: i + 1, found: hit[0], why: b.label });
      }
    }
  });
  return found;
}

/** A file that is an image (or a PDF) and not allowed by name. */
export function imageFinding(path, allow) {
  return IMAGE.test(path) && !allow.file.has(path) ? [{ where: path, line: 0, found: path, why: "an image: screenshots of a domain stay out — allow it by name if it is the platform's own" }] : [];
}

/** ~/.config/statestorm/config.json's `neutral` (or STATESTORM_CONFIG's): domains and extra terms. */
export function readConfig() {
  const file = process.env.STATESTORM_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "statestorm", "config.json");
  if (!existsSync(file)) return { domains: [], terms: [], file, found: false };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file}: not JSON`);
  }
  const home = (p) => p.replace(/^~(?=\/|$)/, homedir());
  const domains = (raw.neutral?.domains ?? []).map(home);
  for (const d of domains) if (!existsSync(join(d, "model.yaml"))) throw new Error(`${file}: neutral.domains: ${d} has no model.yaml`);
  return { domains, terms: raw.neutral?.terms ?? [], file, found: true };
}
