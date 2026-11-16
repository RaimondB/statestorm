// The rulebook (ADR 0016) of every bundled example that has docs: packages/examples/docs/<model>/.
// Run after changing an example's docs, model or scenarios; `pnpm check-all` fails while one is stale.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { models } from "./models.mjs";

const cli = fileURLToPath(new URL("../packages/ui/src/check/cli.ts", import.meta.url));
let failed = 0;
for (const m of models().filter((x) => x.docsDir)) {
  const args = [cli, "docs", m.modelFile, m.dir, ...(m.drawingDir ? [m.drawingDir] : []), `--docs-dir=${m.docsDir}`];
  if (spawnSync(process.execPath, args, { stdio: "inherit" }).status !== 0) failed++;
}
if (failed) process.exit(1);
