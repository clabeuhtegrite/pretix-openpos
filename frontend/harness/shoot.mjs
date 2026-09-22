import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5174/static/pretix_openpos/pwa/harness.html";
const OUT = process.env.OUT ?? new URL("shots/", import.meta.url).pathname;

// A 10" tablet in landscape is the real device; a phone in landscape is the
// fallback grip Ad's volunteers use.
const TABLET = { width: 1280, height: 800 };
const TABLET_P = { width: 800, height: 1280 };
const PHONE_L = { width: 844, height: 390 };
const PHONE_P = { width: 390, height: 844 };

import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

const shots = JSON.parse(process.argv[2]);

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
for (const s of shots) {
  const size = s.size === "phoneL" ? PHONE_L : s.size === "phoneP" ? PHONE_P : s.size === "tabletP" ? TABLET_P : TABLET;
  const ctx = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    hasTouch: true,
    locale: "fr-FR",
    colorScheme: s.scheme ?? "dark",
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("  console:", m.text().slice(0, 200)); });
  await page.goto(`${BASE}?browser=1&${s.q ?? ""}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  if (s.steps) {
    for (const step of s.steps) {
      try {
        if (step.click) await page.click(step.click, { timeout: 3000 });
        if (step.clickText) await page.getByText(step.clickText, { exact: false }).first().click({ timeout: 3000 });
        if (step.fill) await page.fill(step.fill[0], step.fill[1]);
        if (step.wait) await page.waitForTimeout(step.wait);
      } catch (e) {
        console.log(`  ! ${s.name}: step failed ${JSON.stringify(step)} -> ${String(e).split("\n")[0]}`);
      }
    }
  }
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${s.name}.png` });
  console.log("ok", s.name);
  await ctx.close();
}
await browser.close();
