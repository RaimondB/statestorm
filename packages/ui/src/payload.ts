/**
 * What a command's payload looks like, inferred from the model rather than declared in it —
 * so the fire panel can offer a form and a grid instead of a YAML box, without the model
 * language growing a command schema.
 *
 * - A field is anything the chart reads as `command.<field>` (and a child's `via:`).
 * - Its type comes from where it lands: assigned into a typed data field, or used in
 *   arithmetic or a comparison (number), or as an identity (string).
 * - A field is a *list of child items* when an event carries it whole (`${command.items}`)
 *   to a policy that fans out over it (`for_each: event.items`). That policy's command says
 *   what each row becomes and which columns a row has (`${item.sku}`, or just `${item}`).
 *
 * Inference follows a list through events and pass-through commands (`units: "${event.units}"`)
 * up to four hops, to the fan-out. Anything it cannot see stays reachable through the raw YAML
 * editor, which is why that editor is kept.
 */
import type { Json, MachineDef, Model, StateDef, TransitionDef } from "@statestorm/kernel";

export type ScalarType = "number" | "string" | "boolean" | "any";

export interface Column {
  name: string;
  type: ScalarType;
  /** When the cell is the id of an existing aggregate (a child references it). */
  refersTo?: string;
}

export type FieldShape =
  /** `options`: the only values the chart ever compares this field with — a choice, not text. */
  | { kind: "scalar"; name: string; type: ScalarType; options?: string[]; optional?: true }
  | {
      kind: "list";
      name: string;
      /** The aggregate type one row becomes, when the fan-out's command says. */
      child?: string;
      /** When each row is the id of an existing aggregate (the child references it). */
      refersTo?: string;
      /** The policy doing the fan-out. */
      policy: string;
      /** Empty: each row is a single value of `rowType`. */
      columns: Column[];
      rowType: ScalarType;
    };

function walk(states: Record<string, StateDef>, visit: (s: StateDef) => void): void {
  for (const s of Object.values(states)) {
    visit(s);
    walk(s.states, visit);
  }
}

function handlers(machine: MachineDef, name: string): TransitionDef[] {
  const out: TransitionDef[] = [];
  walk(machine.states, (s) => out.push(...(s.on[name] ?? [])));
  return out;
}

const WHOLE = (expr: string) => new RegExp(`^\\$\\{\\s*${expr.replace(".", "\\.")}\\s*\\}$`);

function texts(t: TransitionDef): string[] {
  // The identity first: it is what the form should ask for before anything else.
  const out = [t.idempotency, t.guard, ...Object.values(t.assign)].filter((x): x is string => !!x);
  for (const e of t.emit) out.push(...Object.values(e.payload).filter((v): v is string => typeof v === "string"));
  if (t.command) {
    out.push(t.command.target);
    out.push(...Object.values(t.command.payload).filter((v): v is string => typeof v === "string"));
  }
  // ADR 0012: what an owner sends its own entities reads the command too.
  for (const sd of t.send) {
    out.push(...[sd.to, sd.forEach].filter((x): x is string => !!x));
    out.push(...Object.values(sd.payload).filter((v): v is string => typeof v === "string"));
  }
  return out;
}

function fieldsRead(model: Model, machine: MachineDef, name: string): string[] {
  const fields = new Set<string>();
  for (const t of handlers(machine, name)) {
    for (const text of texts(t)) {
      for (const m of text.matchAll(/command\.([A-Za-z_][A-Za-z0-9_]*)/g)) fields.add(m[1]!);
    }
  }
  // A child's creating command is also read by the parent relation that adopts it.
  if (machine.creators.includes(name)) {
    for (const via of viasFor(model, machine.name)) {
      for (const m of via.matchAll(/command\.([A-Za-z_][A-Za-z0-9_]*)/g)) fields.add(m[1]!);
    }
  }
  return [...fields];
}

function viasFor(model: Model, childType: string): string[] {
  const lineage = [childType, ...(model.aggregates[childType]?.ancestors ?? [])];
  return [...new Set(Object.values(model.aggregates).flatMap((p) =>
    Object.values(p.children).filter((r) => lineage.includes(r.type)).map((r) => r.via)))];
}

