import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel } from "@statestorm/kernel";
import { describeSchedule, parseScenario, realWorldSchedules, runScenario } from "../src/run.ts";
import { readScenario } from "../src/files.ts";

// Each model under examples/models/<name>.yaml owns the scenarios in examples/scenarios/<name>/.
const root = fileURLToPath(new URL("../../examples/", import.meta.url));
const all = readdirSync(join(root, "models")).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort()
  .map((name) => ({ name, modelFile: join(root, "models", `${name}.yaml`), dir: join(root, "scenarios", name) }));

for (const { name, modelFile, dir } of all) {
  const model = loadModel(readFileSync(modelFile, "utf8"));
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();

  test(`${name}: the model itself has nothing the loader wants to warn about`, () => {
    assert.deepEqual(model.findings, []);
  });

  test(`${name}: has scenarios`, () => assert.ok(files.length > 0));

  // Every scenario is run under `fifo` and then under the schedules the real infrastructure
  // can produce: reordering and redelivery (ADR 0006).
  for (const file of files) {
    const scenario = readScenario(join(dir, file), file);
    for (const schedule of realWorldSchedules()) {
      test(`${name}: ${scenario.name} [${describeSchedule(schedule)}]`, () => {
        const result = runScenario(model, scenario, schedule);
        assert.deepEqual(result.failures, [], result.failures.join("\n"));
      });
    }
  }

  test(`${name}: a run is deterministic: the same scenario twice gives the same trace (R15)`, () => {
    const scenario = readScenario(join(dir, files[0]!), files[0]);
    const a = runScenario(model, scenario).world.log;
    const b = runScenario(model, scenario).world.log;
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
}
