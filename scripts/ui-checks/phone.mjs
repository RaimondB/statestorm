#!/usr/bin/env node
// Every model on a 412px phone: the page must not be wider than the screen, and nothing may
// throw. Written after three separate things widened the page (a canvas, a select, a checkbox).
import { chromium, devices, examples, load, open } from "./lib.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ ...devices["Pixel 7"] });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(process.env.BASE ?? "http://localhost:8097/");
await page.waitForSelector("header.top");
let failed = 0;
for (const { model, scenarios } of examples()) {
  for (const scenario of [undefined, scenarios.at(-1)]) {
    await load(page, model, scenario);
    const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    const ok = scroll <= 412 && inner <= 412;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "WIDE"} ${model}${scenario ? `/${scenario}` : ""}: ${scroll}px`);
  }
}
if (errors.length) { failed++; console.log("page errors:", errors); }
await browser.close();
process.exit(failed ? 1 : 0);
