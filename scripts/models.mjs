// Every model in the repo, found the way the example test finds them: the bundled examples
// (packages/examples/models/<model>.yaml, scenarios/<model>/, drawings/<model>/, docs/<model>/). Shared by the
// UI checks and check-all; a drawings folder is given only where one exists. A domain lives in a
// repo of its own, with its own `statestorm test` and `check`.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function models() {
  const root = fileURLToPath(new URL("../packages/examples/", import.meta.url));
  const yamls = (dir) => readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).sort();
  const drawings = (dir) => (existsSync(dir) ? { drawingDir: dir } : {});
  const docs = (dir) => (existsSync(dir) ? { docsDir: dir } : {});
  const agendas = (dir) => (existsSync(dir) ? { agendasDir: dir } : {});
  return yamls(`${root}models`).map((model) => ({
    model, modelFile: `${root}models/${model}.yaml`, dir: `${root}scenarios/${model}/`, ...drawings(`${root}drawings/${model}/`),
    ...docs(`${root}docs/${model}/`), ...agendas(`${root}agendas/${model}/`),
  })).map((m) => ({ ...m, scenarios: yamls(m.dir) }));
}
