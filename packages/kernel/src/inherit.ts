/**
 * Inheritance as refinement — ADR 0008.
 *
 * `extends: Step` merges the abstract type's definition into the subclass before the
 * machine is built. The merge *is* the rule: a subclass may add substates beneath an
 * inherited **leaf**, add rules to inherited states, and override a rule by declaring the same
 * key — but wherever the ancestor declares a set of states, that set is fixed. Nothing
 * inherited can be removed, renamed, made (non-)final, or given a different initial state.
 *
 * That is what lets a parent roll up children of any subclass by reading only the abstract
 * states: `steps.any(in_progress)` means the same thing for a site visit and for a transfer.
 */
import { ModelError } from "./types.ts";

type Raw = Record<string, any>;

/** Marks a rule or relation as declared on an ancestor; read back by the loader. */
export const INHERITED = "__inherited_from";
/** The resolved ancestor chain, nearest first. */
export const ANCESTORS = "__ancestors";

function record(v: unknown, where: string): Raw {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ModelError(`${where}: expected a block`);
  return v as Raw;
}

function list(v: unknown): unknown[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

/** Every rule in a block, tagged with the type it came from (unless already tagged). */
function tagged(block: unknown, from: string, where: string): Raw {
  const out: Raw = {};
  for (const [key, body] of Object.entries(record(block, where))) {
    const rec = record(body, `${where}.${key}`);
    out[key] = { ...rec, [INHERITED]: rec[INHERITED] ?? from };
  }
  return out;
}

function mergeStates(parent: Raw, child: Raw, from: string, where: string): Raw {
  const out: Raw = {};
  for (const [name, p] of Object.entries(parent)) {
    out[name] = mergeState(record(p, `${where}.${name}`), record(child[name], `${where}.${name}`), from, `${where}.${name}`);
  }
  for (const name of Object.keys(child)) {
    if (!(name in parent)) {
      throw new ModelError(
        `${where}: \`${name}\` is not a state of ${from}. A subclass refines the states it inherits ` +
          `rather than adding beside them — put \`${name}\` inside one of ${from}'s leaf states (ADR 0008)`,
      );
    }
  }
  return out;
}

function mergeState(p: Raw, c: Raw, from: string, where: string): Raw {
  const pFinal = p.final === true;
  if (c.final !== undefined && (c.final === true) !== pFinal) {
    throw new ModelError(`${where}: a subclass cannot make an inherited state ${pFinal ? "non-" : ""}final (ADR 0008)`);
  }
  const pStates = record(p.states, `${where}.states`);
  const cStates = record(c.states, `${where}.states`);
  const out: Raw = { final: pFinal || undefined };

  if (Object.keys(pStates).length > 0) {
    if (c.initial !== undefined && c.initial !== p.initial) {
      throw new ModelError(`${where}: the initial substate is inherited from ${from} (\`${p.initial}\`) and cannot change`);
    }
    out.initial = p.initial;
    out.states = mergeStates(pStates, cStates, from, where);
  } else if (Object.keys(cStates).length > 0) {
    // Decomposing an inherited leaf: the one place a subclass adds states.
    if (pFinal) throw new ModelError(`${where}: a final state cannot be refined into substates`);
    out.initial = c.initial;
    out.states = cStates;
  }

  // Rules: inherited ones first, then the subclass's; the same key overrides.
  out.on = { ...tagged(p.on, from, `${where}.on`), ...record(c.on, `${where}.on`) };
  out.on_children = { ...tagged(p.on_children, from, `${where}.on_children`), ...record(c.on_children, `${where}.on_children`) };
  out.after = { ...tagged(p.after, from, `${where}.after`), ...record(c.after, `${where}.after`) };
  if (c.on_done !== undefined) out.on_done = c.on_done;
  else if (p.on_done !== undefined) out.on_done = { ...record(p.on_done, `${where}.on_done`), [INHERITED]: record(p.on_done, where)[INHERITED] ?? from };
  out.emit_on_entry = [...list(p.emit_on_entry), ...list(c.emit_on_entry)];
  out.emit_on_exit = [...list(p.emit_on_exit), ...list(c.emit_on_exit)];
  if (c.on_entry !== undefined || p.on_entry !== undefined) out.on_entry = c.on_entry ?? p.on_entry;
  // A state's `why:` stays where it was written (ADR 0016); an inherited rule keeps its own, as it is.
  if (c.why !== undefined) out.why = c.why;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function mergeFields(p: Raw, c: Raw, from: string, where: string): Raw {
  const out: Raw = { ...p };
  for (const [name, spec] of Object.entries(c)) {
    const mine = record(spec, `${where}.${name}`);
    const theirs = p[name] === undefined ? undefined : record(p[name], `${where}.${name}`);
    if (theirs && String(theirs.type ?? "number") !== String(mine.type ?? "number")) {
      throw new ModelError(`${where}.${name}: ${from} declares it as ${theirs.type ?? "number"}; a subclass cannot change its type`);
    }
    out[name] = { ...theirs, ...mine };
  }
  return out;
}

function mergeNamed(p: Raw, c: Raw, from: string, where: string, what: string): Raw {
  const out: Raw = {};
  for (const [name, spec] of Object.entries(p)) {
    const rec = record(spec, `${where}.${name}`);
    out[name] = { ...rec, [INHERITED]: rec[INHERITED] ?? from };
  }
  for (const [name, spec] of Object.entries(c)) {
    if (name in out) throw new ModelError(`${where}.${name}: ${from} already declares this ${what}`);
    out[name] = spec;
  }
  return out;
}

/**
 * Resolves `extends:` for every aggregate, nearest ancestor merged first. Returns the raw
 * definitions with inheritance applied; a definition without `extends` passes through.
 */
export function resolveInheritance(aggregates: Raw): Raw {
  const resolved: Raw = {};
  const visiting: string[] = [];

  const resolve = (name: string): Raw => {
    if (resolved[name]) return resolved[name];
    if (visiting.includes(name)) {
      throw new ModelError(`inheritance cycle: ${[...visiting.slice(visiting.indexOf(name)), name].join(" → ")}`);
    }
    const own = record(aggregates[name], name);
    if (own.extends === undefined) return (resolved[name] = { ...own, [ANCESTORS]: [] });
    const parentName = String(own.extends);
    if (!(parentName in aggregates)) throw new ModelError(`${name}: extends \`${parentName}\`, which is not an aggregate`);
    visiting.push(name);
    const parent = resolve(parentName);
    visiting.pop();
    if (parent.abstract !== true) {
      // Extending a concrete type would make every instance of it ambiguous in a roll-up.
      throw new ModelError(`${name}: extends \`${parentName}\`, which is not abstract — only abstract types are extended (ADR 0008)`);
    }
    if (own.initial !== undefined && own.initial !== parent.initial) {
      throw new ModelError(`${name}: the initial state is inherited from ${parentName} (\`${parent.initial}\`) and cannot change`);
    }
    // A subtype is what its supertype is: a refinement of an entity is an entity (ADR 0012 §1).
    if (own.kind !== undefined && parent.kind !== undefined && own.kind !== parent.kind) {
      throw new ModelError(`${name}: \`kind: ${own.kind}\` — ${parentName} is ${parent.kind}, and a subtype has its supertype's kind (ADR 0012)`);
    }
    const merged: Raw = {
      ...own,
      ...(own.kind ?? parent.kind) !== undefined ? { kind: own.kind ?? parent.kind } : {},
      abstract: own.abstract === true,
      initial: parent.initial,
      creators: [...new Set([...list(parent.creators), ...list(own.creators)])],
      data: mergeFields(record(parent.data, `${name}.data`), record(own.data, `${name}.data`), parentName, `${name}.data`),
      children: mergeNamed(record(parent.children, `${name}.children`), record(own.children, `${name}.children`), parentName, `${name}.children`, "relation"),
      references: mergeNamed(record(parent.references, `${name}.references`), record(own.references, `${name}.references`), parentName, `${name}.references`, "reference"),
      states: mergeStates(record(parent.states, `${name}.states`), record(own.states, `${name}.states`), parentName, `${name}.states`),
      [ANCESTORS]: [parentName, ...(parent[ANCESTORS] as string[])],
    };
    delete merged.extends;
    return (resolved[name] = merged);
  };

  for (const name of Object.keys(aggregates)) resolve(name);
  return resolved;
}
