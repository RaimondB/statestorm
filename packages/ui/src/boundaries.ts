/**
 * Boundaries (ADR 0012 §3, ADR 0013): which aggregate an entity lives inside — read from who creates
 * it — and so which package holds it. The structure view draws them; the rulebook lists a topic's
 * types by them. No layout here, so the command-line check can use it.
 */
import { isA, type MachineDef, type Model } from "@statestorm/kernel";

/** Every rule a machine has under `on:`, wherever it is declared. */
export function allRules(m: MachineDef) {
  const out: MachineDef["states"][string]["on"][string] = [];
  const walk = (states: MachineDef["states"]) => {
    for (const st of Object.values(states)) { out.push(...Object.values(st.on).flat()); walk(st.states); }
  };
  walk(m.states);
  return out;
}

/** Who creates which entity type: read from the model's `send:` (ADR 0013 §2). */
export function creatorsOf(model: Model): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of Object.values(model.aggregates)) {
    for (const t of allRules(m)) {
      for (const sd of t.send) {
        const target = sd.to ? /^([A-Za-z_][A-Za-z0-9_]*)#/.exec(sd.to)?.[1] : sd.children ? m.children[sd.children]?.type : undefined;
        if (!target || model.aggregates[target]?.role !== "entity") continue;
        const list = out.get(target) ?? out.set(target, []).get(target)!;
        if (!list.includes(m.name)) list.push(m.name);
      }
    }
  }
  return out;
}

/**
 * The aggregate type an entity type is drawn inside: the aggregate that creates it, directly
 * or through an entity it created (ADR 0013 §2). An entity nothing creates — an abstract one —
 * is drawn with the type that declares the relation owning it.
 */
export function frameOf(model: Model, type: string, creators: Map<string, string[]>, seen = new Set<string>()): string | undefined {
  const m = model.aggregates[type];
  if (!m) return undefined;
  if (m.role === "aggregate") return type;
  if (seen.has(type)) return undefined;
  seen.add(type);
  // Created by one kind of aggregate: inside it. Created by several (a transfer's task, planned by
  // a courier run and a tube run alike): a part they share, so it goes with the nearest
  // supertype they have in common — Transfer, not the far more generic Step (ADR 0013 §2).
  const made = [...new Set((creators.get(type) ?? []).map((c) => frameOf(model, c, creators, new Set(seen))).filter((f): f is string => !!f))];
  if (made.length === 1) return made[0];
  if (made.length > 1) {
    const lineage = (t: string) => [t, ...(model.aggregates[t]?.ancestors ?? [])];
    const shared = lineage(made[0]!).find((a) => made.every((f) => lineage(f).includes(a)));
    if (shared) return shared;
  }
  for (const p of Object.values(model.aggregates)) {
    for (const c of Object.values(p.children)) {
      if (c.declaredOn === p.name && isA(model, type, c.type)) return frameOf(model, p.name, creators, seen);
    }
  }
  return undefined;
}

/** ADR 0013 §3: a package's types — those it lists, and the entities inside its aggregates' boundaries. */
export function packageTypes(model: Model): Map<string, string[]> {
  const creators = creatorsOf(model);
  const declared = new Map(model.packages.flatMap((p) => p.types.map((t) => [t, p.name] as const)));
  const out = new Map(model.packages.map((p) => [p.name, [] as string[]]));
  for (const name of [...Object.keys(model.aggregates), ...Object.keys(model.values)]) {
    const frame = model.aggregates[name]?.role === "entity" ? frameOf(model, name, creators) : undefined;
    const home = (frame && frame !== name ? declared.get(frame) : undefined) ?? declared.get(name);
    if (home) out.get(home)!.push(name);
  }
  return out;
}
