// The model check (packages/ui/src/check/cli.ts) for every model in the repo, one after another,
// with the flags given here (`--propose`, `--all`, …). Exits non-zero if any model's check does.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { models } from "./models.mjs";

const cli = fileURLToPath(new URL("../packages/ui/src/check/cli.ts", import.meta.url));
const flags = process.argv.slice(2);
let failed = 0;
for (const m of models()) {
  console.log(`\n=== ${m.model}`);
  const args = [cli, m.modelFile, m.dir, ...(m.drawingDir ? [m.drawingDir] : []), ...(m.docsDir ? [`--docs-dir=${m.docsDir}`] : []),
    ...(m.agendasDir ? [`--agendas-dir=${m.agendasDir}`] : []), ...flags];
  if (spawnSync(process.execPath, args, { stdio: "inherit" }).status !== 0) failed++;
}
if (failed) { console.error(`\ncheck-all: ${failed} model${failed === 1 ? "" : "s"} failed the check`); process.exit(1); }