/** The type a command field must have, judged by what the chart does with it. */
export function fieldType(model: Model, type: string, name: string, field: string): ScalarType {
  const machine = model.aggregates[type];
  if (!machine) return "any";
  const ref = `command.${field}`;
  const plain = new RegExp(`^\\s*command\\.${field}\\s*$`);
  for (const t of handlers(machine, name)) {
    for (const [target, expr] of Object.entries(t.assign)) {
      const def = machine.data[target];
      if (def && plain.test(expr)) return def.type === "value" || def.type === "list" ? "any" : def.type;
    }
  }
  const numeric = new RegExp(`(command\\.${field}\\s*[-+*/<>])|([-+*/<>]=?\\s*command\\.${field}\\b)`);
  for (const t of handlers(machine, name)) {
    if ([t.guard, ...Object.values(t.assign)].some((e) => e && numeric.test(e))) return "number";
  }
  for (const t of handlers(machine, name)) if (t.idempotency?.includes(ref)) return "string";
  if (machine.creators.includes(name) && viasFor(model, type).some((v) => v.includes(ref))) return "string";
  return "any";
}

/** `Type#${...}.Name` -> { type, name }, when the type and name are literal. */
function commandTarget(template: string): { type: string; name: string } | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:#.*)?\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(template);
  return m ? { type: m[1]!, name: m[2]! } : undefined;
}

