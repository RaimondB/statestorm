/**
 * A worker thread of the proposal search (MC-11): loads the model and scenarios once, then
 * searches the gaps it is sent — each independently, from forked worlds — under the shared
 * deadline. The gaps are independent, so the search spreads over every core.
 */
import { parentPort, workerData } from "node:worker_threads";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readModel, readScenario } from "@statestorm/scenarios/files";
import { propose } from "./propose.ts";

export interface Gap { key: string; from: string; to: string; prefer: string[] }

const { modelFile, scenarioDir, deadline } = workerData as { modelFile: string; scenarioDir: string; deadline: number };
const model = readModel(modelFile);
const scenarios = readdirSync(scenarioDir).filter((f) => f.endsWith(".yaml") && f !== "issues.yaml").sort()
  .map((f) => readScenario(join(scenarioDir, f), f));
const budget = { deadline };

parentPort!.on("message", (gap: Gap | null) => {
  if (gap === null) { process.exit(0); }
  const t = Date.now();
  const result = propose(model, scenarios, gap.from, gap.to, gap.prefer, budget);
  parentPort!.postMessage({ key: gap.key, result, ms: Date.now() - t });
});
parentPort!.postMessage({ ready: true });
