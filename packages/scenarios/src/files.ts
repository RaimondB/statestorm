/**
 * A model read from disk with the parts it includes (ADR 0019) — the command line's side of
 * `modelFiles`, which the kernel keeps free of a file system.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadModel, modelFiles, ROOT, type Model } from "@statestorm/kernel";
import { parseScenario, type Scenario, type ScenarioFiles } from "./run.ts";

/** `model.yaml` (or whatever the file is called) and its parts, by path relative to its folder. */
export function readModelFiles(modelPath: string): { text: string; files: Record<string, string> } {
  const dir = dirname(modelPath);
  const files = modelFiles((p) => {
    const file = join(dir, p === ROOT ? basename(modelPath) : p);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  });
  return { text: files[ROOT]!, files };
}

export function readModel(modelPath: string): Model {
  const { text, files } = readModelFiles(modelPath);
  return loadModel(text, files);
}

/** The files of a scenarios folder, read from disk by their path there (ADR 0029). */
export function scenarioFiles(dir: string): ScenarioFiles {
  return (p) => {
    const file = join(dir, p);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  };
}

/** A scenario read from disk, with the shared set-ups it includes from its folder (ADR 0029). */
export function readScenario(file: string, name: string = file): Scenario {
  return parseScenario(readFileSync(file, "utf8"), name, scenarioFiles(dirname(file)));
}
