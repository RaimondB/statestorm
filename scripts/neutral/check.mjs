// The neutrality check (lib.mjs says what it looks for, and why the list is not here).
//
//   node scripts/neutral/check.mjs --all            every file git would see, as it is on disk (pnpm verify)
//   node scripts/neutral/check.mjs --staged         what is about to be committed (the pre-commit hook)
//   node scripts/neutral/check.mjs --message <file> a commit message, its author and branch (commit-msg)
//
// Exits 1 on a finding. Without domains configured, only the checks that need no list run.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { imageFinding, matchersFor, neutralVocabulary, readAllow, readConfig, scan, systemWordsOf, vocabularyOf } from "./lib.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const SKIP = [/^pnpm-lock\.yaml$/, /^LICENSE/, /^scripts\/neutral\/allow\.txt$/];

const args = process.argv.slice(2);
const mode = args.includes("--staged") ? "staged" : args.includes("--message") ? "message" : "all";
const quiet = mode !== "all";

let config;
try {
  config = readConfig();
} catch (e) {
  console.error(`neutral: ${e.message}`);
  process.exit(1);
}
const allow = readAllow(`${root}scripts/neutral/allow.txt`);
const neutral = neutralVocabulary(`${root}packages/examples`);
const vocabularies = config.domains.map((d) => ({ ...vocabularyOf(d), systemWords: systemWordsOf(d, neutral) }));
const matchers = matchersFor(vocabularies, neutral, config.terms, allow.term, examplesText());
if (!config.domains.length && !quiet) {
  console.error(`neutral: no domains in ${config.file} (neutral.domains) — only the checks that need no word list ran`);
}

const findings = [];
if (mode === "message") {
  const file = args[args.indexOf("--message") + 1];
  if (!file || !existsSync(file)) {
    console.error("neutral: --message needs the commit message file");
    process.exit(2);
  }
  const message = readFileSync(file, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n");
  findings.push(...scan("the commit message", message, matchers, allow));
  findings.push(...scan("the author", git("var", "GIT_AUTHOR_IDENT").replace(/\s+\d+ [+-]\d{4}\s*$/, ""), matchers, { ...allow, email: new Set([...allow.email, ...authorEmails()]) }));
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  findings.push(...scan("the branch name", branch, matchers, allow));
  // The author's address itself: only the domain terms apply, checked above with it allowed as an address.
} else {
  const files = (mode === "staged" ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR") : git("ls-files", "--cached", "--others", "--exclude-standard")).split("\n").filter(Boolean);
  for (const f of files) {
    if (SKIP.some((re) => re.test(f))) continue;
    findings.push(...imageFinding(f, allow));
    if (/\.(png|jpe?g|gif|webp|bmp|tiff?|pdf|heic|ico|woff2?|ttf)$/i.test(f)) continue;
    let text;
    try {
      text = mode === "staged" ? git("show", `:${f}`) : readFileSync(`${root}${f}`, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    findings.push(...scan(f, text, matchers, allow));
  }
}

/**
 * The bundled examples' text, as last committed: a word they use is the platform's own. Taken from
 * HEAD so that a domain word added to an example is still caught in the commit that adds it.
 */
function examplesText() {
  try {
    const files = git("ls-tree", "-r", "--name-only", "HEAD", "packages/examples").split("\n").filter((f) => /\.(ya?ml|md|json)$/.test(f));
    return files.map((f) => git("show", `HEAD:${f}`)).join("\n");
  } catch {
    return ""; // no commit yet: nothing is the platform's own until something is
  }
}

/** The author's own address is not a leak of an address — but a domain term inside it still is. */
function authorEmails() {
  const m = /<([^>]+)>/.exec(git("var", "GIT_AUTHOR_IDENT"));
  return m ? [m[1]] : [];
}

if (findings.length) {
  console.error(`neutral: ${findings.length} finding${findings.length === 1 ? "" : "s"} — nothing of a real domain belongs in statestorm (AGENTS.md, "Keep it neutral"):`);
  for (const f of findings.slice(0, 100)) console.error(`  ${f.where}${f.line ? `:${f.line}` : ""}  ${f.found}  — ${f.why}`);
  if (findings.length > 100) console.error(`  … and ${findings.length - 100} more`);
  console.error("Say it in the neutral examples' words (lab, sales, claims). A false alarm: a line in scripts/neutral/allow.txt.");
  process.exit(1);
}
if (!quiet) console.log(`neutral: clean${config.domains.length ? ` (${config.domains.length} domain${config.domains.length === 1 ? "" : "s"}, ${matchers.length} terms)` : ""}`);
