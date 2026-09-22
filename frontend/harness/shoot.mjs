import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:5174/static/pretix_openpos/pwa/harness.html";
const OUT = process.env.OUT ?? new URL("shots/", import.meta.url).pathname;

/**
 * Les appareils réellement en service : des iPhone tenus en portrait à la
 * porte, des iPad tenus en paysage au bar. Les quatre dernières tailles ne
 * sont pas du matériel d'Ad ; elles sont là pour qu'une mise en page cesse de
 * casser ailleurs sans qu'on le voie. Une capture peut aussi donner la
 * sienne : {"w": 1133, "h": 744}.
 */
const SIZES = {
  "iphone-mini": { width: 375, height: 812 },
  iphone: { width: 393, height: 852 },
  "iphone-max": { width: 440, height: 956 },
  "ipad-mini": { width: 1133, height: 744 },
  ipad: { width: 1180, height: 820 },
  "ipad-pro": { width: 1366, height: 1024 },
  "ipad-portrait": { width: 820, height: 1180 },
  tablet: { width: 1280, height: 800 },
  tabletP: { width: 800, height: 1280 },
  phoneL: { width: 844, height: 390 },
  phoneP: { width: 390, height: 844 },
};

import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

const shots = JSON.parse(process.argv[2]);

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
for (const s of shots) {
  const size = s.w ? { width: s.w, height: s.h } : (SIZES[s.size] ?? SIZES["ipad-mini"]);
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