function listShape(model: Model, machine: MachineDef, name: string, field: string, depth = 0): FieldShape | undefined {
  if (depth > 4) return undefined;
  // ADR 0012: an owner fanning out over the list to its own entities (`send: for_each`), or
  // passing it on whole to one of them — like a policy would, but inside the aggregate.
  const sent: FieldShape[] = [];
  for (const t of handlers(machine, name)) {
    for (const sd of t.send) {
      if (sd.to === undefined) continue;
      const target = commandTarget(sd.to);
      const fan = { command: { target: sd.to, payload: sd.payload }, forEach: sd.forEach } as unknown as TransitionDef;
      if (sd.forEach?.trim() === `command.${field}`) { sent.push(fanOut(model, `${machine.name}.${name}`, field, fan, target)); continue; }
      if (!target || !model.aggregates[target.type]) continue;
      for (const [k, v] of Object.entries(sd.payload)) {
        if (typeof v !== "string" || !WHOLE(`command.${field}`).test(v)) continue;
        const deeper = listShape(model, model.aggregates[target.type]!, target.name, k, depth + 1);
        if (deeper) sent.push({ ...deeper, name: field });
      }
    }
  }
  if (sent.length > 0) return merged(sent as Extract<FieldShape, { kind: "list" }>[]);
  for (const t of handlers(machine, name)) {
    for (const emit of t.emit) {
      for (const [key, value] of Object.entries(emit.payload)) {
        if (typeof value !== "string" || !WHOLE(`command.${field}`).test(value)) continue;
        for (const policy of Object.values(model.policies)) {
          const reactions: TransitionDef[] = [];
          walk(policy.states, (s) => reactions.push(...(s.on[emit.event] ?? [])));
          for (const fan of reactions) {
            if (!fan.command) continue;
            const target = commandTarget(fan.command.target);
            if (fan.forEach?.trim() === `event.${key}`) return allFanOuts(model, emit.event, key, field) ?? fanOut(model, policy.name, field, fan, target);
            // A policy passing the list on whole: follow it into the command it feeds.
            if (!target || !model.aggregates[target.type]) continue;
            for (const [k, v] of Object.entries(fan.command.payload)) {
              if (typeof v !== "string" || !WHOLE(`event.${key}`).test(v)) continue;
              const deeper = listShape(model, model.aggregates[target.type]!, target.name, k, depth + 1);
              if (deeper) return { ...deeper, name: field };
            }
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Several policies may fan out over the same list — one creates a task per origin from
 * `item.from`, another a handling per unit from `item.unit` — so a row's columns are the union
 * of what they all read.
 */
function allFanOuts(model: Model, event: string, key: string, field: string): FieldShape | undefined {
  const shapes: Extract<FieldShape, { kind: "list" }>[] = [];
  for (const policy of Object.values(model.policies)) {
    walk(policy.states, (s) => {
      for (const fan of s.on[event] ?? []) {
        if (fan.command && fan.forEach?.trim() === `event.${key}`) {
          shapes.push(fanOut(model, policy.name, field, fan, commandTarget(fan.command.target)) as Extract<FieldShape, { kind: "list" }>);
        }
      }
    });
  }
  if (shapes.length === 0) return undefined;
  return merged(shapes);
}

/** Several fan-outs over one list: a row's columns are the union of what they all read. */
function merged(shapes: Extract<FieldShape, { kind: "list" }>[]): FieldShape {
  const first = shapes.find((s) => s.refersTo) ?? shapes.find((s) => s.columns.length > 0) ?? shapes[0]!;
  const columns: Column[] = [];
  for (const shape of shapes) {
    for (const c of shape.columns) {
      const known = columns.find((x) => x.name === c.name);
      if (!known) columns.push({ ...c });
      else {
        if (known.type === "any") known.type = c.type;
        if (known.refersTo === undefined && c.refersTo !== undefined) known.refersTo = c.refersTo;
      }
    }
  }
  return { ...first, columns };
}

function fanOut(
  model: Model, policy: string, field: string, fan: TransitionDef, target: { type: string; name: string } | undefined,
): FieldShape {
  const columns: Column[] = [];
  let rowType: ScalarType = "any";
  let refersTo: string | undefined;
  const seen = new Set<string>();
  const scan = [fan.command!.target, ...Object.values(fan.command!.payload).filter((v): v is string => typeof v === "string")];
  for (const text of scan) {
    for (const m of text.matchAll(/\bitem\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      columns.push({ name: m[1]!, type: "any" });
    }
  }
  // A column's type is the type of the child command field it is passed into.
  for (const [childField, v] of Object.entries(fan.command!.payload)) {
    if (typeof v !== "string" || !target) continue;
    const childType = fieldType(model, target.type, target.name, childField);
    const col = /^\$\{\s*item\.([A-Za-z_][A-Za-z0-9_]*)\s*\}$/.exec(v);
    if (col) {
      const c = columns.find((x) => x.name === col[1]);
      if (c) {
        c.type = childType;
        for (const ref of Object.values(model.aggregates[target.type]?.references ?? {})) {
          if (new RegExp(`^\\s*command\\.${childField}\\s*$`).test(ref.via)) c.refersTo = ref.type;
        }
      }
    } else if (WHOLE("item").test(v)) {
      rowType = childType;
      // When the child holds the row as a reference, each row is an id of that type.
      const child = model.aggregates[target.type];
      for (const ref of Object.values(child?.references ?? {})) {
        if (new RegExp(`^\\s*command\\.${childField}\\s*$`).test(ref.via)) refersTo = ref.type;
      }
    }
  }
  const shape: FieldShape = { kind: "list", name: field, child: target?.type, policy, columns, rowType };
  if (refersTo) shape.refersTo = refersTo;
  return shape;
}

/** The string literals a field is compared with by `==` in this command's guards. */
function optionsOf(machine: MachineDef, name: string, field: string): string[] | undefined {
  const out = new Set<string>();
  const forward = new RegExp(`command\\.${field}\\s*==\\s*(?:'([^']*)'|"([^"]*)")`, "g");
  const backward = new RegExp(`(?:'([^']*)'|"([^"]*)")\\s*==\\s*command\\.${field}\\b`, "g");
  for (const t of handlers(machine, name)) {
    for (const re of [forward, backward]) {
      for (const m of (t.guard ?? "").matchAll(re)) out.add(m[1] ?? m[2]!);
    }
  }
  return out.size > 0 ? [...out] : undefined;
}

/** A declared field's type, as a form cell takes it. */
const scalarOf = (t: string): ScalarType => (t === "number" || t === "string" || t === "boolean" ? t : "any");

/**
 * What the command declares it takes (ADR 0012 §8) — said, not guessed. Inference still adds
 * what a declaration cannot say: which column holds an id of which aggregate, and the choices
 * a guard compares a field with.
 */
function declaredShape(model: Model, machine: MachineDef, name: string): FieldShape[] | undefined {
  const t = handlers(machine, name).find((h) => h.takes);
  if (!t?.takes) return undefined;
  const fields = "value" in t.takes ? model.values[t.takes.value]!.fields : t.takes.fields;
  const out = Object.entries(fields).map(([field, f]): FieldShape => {
    const row = model.values[f.type];
    if (f.list) {
      const inferred = listShape(model, machine, name, field);
      const cols = inferred?.kind === "list" ? inferred.columns : [];
      return {
        kind: "list", name: field, policy: inferred?.kind === "list" ? inferred.policy : `${machine.name}.${name}`,
        ...(inferred?.kind === "list" && inferred.child ? { child: inferred.child } : {}),
        ...(inferred?.kind === "list" && inferred.refersTo ? { refersTo: inferred.refersTo } : {}),
        columns: row
          ? Object.entries(row.fields).map(([c, cf]) => {
              const known = cols.find((x) => x.name === c);
              return { name: c, type: scalarOf(cf.type), ...(known?.refersTo ? { refersTo: known.refersTo } : {}) };
            })
          : [],
        rowType: row ? "any" : scalarOf(f.type),
      };
    }
    const options = optionsOf(machine, name, field);
    return {
      kind: "scalar", name: field, type: options ? "string" : scalarOf(f.type),
      ...(options ? { options } : {}), ...(f.optional ? { optional: true as const } : {}),
    };
  });
  // Read by the chart but not declared: context a policy passes along, still worth a field.
  for (const field of fieldsRead(model, machine, name)) {
    if (!(field in fields)) out.push({ kind: "scalar", name: field, type: fieldType(model, machine.name, name, field), optional: true });
  }
  return out;
}

export function payloadShape(model: Model, type: string, name: string): FieldShape[] {
  const machine = model.aggregates[type];
  if (!machine) return [];
  const declared = declaredShape(model, machine, name);
  if (declared) return declared;
  return fieldsRead(model, machine, name).map((field): FieldShape => {
    const list = listShape(model, machine, name, field);
    if (list) return list;
    const options = optionsOf(machine, name, field);
    const shape: FieldShape = { kind: "scalar", name: field, type: options ? "string" : fieldType(model, type, name, field) };
    if (options) shape.options = options;
    return shape;
  });
}

// ---------------------------------------------------------------- form values

export type Row = Record<string, string>;
export type FormValue = Record<string, string | boolean | Row[]>;

export function emptyForm(shape: FieldShape[]): FormValue {
  const out: FormValue = {};
  for (const f of shape) {
    if (f.kind === "list") out[f.name] = [{}];
    else out[f.name] = f.type === "boolean" ? false : "";
  }
  return out;
}

/** A cell's text as the value the model expects. Throws with a message a person can act on. */
export function convert(text: string, type: ScalarType, label: string): Json {
  const t = text.trim();
  switch (type) {
    case "number": {
      const n = Number(t);
      if (t === "" || Number.isNaN(n)) throw new Error(`${label} must be a number, not “${text}”`);
      return n;
    }
    case "boolean": return t === "true";
    case "string": return text;
    case "any":
      if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
      if (t === "true" || t === "false") return t === "true";
      return text;
  }
}

/**
 * The form as a payload. Empty fields and wholly empty rows are left out — and reported, so
 * the person knows the model will see them as missing rather than as "".
 */
export function toPayload(shape: FieldShape[], form: FormValue): { payload: Record<string, Json>; missing: string[] } {
  const payload: Record<string, Json> = {};
  const missing: string[] = [];
  for (const f of shape) {
    const v = form[f.name];
    if (f.kind === "scalar") {
      if (f.type === "boolean") { payload[f.name] = v === true; continue; }
      if (typeof v !== "string" || v.trim() === "") { if (!f.optional) missing.push(f.name); continue; }
      payload[f.name] = convert(v, f.type, f.name);
      continue;
    }
    const rows = (Array.isArray(v) ? v : []).filter((r) => Object.values(r).some((c) => c.trim() !== ""));
    payload[f.name] = rows.map((r, i): Json => {
      if (f.columns.length === 0) return convert(r[""] ?? "", f.rowType, `${f.name} row ${i + 1}`);
      const obj: Record<string, Json> = {};
      for (const c of f.columns) {
        const cell = r[c.name] ?? "";
        if (cell.trim() !== "") obj[c.name] = convert(cell, c.type, `${f.name} row ${i + 1} ${c.name}`);
      }
      return obj;
    });
  }
  return { payload, missing };
}

/** The other direction, so switching from the YAML editor back to the form keeps the values. */
export function fromPayload(shape: FieldShape[], payload: Record<string, Json>): FormValue {
  const form = emptyForm(shape);
  for (const f of shape) {
    const v = payload[f.name];
    if (v === undefined) continue;
    if (f.kind === "scalar") {
      form[f.name] = f.type === "boolean" ? v === true : typeof v === "string" ? v : JSON.stringify(v);
      continue;
    }
    if (!Array.isArray(v)) continue;
    const cell = (x: Json | undefined) => (x === undefined ? "" : typeof x === "string" ? x : JSON.stringify(x));
    const rows: Row[] = v.map((item) =>
      f.columns.length === 0
        ? { "": cell(item) }
        : Object.fromEntries(f.columns.map((c) => [c.name, cell(item && typeof item === "object" && !Array.isArray(item) ? item[c.name] : undefined)])));
    form[f.name] = rows.length > 0 ? rows : [{}];
  }
  return form;
}
