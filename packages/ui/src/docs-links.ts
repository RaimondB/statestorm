/**
 * The domain's docs (ADR 0016) as the workbench links them: what a rule's citations point at in the
 * model, and — the other way — the rules, terms and topics about a type or a package. Read by the
 * Docs view, the structure view and the inspector alike.
 */
import type { Model } from "@statestorm/kernel";
import { allTransitions } from "./chart-layout.ts";
import { packageTypes } from "./boundaries.ts";
import type { DocsRead, Question, Rule, Term, Topic, Trace } from "./check/docs-core.ts";

export interface DocsData {
  docs: DocsRead;
  t: Trace;
  /** Every rule by its id, and the topic it is in. */
  rules: Map<string, Rule>;
  questions: Map<string, Question>;
  /** Each package's types, its aggregates' entities included (ADR 0013), and each type's package. */
  packaged: Map<string, string[]>;
  packageOf: Map<string, string>;
}

export function docsData(docs: DocsRead, t: Trace, model: Model): DocsData {
  const packaged = packageTypes(model);
  return {
    docs, t,
    rules: new Map(docs.topics.flatMap((tp) => tp.rules.map((r) => [r.id, r] as const))),
    questions: new Map(docs.questions.map((q) => [q.id, q] as const)),
    packaged,
    packageOf: new Map([...packaged].flatMap(([p, types]) => types.map((ty) => [ty, p] as const))),
  };
}

/** Where a citation points in the workbench. */
export type Target =
  | { kind: "type"; type: string }
  | { kind: "package"; name: string }
  | { kind: "state"; machine: string; ref: string }
  | { kind: "transition"; machine: string; id: string }
  | { kind: "policy"; machine: string }
  | { kind: "none" };

const lead = (where: string) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(where)?.[0];

/**
 * A model citation as `modelCitations` names it — `Type`, `Type.state`, a rule's id
 * (`Type.state on Command`), a policy, `package P`, or a part of the systems.
 */
export function targetOf(model: Model, where: string): Target {
  if (where.startsWith("package ")) return { kind: "package", name: where.slice("package ".length) };
  if (/^(system|sub-system|context|domain|relation) /.test(where)) return { kind: "none" };
  const type = lead(where);
  const machine = type ? model.aggregates[type] ?? model.policies[type] : undefined;
  if (!type || !machine) return { kind: "none" };
  if (where === type) return model.policies[type] ? { kind: "policy", machine: type } : { kind: "type", type };
  if (allTransitions(machine).some((x) => x.id === where)) return { kind: "transition", machine: type, id: where };
  if (where.startsWith(`${type}.`)) return { kind: "state", machine: type, ref: where.slice(type.length + 1).split(" ")[0]! };
  return { kind: "policy", machine: type };
}

/** The types a topic is about: its canvas's types, and its packages'. */
export function topicTypes(d: DocsData, topic: Topic): string[] {
  return [...new Set([...(topic.canvas?.packages ?? []).flatMap((p) => d.packaged.get(p) ?? []), ...(topic.canvas?.types ?? [])])];
}

/** The rules whose model citations are on this type — the type itself, its states and its rules. */
export function rulesAbout(d: DocsData, type: string): Rule[] {
  return [...d.rules.values()].filter((r) => (d.t.cited.get(r.id)?.model ?? []).some((w) => lead(w) === type && !w.startsWith("package ")));
}

/** The rules cited on a package, or on any type in it. */
export function rulesOfPackage(d: DocsData, name: string): Rule[] {
  const types = new Set(d.packaged.get(name) ?? []);
  return [...d.rules.values()].filter((r) => (d.t.cited.get(r.id)?.model ?? []).some((w) =>
    w === `package ${name}` || (!w.startsWith("package ") && types.has(lead(w) ?? ""))));
}

/** The glossary's terms that name this type (`model:`), or a state or event of it. */
export function termsFor(d: DocsData, type: string): Term[] {
  return (d.docs.glossary ?? []).filter((term) => (term.model ?? []).some((m) => m === type || m.startsWith(`${type}.`)));
}

/** The rules a model element cites, by the name `modelCitations` gives it: `system X`, `context C`… */
export function rulesCiting(d: DocsData, where: string): Rule[] {
  return [...d.rules.values()].filter((r) => (d.t.cited.get(r.id)?.model ?? []).includes(where));
}

/** The glossary's terms whose `model:` names this — an event, a command, a type. */
export function termsNaming(d: DocsData, name: string): Term[] {
  return (d.docs.glossary ?? []).filter((term) => (term.model ?? []).includes(name));
}

export function topicsFor(d: DocsData, type: string): Topic[] {
  return d.docs.topics.filter((tp) => topicTypes(d, tp).includes(type));
}

export function topicsOfPackage(d: DocsData, name: string): Topic[] {
  return d.docs.topics.filter((tp) => (tp.canvas?.packages ?? []).includes(name));
}
