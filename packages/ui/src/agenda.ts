/**
 * Agendas (ADR 0025): a few of a domain's scenarios chosen for a meeting, under its topics, in the
 * order they are shown — `agendas/<name>.yaml`. Read here for the workbench, the check and `share`;
 * browser-safe.
 */
import { parse as parseYaml } from "yaml";
import { VIEWS, type View } from "./domain.ts";

export interface AgendaItem {
  title: string;
  /** The scenarios' files (without `.yaml`), resolved, in order: the first is the item's story. */
  scenarios: string[];
  note?: string;
  /** Rules and questions to raise, by id. */
  questions: string[];
  view?: View;
}

export interface Agenda {
  /** The file's name without `.yaml`: what `agenda=` and `--agenda=` name. */
  name: string;
  title: string;
  date?: string;
  /** Tags a scenario of this agenda should carry one of; empty: any. */
  scope: string[];
  view: View;
  items: AgendaItem[];
}

/** One scenario of an agenda, where the agenda bar steps: the n-th of all its scenarios, in order. */
export interface AgendaStep { item: number; at: number; file: string; view: View }

const TOP = new Set(["title", "date", "scope", "view", "items"]);
const ITEM = new Set(["title", "scenarios", "note", "questions", "view"]);

/** A scenario named by its number (`39a`: the file name up to its first dash) or its whole file name. */
export function resolveScenario(ref: string, files: readonly string[]): string | undefined {
  const r = ref.replace(/\.yaml$/, "");
  return files.find((f) => f === r) ?? files.find((f) => f.split("-")[0] === r);
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : undefined;

/**
 * An agenda file, against the scenarios there are (files without `.yaml`). Errors say what is wrong
 * and where; what can be read is read, so a typo in one item leaves the rest usable.
 */
export function parseAgenda(text: string, file: string, scenarioFiles: readonly string[]): { agenda?: Agenda; errors: string[] } {
  const name = file.split("/").pop()!.replace(/\.yaml$/, "");
  const errors: string[] = [];
  const at = `agendas/${name}.yaml`;
  let raw: unknown;
  // Every value as written — `[08, 21]` names scenarios 08 and 21, not the numbers 8 and 21.
  try { raw = parseYaml(text, { schema: "failsafe" }); } catch (e) { return { errors: [`${at}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`] }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [`${at}: an agenda is a mapping with a title and items`] };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!TOP.has(k)) errors.push(`${at}: unknown key \`${k}\` (expected ${[...TOP].join(", ")})`);
  const view = (v: unknown, where: string): View | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === "string" && (VIEWS as readonly string[]).includes(v)) return v as View;
    errors.push(`${where}: view \`${String(v)}\` is none of ${VIEWS.join(", ")}`);
    return undefined;
  };
  if (typeof r.title !== "string" || !r.title) errors.push(`${at}: no title`);
  const scope = r.scope === undefined ? [] : strings(r.scope);
  if (!scope) errors.push(`${at}: scope is a list of tags`);
  if (!Array.isArray(r.items) || r.items.length === 0) errors.push(`${at}: no items — an agenda lists its topics, each with its scenarios`);
  const items: AgendaItem[] = [];
  for (const [i, it] of (Array.isArray(r.items) ? r.items : []).entries()) {
    const where = `${at}: item ${i + 1}`;
    if (!it || typeof it !== "object" || Array.isArray(it)) { errors.push(`${where}: an item is a mapping with a title and scenarios`); continue; }
    const o = it as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!ITEM.has(k)) errors.push(`${where}: unknown key \`${k}\` (expected ${[...ITEM].join(", ")})`);
    const title = typeof o.title === "string" && o.title ? o.title : (errors.push(`${where}: no title`), `item ${i + 1}`);
    const refs = strings(o.scenarios);
    if (!refs || refs.length === 0) errors.push(`${where} (${title}): no scenarios`);
    const scenarios: string[] = [];
    for (const ref of refs ?? []) {
      const f = resolveScenario(ref, scenarioFiles);
      if (f) scenarios.push(f);
      else errors.push(`${where} (${title}): no scenario \`${ref}\``);
    }
    const questions = o.questions === undefined ? [] : strings(o.questions);
    if (!questions) errors.push(`${where} (${title}): questions is a list of rule or question ids`);
    if (o.note !== undefined && typeof o.note !== "string") errors.push(`${where} (${title}): note is text`);
    const v = view(o.view, where);
    items.push({ title, scenarios, questions: questions ?? [], ...(typeof o.note === "string" ? { note: o.note.trim() } : {}), ...(v ? { view: v } : {}) });
  }
  const agenda: Agenda = {
    name,
    title: typeof r.title === "string" ? r.title : name,
    ...(typeof r.date === "string" ? { date: r.date } : {}),
    scope: scope ?? [],
    view: view(r.view, at) ?? "overview",
    items,
  };
  return { agenda, errors };
}

/** Every scenario of an agenda in the order it is shown, with the view each opens in. */
export function stepsOf(a: Agenda): AgendaStep[] {
  return a.items.flatMap((it, item) => it.scenarios.map((file, at) => ({ item, at, file, view: it.view ?? a.view })));
}

/** Warnings: a scenario of the agenda that carries none of its `scope:` tags. */
export function outOfScope(a: Agenda, tagsOf: (file: string) => readonly string[]): string[] {
  if (a.scope.length === 0) return [];
  return [...new Set(a.items.flatMap((it) => it.scenarios))]
    .filter((f) => !tagsOf(f).some((t) => a.scope.includes(t)))
    .map((f) => `agendas/${a.name}.yaml: ${f} carries none of the agenda's scope (${a.scope.join(", ")}) — tagged ${tagsOf(f).join(", ") || "nothing"}`);
}
