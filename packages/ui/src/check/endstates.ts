/**
 * End states (MC-13): a scenario should run to its end — every object it created in an end state
 * (a final state), so nothing is quietly left half-way. Types that live on by design are named in
 * the model with the reason: `coverage: { lives_on: { <Type>: why } }` (a subtype counts as its type).
 */
import { isA, isFinalConfiguration, type Model, type World } from "@statestorm/kernel";

export interface Unfinished { key: string; state: string }

export function livesOnOf(model: Model): Record<string, string> {
  const cov = model.coverage as { lives_on?: Record<string, unknown> } | undefined;
  if (Array.isArray(cov?.lives_on)) return {};   // the wrong shape: said by livesOnShape, not read as types `0`, `1`
  return Object.fromEntries(Object.entries(cov?.lives_on ?? {}).map(([k, v]) => [k, String(v)]));
}

/** `coverage.lives_on` written as a list: each type needs its reason, so say the shape it takes. */
export function livesOnShape(model: Model): string | undefined {
  const cov = model.coverage as { lives_on?: unknown } | undefined;
  if (!Array.isArray(cov?.lives_on)) return undefined;
  const first = String(cov.lives_on[0] ?? "Type");
  return `coverage.lives_on takes each type with the reason it never finishes — \`lives_on: { ${first}: <why> }\` — not a list`;
}

/** The objects of a finished run that are not in an end state, except those that live on. */
export function unfinished(model: Model, world: World): Unfinished[] {
  const livesOn = Object.keys(livesOnOf(model));
  const out: Unfinished[] = [];
  for (const inst of Object.values(world.aggregates)) {
    const machine = model.aggregates[inst.machine];
    if (!machine || livesOn.some((t) => isA(model, inst.machine, t))) continue;
    if (!isFinalConfiguration(machine, inst.config)) out.push({ key: inst.key, state: inst.config.map((p) => p.join(".")).join(", ") });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** `coverage.lives_on` names that are no type of the model — a stale decision is loud (A2). */
export function staleLivesOn(model: Model): string[] {
  return Object.keys(livesOnOf(model)).filter((t) => !model.aggregates[t]);
}
