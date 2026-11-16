// Shared by the UI checks. There is no browser-test suite in the repo yet; these drive the
// running app (the container or `pnpm dev`) with Playwright and fail loudly on what they find.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { models } from "../models.mjs";

/** Where the app is: the always-on container by default, `pnpm dev` with BASE=http://localhost:5180. */
export const BASE = process.env.BASE ?? "http://localhost:8097/";

/**
 * Playwright is a dev dependency (`pnpm install`); its browser is not — `pnpm ui-check:install`
 * fetches Chromium once per machine. PLAYWRIGHT=<path to playwright's index.mjs> uses another copy.
 */
export const { chromium, devices } = await import(process.env.PLAYWRIGHT ?? "playwright");
try {
  await (await chromium.launch()).close();
} catch (e) {
  console.error(`ui-check: Playwright cannot start Chromium — run \`pnpm ui-check:install\` once (on Linux, if it then\n`
    + `misses system libraries: \`pnpm exec playwright install-deps chromium\`, as root).\n\n${e.message ?? e}`);
  process.exit(2);
}

/** Every model and its scenarios (scripts/models.mjs). */
export const examples = models;

export async function open(page) {
  await page.goto(BASE);
  await page.waitForSelector(".view-switch");
  await page.click(".view-switch button:has-text('Overview')");
}

export async function load(page, model, scenario) {
  await page.selectOption("header label:nth-of-type(1) select", model);
  if (scenario) {
    // The picker is a field you type in: the whole file name opens that scenario.
    await page.fill(".scenario-picker input", scenario);
    await page.press(".scenario-picker input", "Enter");
  }
  await page.waitForTimeout(250);
}

/**
 * Visits every scenario of every model, spread over several pages at once, and remembers which
 * passed: a later run visits only what changed — the site's build (its index page names the
 * hashed bundles), the model or the scenario. UI_CHECK_ALL=1 visits everything; WORKERS=n sets
 * how many pages run side by side (default: the cores, less two).
 *   visit(page, model, scenario) → { failures: string[], count: number }
 */
export async function eachScenario({ check, contextOptions = {}, visit }) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const stamp = createHash("sha1").update(await (await fetch(BASE)).text()).digest("hex");
  const file = `${root}.cache/ui-checks/${check}.json`;
  let passed = {};
  try { if (!process.env.UI_CHECK_ALL) passed = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  const all = examples().flatMap(({ model, modelFile, dir, scenarios }) => scenarios.map((scenario) => {
    const text = readFileSync(modelFile, "utf8") + readFileSync(`${dir}${scenario}.yaml`, "utf8");
    return { model, scenario, key: createHash("sha1").update(stamp + check + text).digest("hex") };
  }));
  const todo = all.filter((s) => !passed[s.key]);
  const workers = Math.max(1, Math.min(Number(process.env.WORKERS) || availableParallelism() - 2, todo.length));
  const browser = await chromium.launch();
  const failures = [];
  let count = 0;
  const queue = [...todo];
  await Promise.all(Array.from({ length: workers }, async () => {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await open(page);
    for (let s = queue.shift(); s; s = queue.shift()) {
      const r = await visit(page, s.model, s.scenario);
      count += r.count;
      if (errors.length) r.failures.push(`page errors: ${errors.splice(0).join("; ")}`);
      if (r.failures.length) failures.push(...r.failures.map((f) => `${s.model}/${s.scenario}: ${f}`));
      else passed[s.key] = true;
    }
    await context.close();
  }));
  await browser.close();
  // Only what still exists and passed is remembered.
  const keys = new Set(all.map((s) => s.key));
  mkdirSync(`${root}.cache/ui-checks`, { recursive: true });
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(passed).filter(([k]) => keys.has(k)))));
  return { visited: todo.length, skipped: all.length - todo.length, workers, count, failures };
}
