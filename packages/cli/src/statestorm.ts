#!/usr/bin/env node
/**
 * statestorm — the platform's one command, for a domain repo as for this one:
 *
 *   statestorm test  <domain folder> [--schedules] [--trace[=name]]
 *   statestorm check <domain folder> [--all] [--coverage] [--scenarios] [--issues] [--docs] [--propose] [--budget=<s>]
 *   statestorm docs  <domain folder>                                  its rulebook, from docs/ (ADR 0016)
 *   statestorm rules <domain folder> [<id>] [--topic=<t>] [--open] [--json]   its rules asked, not read
 *   statestorm skills <domain folder> [--check] [--force]             the platform's skills and shared rules, copied in (ADR 0017)
 *   statestorm context-map <domain folder> [--level=system|context|subsystem] [--system=<name>]   Mermaid (ADR 0018)
 *   statestorm sequence <domain folder> <scenario> [--level=…] [--open=<names>] [--unfold] [--ignored]   a scenario as a sequence diagram, Mermaid (ADR 0022)
 *   statestorm dev   <domain folder>... [--port=5181] [--name=<name>]   the workbench on these domains, read fresh on every load
 *   statestorm build <domain folder>... --out=<dir> [--name=<name>] [--without=<views>]   a static site, for any web server
 *   statestorm share <domain folder>... [--out=<dir/ or file.html>] [--name=<name>] [--examples] [--without=<views>] [--agenda=<name>]
 *                                                                     one HTML file with them inside, to open from disk:
 *                                                                     <name>-<yyyymmddhhmm>.html, traced to its commits
 *
 * `--without=context-map,sequence` leaves those views out of what is built or shared: no tab for
 * them, nothing opens on them. The views are overview, flow, structure, statecharts, context-map,
 * sequence; the workbench on the folder itself (`dev`) shows them all. `--agenda=<name>` (ADR 0025)
 * shares one domain with only the scenarios of `agendas/<name>.yaml`, opening on its first step.
 *
 * A domain folder holds model.yaml, scenarios/ and, if it has any, drawings/ (with issues.yaml) and
 * docs/ (its rules, glossary and questions; `check --docs` traces them alone, no runs). The
 * workbench names a domain after its folder; `--name` names it otherwise (one folder only) — a repo
 * checked out under its repo name still shows as the domain it is.
 * `test` and `check` also take the model, scenarios and drawings as separate paths. The site is the
 * prebuilt workbench; it loads the domains from `domains.json` beside it, next to its own examples.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@statestorm/scenarios/main";
import { check, docs, rules } from "@statestorm/ui/check";
import { VIEWS, type View } from "@statestorm/ui/domain";
import { parseAgenda } from "@statestorm/ui/agenda";
import { readDomain } from "./domains.ts";
import { skills } from "./skills.ts";
import { contextMapCommand, sequenceCommand } from "./architecture.ts";
import { ignored, platformCommit, sourceOf, stamp, type Source } from "./provenance.ts";

// The prebuilt site: beside the bundled CLI, or the UI package's build in the repo.
const SITE = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../ui/dist/" : "./site/", import.meta.url));
// The whole site as one HTML file (the UI's `--mode standalone` build), beside the bundled CLI or in the repo.
const STANDALONE = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../ui/dist-standalone/index.html" : "./standalone.html", import.meta.url));

const USAGE = `usage:
  statestorm test  <domain folder> [--schedules] [--trace[=name]]
  statestorm check <domain folder> [--all] [--coverage] [--scenarios] [--issues] [--docs] [--propose] [--budget=<s>]
  statestorm docs  <domain folder>
  statestorm rules <domain folder> [<id>] [--topic=<t>] [--open] [--json]
  statestorm skills <domain folder> [--check] [--force]
  statestorm context-map <domain folder> [--level=system|context|subsystem] [--system=<name>]
  statestorm sequence <domain folder> <scenario> [--level=domain|system|subsystem|aggregate] [--open=<name>,…] [--unfold] [--ignored]
  statestorm dev   <domain folder>... [--port=5181] [--name=<name>]
  statestorm build <domain folder>... --out=<dir> [--name=<name>] [--without=<views>]
  statestorm share <domain folder>... [--out=<dir/ or file.html>] [--name=<name>] [--examples] [--without=<views>] [--agenda=<name>]
                   --agenda: only the scenarios of agendas/<name>.yaml, opening on it (one domain folder)
                   --without: views to leave out — ${VIEWS.join(", ")}`;

const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const folders = (args: string[]) => args.filter((a) => !a.startsWith("--"));
/** `--without=context-map,sequence`: the views the domains are shown without (not in `dev`). */
function without(args: string[]): View[] {
  const given = flag(args, "without");
  if (given === undefined) return [];
  const asked = given.split(",").map((v) => v.trim()).filter((v) => v !== "");
  const wrong = asked.filter((v) => !(VIEWS as readonly string[]).includes(v));
  if (wrong.length > 0) throw new Error(`--without: no view called ${wrong.join(", ")} — the views are ${VIEWS.join(", ")}`);
  if (asked.length === VIEWS.length) throw new Error("--without: that is every view — leave at least one in");
  return asked as View[];
}

