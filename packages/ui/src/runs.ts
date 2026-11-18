/**
 * Every scenario's run, as the views that read them all need them: the Flow board's arrows are what
 * the scenarios showed. Running them all costs seconds on a large domain, so a run is kept for as long
 * as the model and the shared set-ups are the same objects, and the runs not made yet are made in small
 * slices: the page never freezes, and a view shows what it has while the rest come in. After a domain
 * loads they are made while the browser is idle (`warmRuns`), so they are usually ready when asked for.
 */
import type { LogEntry, Model } from "@statestorm/kernel";
import { parseScenario } from "@statestorm/scenarios";
import { actionsOf, logOf } from "./session.ts";

export interface ScenarioText { file: string; text: string }

const runs = new WeakMap<Model, WeakMap<object, Map<string, LogEntry[] | null>>>();
const NO_SETUPS = {};

function cacheOf(model: Model, setups: Record<string, string> | undefined): Map<string, LogEntry[] | null> {
  const byModel = runs.get(model) ?? runs.set(model, new WeakMap()).get(model)!;
  const key = setups ?? NO_SETUPS;
  return byModel.get(key) ?? byModel.set(key, new Map()).get(key)!;
}

const idOf = (s: ScenarioText) => `${s.file}\u0000${s.text}`;

/** A scenario's run under `fifo`, made once; `null` when it cannot be read. */
export function runOf(model: Model, setups: Record<string, string> | undefined, s: ScenarioText): LogEntry[] | null {
  const cache = cacheOf(model, setups);
  const id = idOf(s);
  if (!cache.has(id)) {
    try {
      const sc = parseScenario(s.text, s.file, (p) => setups?.[p]);
      cache.set(id, logOf(model, actionsOf(sc), { kind: "fifo" }, sc.given.at));
    } catch {
      cache.set(id, null);
    }
  }
  return cache.get(id)!;
}

/** The runs made so far, by file, without making any. */
export function madeRuns(model: Model, setups: Record<string, string> | undefined, scenarios: ScenarioText[]): Map<string, LogEntry[]> {
  const cache = cacheOf(model, setups);
  const out = new Map<string, LogEntry[]>();
  for (const s of scenarios) {
    const log = cache.get(idOf(s));
    if (log) out.set(s.file, log);
  }
  return out;
}

/** How many of the scenarios have a run made, readable or not. */
export function madeCount(model: Model, setups: Record<string, string> | undefined, scenarios: ScenarioText[]): number {
  const cache = cacheOf(model, setups);
  return scenarios.filter((s) => cache.has(idOf(s))).length;
}

/**
 * Makes the runs not made yet, a slice at a time: each slice runs for about `budgetMs`, then yields to
 * the page. `progress` is called after each slice, and `cancel()` stops between slices.
 */
export function makeRuns(
  model: Model, setups: Record<string, string> | undefined, scenarios: ScenarioText[],
  progress: () => void, { budgetMs = 40, idle = false }: { budgetMs?: number; idle?: boolean } = {},
): { cancel: () => void } {
  const cache = cacheOf(model, setups);
  const todo = scenarios.filter((s) => !cache.has(idOf(s)));
  let stopped = false;
  const later = (f: () => void) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle && ric) ric(f, { timeout: 2000 });
    else setTimeout(f, 0);
  };
  const slice = () => {
    if (stopped) return;
    const start = performance.now();
    while (todo.length > 0 && performance.now() - start < budgetMs) runOf(model, setups, todo.shift()!);
    progress();
    if (todo.length > 0) later(slice);
  };
  if (todo.length > 0) later(slice);
  return { cancel: () => { stopped = true; } };
}

/** After a domain loads: its runs made while the browser is idle, so a view that reads them all is ready. */
export function warmRuns(model: Model, setups: Record<string, string> | undefined, scenarios: ScenarioText[]): { cancel: () => void } {
  return makeRuns(model, setups, scenarios, () => {}, { budgetMs: 25, idle: true });
}
