/**
 * A domain folder — model.yaml (with the parts it includes), scenarios/*.yaml and, if it has any, drawings/*.yaml with
 * issues.yaml, its agendas/ (ADR 0025), and its docs/ (rules, glossary, questions, profile, the sessions' logs) — read into the shape the site loads from `domains.json`: its name (the folder's)
 * and its files by path. The site turns these into the same thing as a bundled example.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { modelFiles } from "@statestorm/kernel";

export interface DomainFiles {
  name: string;
  files: Record<string, string>;
}

export function readDomain(dir: string): DomainFiles {
  const root = resolve(dir);
  if (!existsSync(join(root, "model.yaml"))) throw new Error(`${dir}: no model.yaml — a domain folder holds model.yaml, scenarios/ and drawings/`);
  // model.yaml and the parts it includes (ADR 0019), by path relative to the folder.
  const files: Record<string, string> = modelFiles((p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : undefined));
  for (const sub of ["scenarios", "drawings", "agendas"]) {
    if (!existsSync(join(root, sub))) continue;
    for (const f of readdirSync(join(root, sub)).filter((x) => x.endsWith(".yaml")).sort()) {
      files[`${sub}/${f}`] = readFileSync(join(root, sub, f), "utf8");
    }
  }
  // The shared set-ups scenarios include (ADR 0029): every .yaml in a folder below scenarios/, but
  // the check's proposals.
  const below = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory()) below(path);
      else if (e.name.endsWith(".yaml")) files[path] = readFileSync(join(root, path), "utf8");
    }
  };
  if (existsSync(join(root, "scenarios"))) {
    for (const e of readdirSync(join(root, "scenarios"), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "proposed") below(`scenarios/${e.name}`);
    }
  }
  // The domain's decisions (ADR 0016), for the workbench's Docs view: their sources, not the rulebook.
  const docs = join(root, "docs");
  for (const f of ["profile.yaml", "glossary.yaml", "questions.yaml"]) {
    if (existsSync(join(docs, f))) files[`docs/${f}`] = readFileSync(join(docs, f), "utf8");
  }
  for (const [sub, ext] of [["rules", ".yaml"], ["decisions", ".md"]] as const) {
    if (!existsSync(join(docs, sub))) continue;
    for (const f of readdirSync(join(docs, sub)).filter((x) => x.endsWith(ext)).sort()) files[`docs/${sub}/${f}`] = readFileSync(join(docs, sub, f), "utf8");
  }
  return { name: basename(root), files };
}
