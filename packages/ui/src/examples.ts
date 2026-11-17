/**
 * The bundled examples: each model under examples/models owns examples/scenarios/<name>/, and
 * the business's drawings of it, if any, under examples/drawings/<name>/ (MC-12) — with the
 * changes to them agreed so far in issues.yaml. A domain lives in a repo of its own and reaches the
 * site at runtime (servedDomains, Open folder…).
 */
import { domainFromFiles, setupFiles, type Example, type View } from "./domain.ts";

export type { Example };

const glob = {
  models: import.meta.glob("../../examples/models/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  scenarios: import.meta.glob("../../examples/scenarios/*/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  // The shared set-ups the scenarios include (ADR 0029): in folders below an example's scenarios.
  setups: import.meta.glob(["../../examples/scenarios/*/*/**/*.yaml", "!../../examples/scenarios/*/proposed/**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  drawings: import.meta.glob("../../examples/drawings/*/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  // The examples' decisions (ADR 0016) — the sources the Docs view reads, not the generated rulebook.
  docs: import.meta.glob(["../../examples/docs/*/*.yaml", "../../examples/docs/*/rules/*.yaml", "../../examples/docs/*/decisions/*.md"],
    { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  // The examples' agendas (ADR 0025).
  agendas: import.meta.glob("../../examples/agendas/*/*.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
};

/** A bundled example's docs, by path under its docs folder. */
function docsOfExample(name: string): { docs?: Record<string, string> } {
  const prefix = `../../examples/docs/${name}/`;
  const docs = Object.fromEntries(Object.entries(glob.docs).filter(([p]) => p.startsWith(prefix)).map(([p, t]) => [p.slice(prefix.length), t]));
  return Object.keys(docs).length > 0 ? { docs } : {};
}


const base = (path: string) => path.split("/").pop()!.replace(/\.yaml$/, "");
/** Files keyed by the model they belong to: the folder `at` from the end of the path names it. */
const byModel = (all: Record<string, string>, at: number) =>
  Object.entries(all).map(([p, text]) => ({ name: p.split("/").at(at)!, file: base(p), text }));

type Served = { name: string; files: Record<string, string>; without?: View[]; opens?: string };

/** A shared file (`statestorm share`) carries its domains inside it; `examples: false` hides ours. */
function embedded(): { domains?: Served[]; examples?: boolean } | undefined {
  const text = typeof document === "undefined" ? undefined : document.getElementById("statestorm-domains")?.textContent;
  return text ? JSON.parse(text) : undefined;
}

/** Whether the bundled examples are listed beside the domains: not in a file shared without them. */
export const showExamples = embedded()?.examples !== false;

/** The domains inside a shared file, or served beside the site (`statestorm dev` / `build`), if any. */
export async function servedDomains(): Promise<Example[]> {
  const inside = embedded();
  if (inside) return (inside.domains ?? []).map((d) => domainFromFiles(d.name, d.files, d.without, d.opens));
  try {
    const res = await fetch("./domains.json", { cache: "no-store" });
    if (!res.ok) return [];
    const json = await res.json() as { domains?: Served[] };
    return (json.domains ?? []).map((d) => domainFromFiles(d.name, d.files, d.without));
  } catch {
    return [];                                   // no server beside the site: the bundled examples only
  }
}

const models = byModel(glob.models, -1).map((m) => ({ ...m, name: m.file }));
const scenarios = byModel(glob.scenarios, -2);
const drawings = byModel(glob.drawings, -2);
const agendas = byModel(glob.agendas, -2);

export const EXAMPLES: Example[] = models
  .map(({ name, text }) => {
    const drawn = drawings.filter((d) => d.name === name);
    const issues = drawn.find((d) => d.file === "issues");
    const planned = agendas.filter((a) => a.name === name).map((a) => ({ file: a.file, text: a.text })).sort((a, b) => a.file.localeCompare(b.file));
    return {
      name,
      text,
      scenarios: scenarios.filter((s) => s.name === name)
        .map((s) => ({ file: s.file, text: s.text }))
        .sort((a, b) => a.file.localeCompare(b.file)),
      drawings: drawn.filter((d) => d !== issues)
        .map((d) => ({ file: `${d.file}.yaml`, text: d.text }))
        .sort((a, b) => a.file.localeCompare(b.file)),
      ...(issues ? { issues: issues.text } : {}),
      ...setupFiles(Object.fromEntries(Object.entries(glob.setups).map(([p, t]) => [p.replace("../../examples/", ""), t])), `scenarios/${name}`),
      ...docsOfExample(name),
      ...(planned.length > 0 ? { agendas: planned } : {}),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
