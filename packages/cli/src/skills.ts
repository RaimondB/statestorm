/**
 * `statestorm skills <domain folder>` (ADR 0017): the platform's skills and the shared rules of its
 * AGENTS.md, copied into a domain repo and kept in step — committed copies, so every agent sees
 * them before anything is installed. A manifest holds each copy's hash as written: a copy edited
 * in the domain repo is said, not overwritten; a skill the manifest does not name is the domain's
 * own and is never touched. A domain's additions to a skill go in DOMAIN.md beside the copy.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The platform's own: the repo's root, or the package's beside the bundled CLI.
const PLATFORM = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../" : "../", import.meta.url));
const MANIFEST = ".claude/skills/.statestorm.json";
const START = /<!-- statestorm:rules\b[^>]*-->/;
const END = "<!-- /statestorm:rules -->";

interface Manifest { skills: Record<string, string>; rules?: string }
export interface SkillsResult { changes: string[]; edited: string[]; notes: string[] }

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The copy of a platform skill: its text, the line saying where it comes from, and DOMAIN.md's pointer when there is one. */
export function copyOf(source: string, domainMd: boolean): string {
  const line = "<!-- Copied from statestorm by `statestorm skills` (ADR 0017): change it there. This repo's additions go in DOMAIN.md beside it. -->";
  const end = source.startsWith("---\n") ? source.indexOf("\n---\n", 4) : -1;
  const body = end < 0 ? `${line}\n\n${source}` : `${source.slice(0, end + 5)}\n${line}\n${source.slice(end + 5)}`;
  return domainMd ? `${body.trimEnd()}\n\n## This repo's additions\n\nRead [DOMAIN.md](DOMAIN.md) too: what this domain adds to this skill.\n` : body;
}

/** The marked block of an AGENTS.md, markers included, or undefined. */
function block(text: string): { at: number; text: string } | undefined {
  const start = START.exec(text);
  const end = start ? text.indexOf(END, start.index) : -1;
  return start && end >= 0 ? { at: start.index, text: text.slice(start.index, end + END.length) } : undefined;
}

export function syncSkills(domain: string, o: { check?: boolean; force?: boolean; platform?: string } = {}): SkillsResult {
  const platform = o.platform ?? PLATFORM;
  const root = resolve(domain);
  if (root === resolve(platform)) throw new Error("this is the statestorm repo: its skills are the source, not a copy");
  const out: SkillsResult = { changes: [], edited: [], notes: [] };
  const manifestFile = join(root, MANIFEST);
  const old: Manifest | undefined = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : undefined;
  const next: Manifest = { skills: {} };
  const write = (file: string, text: string) => { if (!o.check) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); } };

  // ---- the skills
  const sourceDir = join(platform, ".claude/skills");
  const names = readdirSync(sourceDir).filter((n) => existsSync(join(sourceDir, n, "SKILL.md"))).sort();
  for (const name of names) {
    const dir = join(root, ".claude/skills", name);
    const want = copyOf(readFileSync(join(sourceDir, name, "SKILL.md"), "utf8"), existsSync(join(dir, "DOMAIN.md")));
    const file = join(dir, "SKILL.md");
    const have = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    // Ours as written, or no manifest yet (the first run takes over the copies in git): ours to replace.
    const ours = have === undefined || !old || old.skills[name] === hash(have);
    if (have === want) { next.skills[name] = hash(want); continue; }
    if (!ours && !o.force) {
      out.edited.push(`.claude/skills/${name}/SKILL.md`);
      if (old?.skills[name]) next.skills[name] = old.skills[name]!;
      continue;
    }
    write(file, want);
    next.skills[name] = hash(want);
    out.changes.push(`${have === undefined ? "added" : "updated"} skill ${name}`);
  }
  for (const [name, h] of Object.entries(old?.skills ?? {})) {
    if (names.includes(name)) continue;
    const file = join(root, ".claude/skills", name, "SKILL.md");
    if (!existsSync(file)) continue;
    if (hash(readFileSync(file, "utf8")) !== h && !o.force) { out.edited.push(`.claude/skills/${name}/SKILL.md`); next.skills[name] = h; continue; }
    if (!o.check) {
      rmSync(file);
      if (readdirSync(join(file, "..")).length === 0) rmSync(join(file, ".."), { recursive: true });
    }
    out.changes.push(`removed skill ${name} (the platform no longer has it)`);
    if (existsSync(join(file, "..", "DOMAIN.md"))) out.notes.push(`.claude/skills/${name}/DOMAIN.md is left: its skill is gone — make it a skill of the domain's own, or drop it`);
  }

  // ---- the shared rules of AGENTS.md
  const shared = block(readFileSync(join(platform, "AGENTS.md"), "utf8"));
  const agentsFile = join(root, "AGENTS.md");
  if (!shared) throw new Error("the platform's AGENTS.md has no statestorm:rules block");
  if (!existsSync(agentsFile)) out.notes.push("no AGENTS.md: the shared rules were not copied");
  else {
    const text = readFileSync(agentsFile, "utf8");
    const mine = block(text);
    if (!mine) out.notes.push(`AGENTS.md has no shared rules block — put \`<!-- statestorm:rules -->\` and \`${END}\` where the shared rules go, and run this again`);
    else if (mine.text === shared.text) next.rules = hash(shared.text);
    else if (old?.rules !== undefined && hash(mine.text) !== old.rules && !o.force) { out.edited.push("AGENTS.md (the shared rules block)"); next.rules = old.rules; }
    else {
      write(agentsFile, text.slice(0, mine.at) + shared.text + text.slice(mine.at + mine.text.length));
      next.rules = hash(shared.text);
      out.changes.push("updated the shared rules in AGENTS.md");
    }
  }

  const manifest = `${JSON.stringify({ note: "Written by `statestorm skills` (ADR 0017): the hash of each copy as written. Do not edit.", ...next }, null, 2)}\n`;
  if (!existsSync(manifestFile) || readFileSync(manifestFile, "utf8") !== manifest) write(manifestFile, manifest);
  return out;
}

/** `skills <domain folder> [--check] [--force]`: exit 1 when, with --check, anything is behind; or when a copy was edited here. */
export function skills(args: string[]): number {
  const [dir] = args.filter((a) => !a.startsWith("--"));
  if (!dir || !existsSync(join(dir, "model.yaml"))) {
    console.error("usage: statestorm skills <domain folder> [--check] [--force]");
    return 2;
  }
  const check = args.includes("--check");
  const r = syncSkills(dir, { check, force: args.includes("--force") });
  for (const c of r.changes) console.log(`  ${check ? "behind:" : "✓"} ${c}`);
  for (const n of r.notes) console.log(`  · ${n}`);
  for (const e of r.edited) console.log(`  ✗ ${e} was edited in this repo — not overwritten. Move the change into DOMAIN.md beside it (or to the platform), then run again; --force takes the platform's`);
  if (!r.changes.length && !r.edited.length) console.log("statestorm skills: in step with the platform");
  else if (check && r.changes.length) console.log("statestorm skills: behind the platform — `statestorm skills .` brings them in");
  return r.edited.length || (check && r.changes.length) ? 1 : 0;
}
