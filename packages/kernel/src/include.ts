/**
 * ADR 0019: a model in several files. `model.yaml` may `include:` parts — each a YAML file with the
 * same sections — and a part may include parts of its own. They are merged into one model before
 * anything else is read; a name declared twice is an error that says where. No file system here:
 * the caller hands the files over by path, relative to the folder `model.yaml` is in, so the browser
 * and the command line load a model the same way.
 */
import { parse as parseYaml } from "yaml";
import { ModelError } from "./types.ts";

export const ROOT = "model.yaml";

/** Sections a part may hold; `context`, `overview` and `coverage` say something of the whole model, once. */
const MAPS = ["values", "packages", "aggregates", "policies", "systems", "contexts", "domains"] as const;
const LISTS = ["relations"] as const;
const ROOT_ONLY = ["context", "overview", "coverage"];

type Raw = Record<string, unknown>;

/** `a/b/../c.yaml` → `a/c.yaml`; a path that leaves the model's folder is refused. */
function normalise(path: string, where: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) throw new ModelError(`${where}: \`${path}\` leaves the model's folder — parts live beside model.yaml or below it`);
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

function parsed(text: string, file: string): Raw {
  let v: unknown;
  try { v = parseYaml(text); } catch (err) { throw new ModelError(`${file}: ${err instanceof Error ? err.message : String(err)}`); }
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ModelError(`${file}: expected a mapping of sections`);
  return v as Raw;
}

/** The parts a file includes, as paths relative to the model's folder, in the order given. */
export function includesOf(text: string, file = ROOT): string[] {
  const raw = parsed(text, file);
  if (raw.include === undefined) return [];
  if (!Array.isArray(raw.include)) throw new ModelError(`${file}: include: expected a list of files`);
  return raw.include.map((p) => {
    const path = String(p);
    if (!path.endsWith(".yaml")) throw new ModelError(`${file}: include: \`${path}\` — a part is a .yaml file`);
    return normalise(dirOf(file) + path, `${file}: include`);
  });
}

/**
 * Every file of a model, `model.yaml` and what it includes, read with `read` — for the command line,
 * which has a disk, and the browser, which has the files a folder gave it.
 */
export function modelFiles(read: (path: string) => string | undefined, root = ROOT): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (path: string, from: string | undefined) => {
    if (files[path] !== undefined) return;
    const text = read(path);
    if (text === undefined) throw new ModelError(`${from ?? path}: include: \`${path}\` — no such file`);
    files[path] = text;
    for (const p of includesOf(text, path)) visit(p, path);
  };
  visit(root, undefined);
  return files;
}

export interface Merged {
  raw: Raw;
  /** Where each declared name came from: `aggregates.Order` → `model/orders.yaml`. */
  sources: Record<string, string>;
}

/** The root and its parts as one model's sections. A part included twice, or in a circle, is an error. */
export function mergeModel(rootText: string, files: Record<string, string> = {}): Merged {
  const sources: Record<string, string> = {};
  const raw: Raw = {};
  const seen: string[] = [];
  const take = (path: string, text: string, chain: string[]) => {
    if (chain.includes(path)) throw new ModelError(`${chain.at(-1)}: include: \`${path}\` includes itself — ${[...chain, path].join(" → ")}`);
    if (seen.includes(path)) throw new ModelError(`${chain.at(-1)}: include: \`${path}\` is included twice — include each part once`);
    seen.push(path);
    const part = parsed(text, path);
    for (const key of Object.keys(part)) {
      if (key === "include") continue;
      if (path !== ROOT && ROOT_ONLY.includes(key)) throw new ModelError(`${path}: \`${key}\` belongs in model.yaml — it says something of the whole model, once`);
      if ((MAPS as readonly string[]).includes(key)) {
        const into = (raw[key] ??= {}) as Raw;
        if (part[key] === null || part[key] === undefined) continue;
        if (typeof part[key] !== "object" || Array.isArray(part[key])) throw new ModelError(`${path}: ${key}: expected a mapping`);
        for (const [name, body] of Object.entries(part[key] as Raw)) {
          const at = `${key}.${name}`;
          if (name in into) throw new ModelError(`${at}: declared in ${sources[at] ?? ROOT} and in ${path}`);
          into[name] = body;
          sources[at] = path;
        }
      } else if ((LISTS as readonly string[]).includes(key)) {
        if (!Array.isArray(part[key])) throw new ModelError(`${path}: ${key}: expected a list`);
        raw[key] = [...((raw[key] as unknown[] | undefined) ?? []), ...(part[key] as unknown[])];
      } else if (path === ROOT) {
        raw[key] = part[key];
      } else {
        throw new ModelError(`${path}: unknown section \`${key}\` (a part holds ${[...MAPS, ...LISTS].join(", ")}, include)`);
      }
    }
    for (const p of includesOf(text, path)) {
      const t = files[p];
      if (t === undefined) throw new ModelError(`${path}: include: \`${p}\` — no such file`);
      take(p, t, [...chain, path]);
    }
  };
  take(ROOT, rootText, []);
  return { raw, sources };
}

/** A model error, said with the file the name in it was declared in. */
export function located(err: ModelError, sources: Record<string, string>): ModelError {
  if (Object.values(sources).every((f) => f === ROOT)) return err;
  for (const m of err.message.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    for (const section of MAPS) {
      const file = sources[`${section}.${m[0]}`];
      if (file && file !== ROOT) return new ModelError(`${err.message} (in ${file})`);
    }
  }
  return err;
}