/** The domains as `domains.json` has them; `--name` renames the one folder given. */
function domains(args: string[]) {
  const dirs = folders(args);
  const name = flag(args, "name");
  if (name !== undefined && dirs.length !== 1) throw new Error("--name names one domain folder; give one");
  const hidden = without(args);
  return dirs.map((d) => ({ ...readDomain(d), ...(name ? { name } : {}), ...(hidden.length > 0 ? { without: hidden } : {}) }));
}

/**
 * `--agenda=<name>` (ADR 0025): the one domain with only its agenda's scenarios and that agenda, the
 * file opening on it. An agenda that does not read is an error: a meeting's file must show what it says.
 */
function onlyAgenda<D extends { name: string; files: Record<string, string> }>(list: D[], name: string): (D & { opens: string })[] {
  if (list.length !== 1) throw new Error("--agenda shares one domain folder; give one");
  const d = list[0]!;
  const text = d.files[`agendas/${name}.yaml`];
  const there = Object.keys(d.files).filter((p) => p.startsWith("agendas/")).map((p) => p.slice(8, -5));
  if (text === undefined) throw new Error(`--agenda: no agendas/${name}.yaml in ${d.name}${there.length ? ` — there are ${there.join(", ")}` : " — it has no agendas/"}`);
  const scenarios = Object.keys(d.files).filter((p) => /^scenarios\/[^/]+\.yaml$/.test(p)).map((p) => p.slice(10, -5));
  const { agenda, errors } = parseAgenda(text, `${name}.yaml`, scenarios);
  if (!agenda || errors.length > 0) throw new Error(`--agenda: ${errors.join("; ")}`);
  const keep = new Set(agenda.items.flatMap((it) => it.scenarios));
  const files = Object.fromEntries(Object.entries(d.files).filter(([p]) =>
    p.startsWith("scenarios/") ? keep.has(p.slice(10, -5)) : p.startsWith("agendas/") ? p === `agendas/${name}.yaml` : true));
  return [{ ...d, files, opens: name }];
}
const manifest = (args: string[]) => JSON.stringify({ domains: domains(args) });

function site(): string {
  if (!existsSync(join(SITE, "index.html"))) {
    throw new Error(`no built site at ${SITE} — in the statestorm repo, run \`pnpm build\` first`);
  }
  return SITE;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function dev(args: string[]): number {
  const dirs = folders(args);
  if (dirs.length === 0) { console.error(USAGE); return 2; }
  const names = domains(args).map((d) => d.name);   // a wrong folder is said now, not on the first load
  const root = site();
  const port = Number(flag(args, "port") ?? 5181);
  createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    try {
      if (path.endsWith("/domains.json")) {
        res.writeHead(200, { "content-type": TYPES[".json"]!, "cache-control": "no-store" }).end(manifest(args));
        return;
      }
      const file = normalize(join(root, path === "/" ? "index.html" : path));
      if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(e instanceof Error ? e.message : String(e));
    }
  }).on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE"
      ? `statestorm dev: port ${port} is in use — another workbench may be running there; choose another with --port=<n>`
      : `statestorm dev: ${e.message}`);
    process.exit(1);
  }).listen(port, () => {
    console.log(`statestorm: http://localhost:${port}/ — ${names.join(", ")}; reload the page to read the files again`);
  });
  return -1;                                     // keeps running
}

function build(args: string[]): number {
  const dirs = folders(args);
  const out = flag(args, "out");
  if (dirs.length === 0 || !out) { console.error(USAGE); return 2; }
  const json = manifest(args);
  mkdirSync(out, { recursive: true });
  cpSync(site(), out, { recursive: true });
  writeFileSync(join(out, "domains.json"), json);
  const left = without(args);
  console.log(`statestorm: the site with ${domains(args).map((d) => d.name).join(", ")} is in ${resolve(out)}`
    + (left.length > 0 ? `, without ${left.join(", ")}` : ""));
  return 0;
}

/**
 * One HTML file with the domains inside: opened from disk, mailed or put on a share, it needs no
 * server and no install (R37). Without `--examples` it shows the domains only.
 *
 * It is named `<name>-<yyyymmddhhmm>.html`, in the folder `--out` names — or `STATESTORM_SHARE_DIR`,
 * or `shareDir` in ~/.config/statestorm/config.json, or the domain folder's `exports/` (git-ignored:
 * it says so when it is not); `--out=<file.html>` names the file itself. It carries where it comes from — each domain's commit and branch, the platform's commit,
 * when it was shared — and says so when shared files are not committed, or the commit not pushed.
 */
