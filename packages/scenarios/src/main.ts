/**
 * Runs scenarios and prints the result — `test(args)` returns the exit code. A domain folder
 * (model.yaml, scenarios/) can stand for the model and its scenarios.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readModel, readScenario } from "./files.ts";
import { describeSchedule, realWorldSchedules, runScenario } from "./run.ts";
import { narrate } from "./narrate.ts";

export function test(args: string[]): number {
  const traceArg = args.find((a) => a === "--trace" || a.startsWith("--trace="));
  const traceFilter = traceArg?.includes("=") ? traceArg.split("=")[1]! : undefined;
  const positional = args.filter((a) => !a.startsWith("--"));
  // A domain folder stands for its model and its scenarios.
  const [modelPath, ...scenarioPaths] = positional.length === 1 && existsSync(join(positional[0]!, "model.yaml"))
    ? [join(positional[0]!, "model.yaml"), join(positional[0]!, "scenarios")]
    : positional;
  if (!modelPath) {
    console.error("usage: test <domain folder> | <model.yaml> <scenario.yaml|dir> [...] [--schedules] [--trace[=substring]]");
    return 2;
  }

  const model = readModel(modelPath);
  for (const f of model.findings) console.log(`  ${f.severity}: ${f.message}`);
  if (model.findings.length > 0) console.log();

  const schedules = args.includes("--schedules") ? realWorldSchedules() : [undefined];

  const files = scenarioPaths.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p).filter((f) => f.endsWith(".yaml")).sort().map((f) => join(p, f))
      : [p],
  );

  let failed = 0;
  let runs = 0;
  for (const file of files) {
    const scenario = readScenario(file);
    for (const schedule of schedules) {
      const result = runScenario(model, scenario, schedule);
      const ok = result.failures.length === 0;
      runs++;
      if (!ok) failed++;
      const tag = schedules.length > 1 ? `  [${describeSchedule(result.schedule)}]` : "";
      console.log(`${ok ? "  ok" : "FAIL"}  ${scenario.name}${tag}`);
      for (const f of result.failures) console.log(`        ${f}`);
      if (traceArg && (!traceFilter || scenario.name.includes(traceFilter) || file.includes(traceFilter))) {
        console.log();
        for (const line of narrate(result.world)) console.log(`  ${line}`);
        console.log();
      }
    }
  }

  console.log(`\n${runs - failed}/${runs} runs passed`);
  return failed === 0 ? 0 : 1;
}
