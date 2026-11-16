// The package a domain repo installs: the `statestorm` command and the proposal search's worker,
// bundled with everything they use (no workspace packages, no TypeScript — Node will not strip
// types under node_modules), and the prebuilt site beside them. Out: <repo>/dist/.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../dist/", import.meta.url));
const site = fileURLToPath(new URL("../ui/dist/", import.meta.url));
if (!existsSync(`${site}index.html`)) throw new Error("no built site in packages/ui/dist — run `pnpm build` first");

rmSync(out, { recursive: true, force: true });
await build({
  configFile: false,
  root: here,
  logLevel: "warn",
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: true,
    outDir: out,
    emptyOutDir: false,
    target: "node22",
    minify: false,
    rollupOptions: {
      input: { statestorm: `${here}src/statestorm.ts`, "propose-worker": fileURLToPath(new URL("../ui/src/check/propose-worker.ts", import.meta.url)) },
      // One folder: the worker is found beside the code that starts it.
      output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },   // the shebang comes from the source
    },
  },
});
cpSync(site, `${out}site`, { recursive: true });
// The commit it was built from, for what it makes to say (statestorm share); none without .git —
// installed as a git dependency, the domain's lockfile says it instead.
const commit = spawnSync("git", ["-C", here, "rev-parse", "HEAD"], { encoding: "utf8" });
writeFileSync(`${out}build.json`, `${JSON.stringify({ commit: commit.status === 0 ? commit.stdout.trim() : null, builtAt: new Date().toISOString() })}\n`);
cpSync(fileURLToPath(new URL("../ui/dist-standalone/index.html", import.meta.url)), `${out}standalone.html`);
console.log(`statestorm: built ${out}`);
