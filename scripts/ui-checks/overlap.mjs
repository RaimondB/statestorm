#!/usr/bin/env node
// Steps (▶) through every stop of every scenario and checks that no two overview boxes or event
// stickies overlap. Written after boxes spilled into their neighbours at some stops only.
//   node scripts/ui-checks/overlap.mjs [width ...]      default widths: 1000 1400 1920
// Scenarios run side by side, and only what changed since the last pass (see eachScenario).
import { eachScenario, load } from "./lib.mjs";

const widths = process.argv.slice(2).map(Number).filter(Boolean);
let failed = 0;
for (const width of widths.length ? widths : [1000, 1400, 1920]) {
  const r = await eachScenario({
    check: `overlap-${width}`,
    contextOptions: { viewport: { width, height: 1000 } },
    visit: async (page, model, scenario) => {
      await load(page, model, scenario);
      await page.click("button[aria-label='To the start']");
      const failures = [];
      let count = 0;
      for (let k = 0; k < 2000; k++) {
        const hits = await page.evaluate(() => {
          const boxes = [...document.querySelectorAll(".ov-box, .ov-sticky")].map((e) => [e, e.getBoundingClientRect()]);
          const out = [];
          for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const [ea, a] = boxes[i], [eb, b] = boxes[j];
            if (ea.contains(eb) || eb.contains(ea)) continue;
            const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (x > 1 && y > 1) out.push(`${ea.title || ea.textContent.slice(0, 24)} × ${eb.title || eb.textContent.slice(0, 24)}`);
          }
          return out;
        });
        count++;
        if (hits.length) failures.push(`OVERLAP @${await page.locator(".scrub .pos").innerText()} (${width}px): ${hits[0]}`);
        if (await page.locator("button[aria-label='Next change']").isDisabled()) break;
        await page.click("button[aria-label='Next change']");
      }
      return { failures, count };
    },
  });
  for (const f of r.failures) console.log(f);
  console.log(`${width}px: ${r.count} stops checked in ${r.visited} scenarios (${r.skipped} unchanged since they passed), ${r.workers} pages at once`);
  if (r.failures.length) failed++;
}
process.exit(failed ? 1 : 0);
