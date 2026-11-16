#!/usr/bin/env node
// Steps through every scenario — by visible change (▶) and one message at a time (›) — and
// checks that the time-travel bar, its buttons and the splitter above them stay exactly where
// they were. Written after a long step line wrapped, grew the timeline and moved them all.
//   node scripts/ui-checks/stable.mjs [width ...]      default widths: 1000 1400
// Scenarios run side by side, and only what changed since the last pass (see eachScenario).
import { eachScenario, load } from "./lib.mjs";

const widths = process.argv.slice(2).map(Number).filter(Boolean);
const where = (page) => page.evaluate(() => {
  const at = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}` : "-"; };
  return {
    splitter: at(".splitter.row"),
    next: at("button[aria-label='Next change']"),
    step: at("button[aria-label='One message forward']"),
    bar: at(".scrub input[type=range]"),
    trace: at(".trace"),
  };
});
let failed = 0;
for (const width of widths.length ? widths : [1000, 1400]) {
  const r = await eachScenario({
    check: `stable-${width}`,
    contextOptions: { viewport: { width, height: 1000 } },
    visit: async (page, model, scenario) => {
      await load(page, model, scenario);
      await page.click("button[aria-label='To the start']");
      const first = JSON.stringify(await where(page));
      let count = 0;
      for (let k = 0; k < 2000; k++) {
        // Alternate: a visible change, then a few single messages — both kinds of jump.
        const button = k % 4 === 0 ? "Next change" : "One message forward";
        if (await page.locator(`button[aria-label='${button}']`).isDisabled()) break;
        await page.click(`button[aria-label='${button}']`);
        count++;
        const now = JSON.stringify(await where(page));
        if (now !== first) {
          return { count, failures: [`MOVED @${await page.locator(".scrub .pos").innerText()} (${width}px):\n  was ${first}\n  now ${now}`] };
        }
      }
      return { count, failures: [] };
    },
  });
  for (const f of r.failures) console.log(f);
  console.log(`${width}px: ${r.count} jumps checked in ${r.visited} scenarios (${r.skipped} unchanged since they passed), ${r.workers} pages at once`);
  if (r.failures.length) failed++;
}
process.exit(failed ? 1 : 0);
