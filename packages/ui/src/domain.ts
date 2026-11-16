/** A model with its scenarios and drawings, as the workbench shows it. */
export interface Example {
  name: string;
  text: string;
  scenarios: { file: string; text: string }[];
  drawings: { file: string; text: string }[];
  issues?: string;
  /** The files `text` may include (ADR 0019), by path relative to its folder. */
  parts?: Record<string, string>;
  /** Views this domain is shown without (`statestorm share --without=…`): their tabs are not there. */
  without?: View[];
  /** Its docs (ADR 0016) by path under docs/ — rules, glossary, questions, profile, sessions' logs. */
  docs?: Record<string, string>;
  /** Its agendas (ADR 0025): `agendas/<file>.yaml`, the file without `.yaml`. */
  agendas?: { file: string; text: string }[];
  /** The agenda a shared file opens on (`statestorm share --agenda=`). */
  opens?: string;
}

/** The views of the centre pane, by the name the `--without` flag uses. */
export const VIEWS = ["overview", "journey", "flow", "structure", "statecharts", "context-map", "sequence", "docs"] as const;
export type View = typeof VIEWS[number];

const base = (path: string) => path.split("/").pop()!.replace(/\.yaml$/, "");

/** The files under docs/, by their path there — none: no `docs` at all. */
export function docsOf(files: Record<string, string>): { docs?: Record<string, string> } {
  const docs = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("docs/")).map(([p, t]) => [p.slice("docs/".length), t]));
  return Object.keys(docs).length > 0 ? { docs } : {};
}

/**
 * A domain folder's files by path — `model.yaml`, `scenarios/<file>.yaml`, `drawings/<file>.yaml`,
 * `docs/…`, `agendas/<file>.yaml` — as an example. Served ones (`domains.json`) and opened ones (Open folder…) come this way.
 */
export function domainFromFiles(name: string, files: Record<string, string>, without?: View[], opens?: string): Example {
  const under = (dir: string) => Object.entries(files)
    .filter(([p]) => p.startsWith(`${dir}/`) && p.endsWith(".yaml") && !p.slice(dir.length + 1).includes("/"))
    .map(([p, text]) => ({ file: base(p), text }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const drawn = under("drawings");
  const issues = drawn.find((d) => d.file === "issues");
  const agendas = under("agendas");
  return {
    name,
    text: files["model.yaml"] ?? "",
    scenarios: under("scenarios"),
    drawings: drawn.filter((d) => d !== issues).map((d) => ({ file: `${d.file}.yaml`, text: d.text })),
    ...(issues ? { issues: issues.text } : {}),
    parts: Object.fromEntries(Object.entries(files).filter(([p]) => !/^(scenarios|drawings|docs|agendas)\//.test(p))),
    ...(without && without.length > 0 ? { without } : {}),
    ...docsOf(files),
    ...(agendas.length > 0 ? { agendas } : {}),
    ...(opens ? { opens } : {}),
  };
}
