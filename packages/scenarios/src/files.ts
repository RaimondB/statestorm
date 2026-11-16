/**
 * A model read from disk with the parts it includes (ADR 0019) — the command line's side of
 * `modelFiles`, which the kernel keeps free of a file system.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadModel, modelFiles, ROOT, type Model } from "@statestorm/kernel";

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
