/**
 * A domain's docs (ADR 0016) read from its docs/ folder and validated against the schemas merged with
 * the domain's profile. Their shapes, reading them from files and tracing them are `docs-core.ts`,
 * which the workbench reads in the browser; the rulebook is generated from the same (rulebook.ts).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { docsFromFiles, SCHEMA_NAMES, type DocsRead, type Profile, type ProfileField, type SchemaName } from "./docs-core.ts";

export * from "./docs-core.ts";

// ajv-formats is CommonJS: under Node its function is the module's default, under a bundler maybe the module itself.
type AddFormats = (ajv: Ajv2020) => unknown;
const addFormats = (((formats as unknown as { default: { default?: AddFormats } & AddFormats }).default.default)
  ?? (formats as unknown as { default: AddFormats }).default);

// The base schemas: the repo's schemas/, or the package's beside the bundled CLI.
const SCHEMAS = new URL(import.meta.url.endsWith(".ts") ? "../../../../schemas/" : "../schemas/", import.meta.url);
type Json = Record<string, any>;

export interface Docs extends DocsRead {
  dir: string;
  /** The schemas the files were checked against: the base, with the profile's fields added. */
  schemas: Record<SchemaName, Json>;
}

export function baseSchemas(): Record<SchemaName, Json> {
  return Object.fromEntries(SCHEMA_NAMES.map((n) => [n, JSON.parse(readFileSync(new URL(`${n}.schema.json`, SCHEMAS), "utf8"))])) as Record<SchemaName, Json>;
}

const newAjv = () => {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strictRequired: false });
  addFormats(ajv);
  return ajv;
};

/** Ajv's errors as one line each, naming the rule, term or question by its id where there is one. */
function explain(file: string, data: unknown, errors: ErrorObject[] | null | undefined): string[] {
  const out: string[] = [];
  for (const e of errors ?? []) {
    if (e.keyword === "if") continue;                         // its `then`/`else` says what is wrong
    const parts = e.instancePath.split("/").filter(Boolean);
    let at: unknown = data;
    const path: string[] = [];
    for (const p of parts) {
      at = (at as Json | undefined)?.[p];
      const name = at && typeof at === "object" ? (at as Json).id ?? (at as Json).term : undefined;
      path.push(/^\d+$/.test(p) ? `[${name ?? p}]` : `.${p}`);
    }
    const p = e.params as Json;
    const what =
      e.schemaPath.endsWith("/else/not") ? "has a `table`, which only kind: table has" :
      e.keyword === "not" ? "names an `enum` and a `vocabulary` — one or the other" :
      p.allowedValues ? `${e.message}: ${p.allowedValues.join(", ")}` :
      p.unevaluatedProperty ? `has \`${p.unevaluatedProperty}\`, which is no field of it (a domain's own field is declared in docs/profile.yaml)` :
      p.additionalProperty ? `has \`${p.additionalProperty}\`, which is no field of it` :
      e.message ?? e.keyword;
    const line = `${file}: ${path.join("").replace(/^\./, "") || "(the file)"} ${what}`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

function fieldSchema(f: ProfileField, values?: string[]): Json {
  const one: Json = f.enum ? { enum: f.enum } : values ? { enum: values } : { type: f.type ?? "string" };
  return { description: f.description, ...(f.list ? { type: "array", items: one, uniqueItems: true } : one) };
}

/**
 * The base schemas with the profile's fields added (ADR 0016 §8). A vocabulary is read from
 * docs/, checked, and becomes the field's enum. Returns the problems with the profile, too.
 */
export function mergedSchemas(dir: string, profile: Profile, base = baseSchemas()): { schemas: Record<SchemaName, Json>; errors: string[] } {
  const schemas = structuredClone(base);
  const errors: string[] = [];
  const vocabulary = newAjv().compile(base.vocabulary);
  const into = (schema: Json, def: string, fields: Record<string, ProfileField> | undefined, what: string) => {
    const target = schema.$defs[def];
    for (const [name, f] of Object.entries(fields ?? {})) {
      if (name in target.properties) { errors.push(`profile.yaml: fields.${what}.${name} is a field every domain has — a profile adds fields, it does not change them`); continue; }
      // A vocabulary that does not read is said once; the field stays declared, so the files using
      // it are not each told it does not exist.
      let values: string[] | undefined;
      if (f.vocabulary) {
        const file = join(dir, f.vocabulary);
        let data: unknown;
        try { data = existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : undefined; } catch (e) { errors.push(`${f.vocabulary}: ${e instanceof Error ? e.message : String(e)}`); }
        if (!existsSync(file)) errors.push(`profile.yaml: fields.${what}.${name}: no vocabulary at ${f.vocabulary}`);
        else if (data !== undefined && !vocabulary(data)) errors.push(...explain(f.vocabulary, data, vocabulary.errors));
        else if (data !== undefined) values = (data as { values: { value: string }[] }).values.map((v) => v.value);
      }
      target.properties[name] = fieldSchema(f, values);
      if (f.required) target.required = [...target.required, name];
    }
  };
  into(schemas.rules, "rule", profile.fields?.rule, "rule");
  into(schemas.glossary, "term", profile.fields?.term, "term");
  into(schemas.questions, "question", profile.fields?.question, "question");
  for (const s of Object.values(schemas)) delete s.$id;     // each is compiled on its own
  return { schemas, errors };
}

/** A docs folder's files by path under it: what `docsFromFiles` reads, and what a domain carries to the workbench. */
export function docsFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (p: string) => { files[p] = readFileSync(join(dir, p), "utf8"); };
  for (const f of ["profile.yaml", "glossary.yaml", "questions.yaml"]) if (existsSync(join(dir, f))) add(f);
  for (const [sub, ext] of [["rules", ".yaml"], ["decisions", ".md"]] as const) {
    if (!existsSync(join(dir, sub))) continue;
    for (const f of readdirSync(join(dir, sub)).filter((x) => x.endsWith(ext)).sort()) add(`${sub}/${f}`);
  }
  return files;
}

/** Reads a domain's docs/ folder. Nothing in it is required; what is there must be valid. */
export function readDocs(dir: string): Docs {
  const base = baseSchemas();
  let merged = mergedSchemas(dir, {}, base);
  const ajv = newAjv();
  const read = docsFromFiles(docsFiles(dir), {
    profile: (data) => {
      const errors: string[] = [];
      let profile: Profile = {};
      if (data !== undefined) {
        const valid = newAjv().compile(base.profile);
        if (valid(data)) profile = data as Profile;
        else errors.push(...explain("profile.yaml", data, valid.errors));
      }
      merged = mergedSchemas(dir, profile, base);
      return { profile, errors: [...errors, ...merged.errors] };
    },
    check: (name, file, data) => {
      const valid = ajv.compile(merged.schemas[name]);
      return valid(data) ? [] : explain(file, data, valid.errors);
    },
  });
  return { ...read, dir, schemas: merged.schemas };
}