function share(args: string[]): number {
  const agendaName = flag(args, "agenda");
  const list = agendaName ? onlyAgenda(domains(args), agendaName) : domains(args);
  if (list.length === 0) { console.error(USAGE); return 2; }
  if (!existsSync(STANDALONE)) {
    throw new Error(`no standalone site at ${STANDALONE} — in the statestorm repo, run \`pnpm build\` first`);
  }
  const at = new Date();
  const dirs = folders(args);
  const out = shareFile(flag(args, "out"), `${list[0]!.name}-${stamp(at)}.html`, join(dirs[0]!, EXPORTS));
  const sources = dirs.map((d) => sourceOf(d));
  const platform = platformCommit(dirs[0]);
  const domainsWithSource = list.map((d, i) => ({ ...d, source: sources[i] }));
  // `<` escaped, so no text in a model can close the script it is carried in.
  const json = JSON.stringify({ domains: domainsWithSource, examples: args.includes("--examples"), platform: { commit: platform }, sharedAt: at.toISOString() })
    .replace(/</g, "\\u003c");
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = esc(list.map((d) => d.name).join(", "));
  const said = list.map((d, i) => sourceLine(d.name, sources[i]!));
  const meta = [
    ...list.map((d, i) => `<meta name="statestorm:source" content="${esc(said[i]!)}">`),
    `<meta name="statestorm:platform" content="${esc(platform ?? "unknown")}">`,
    `<meta name="statestorm:shared" content="${at.toISOString()}">`,
  ].join("\n");
  const page = readFileSync(STANDALONE, "utf8")
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title} — statestorm</title>`)
    .replace("</head>", () => `<!-- statestorm share, ${at.toISOString()}: ${esc(said.join("; ")).replace(/--/g, "—")}; platform ${platform ?? "unknown"} -->\n${meta}\n<script type="application/json" id="statestorm-domains">${json}</script>\n</head>`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page);
  // The default folder lives in the domain repo: its exports are made from the repo, not part of it.
  if (out.startsWith(resolve(dirs[0]!, EXPORTS)) && sourceOf(dirs[0]!).commit && !ignored(dirs[0]!, EXPORTS)) {
    console.error(`statestorm share: ⚠ ${EXPORTS}/ is not git-ignored — add \`${EXPORTS}/\` to .gitignore, or the shared files will show as changes to commit`);
  }
  console.log(`statestorm: ${list.map((d) => d.name).join(", ")} in one file, ${out} (${(page.length / 1e6).toFixed(1)} MB) — open it in a browser, or send it`);
  for (const line of said) console.log(`  from ${line}`);
  if (agendaName) console.log(`  the agenda ${agendaName} only: ${Object.keys(list[0]!.files).filter((p) => p.startsWith("scenarios/")).length} scenarios, opening on its first`);
  if (without(args).length > 0) console.log(`  without ${without(args).join(", ")} — no tab for ${without(args).length > 1 ? "them" : "it"}`);
  // Not an error — a share of work in progress can be wanted — but never silent: the commit in the
  // file would not hold what the file shows.
  list.forEach((d, i) => {
    const s = sources[i]!;
    if (!s.commit) console.error(`statestorm share: ⚠ ${d.name} is not in git — nothing in the file traces it to a commit`);
    else if (s.uncommitted.length) console.error(`statestorm share: ⚠ ${d.name} has uncommitted work — the file shows it, commit ${s.commit.slice(0, 7)} does not:\n${s.uncommitted.map((f) => `    ${f}`).join("\n")}`);
    if (s.commit && s.pushed === false) console.error(`statestorm share: ⚠ ${d.name}'s commit ${s.commit.slice(0, 7)} is not pushed — nobody else can find it yet`);
  });
  return 0;
}

/** `name@commit (branch)`, and what of it is not committed. */
function sourceLine(name: string, s: Source): string {
  if (!s.commit) return `${name}: not in git`;
  return `${name}@${s.commit.slice(0, 12)}${s.branch ? ` (${s.branch})` : ""}${s.uncommitted.length ? ` + uncommitted changes to ${s.uncommitted.length} file${s.uncommitted.length === 1 ? "" : "s"}` : ""}`;
}

/** The folder of a domain where shared files go by default (git-ignored). */
const EXPORTS = "exports";

/** Where the shared file goes: `--out` (a file, or a folder), else the configured folder, else the domain's exports/. */
function shareFile(out: string | undefined, name: string, exports: string): string {
  const dir = (d: string) => resolve(d.replace(/^~(?=$|\/)/, homedir()), name);
  if (out) return out.endsWith("/") || (existsSync(out) && statSync(out).isDirectory()) ? dir(out) : resolve(out);
  const env = process.env.STATESTORM_SHARE_DIR;
  if (env) return dir(env);
  const config = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "statestorm", "config.json");
  if (existsSync(config)) {
    const shareDir = (JSON.parse(readFileSync(config, "utf8")) as { shareDir?: string }).shareDir;
    if (shareDir) return dir(shareDir);
  }
  return resolve(exports, name);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => number | Promise<number>> = { test, check, docs, rules, skills, dev, build, share, "context-map": contextMapCommand, sequence: sequenceCommand };
const run = command ? commands[command] : undefined;
if (!run) { console.error(USAGE); process.exit(2); }
try {
  const code = await run(rest);
  if (code >= 0) process.exit(code);
} catch (e) {
  console.error(`statestorm ${command}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
