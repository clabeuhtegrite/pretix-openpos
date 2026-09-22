import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:5174/static/pretix_openpos/pwa/harness.html";
const sizes = {
  tablet: { width: 1280, height: 800 },
  tabletP: { width: 800, height: 1280 },
  phoneL: { width: 844, height: 390 },
  phoneP: { width: 390, height: 844 },
};
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
for (const [name, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, locale: "fr-FR", colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?browser=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  const grid = await page.evaluate(() => {
    const g = document.querySelector(".grid");
    const cs = getComputedStyle(g);
    const cart = document.querySelector(".cart").getBoundingClientRect();
    const prods = [...document.querySelectorAll(".product")].map((p) => p.getBoundingClientRect());
    return {
      cols: cs.gridTemplateColumns.split(" ").length,
      colWidth: Math.round(parseFloat(cs.gridTemplateColumns.split(" ")[0])),
      gridW: Math.round(g.getBoundingClientRect().width),
      gridH: Math.round(g.getBoundingClientRect().height),
      scrollH: g.scrollHeight,
      cartW: Math.round(cart.width),
      cartH: Math.round(cart.height),
      tileH: prods.length ? Math.round(prods[0].height) : null,
      visibleTiles: prods.filter((r) => r.top < window.innerHeight && r.bottom > 0).length,
      totalTiles: prods.length,
    };
  });
  // open payment with one item
  await page.getByText("Bière pression 25cl", { exact: false }).first().click();
  await page.getByText("Encaisser", { exact: false }).first().click();
  await page.waitForTimeout(200);
  await page.getByText("Espèces", { exact: false }).first().click();
  await page.waitForTimeout(250);
  const pay = await page.evaluate(() => {
    const body = document.querySelector(".pay-body");
    const panel = document.querySelector(".pay-panel").getBoundingClientRect();
    const keys = [...document.querySelectorAll(".keypad button")].map((b) => b.getBoundingClientRect());
    const vis = keys.filter((r) => r.top >= 0 && r.bottom <= window.innerHeight).length;
    const amounts = [...document.querySelectorAll(".pay-body .amount-display")].map((a) => {
      const r = a.getBoundingClientRect();
      return { label: a.textContent.slice(0, 20), fullyVisible: r.top >= 0 && r.bottom <= window.innerHeight };
    });
    return {
      panelH: Math.round(panel.height),
      bodyClient: body.clientHeight,
      bodyScroll: body.scrollHeight,
      mustScroll: body.scrollHeight > body.clientHeight + 1,
      keysVisible: vis, keysTotal: keys.length,
      keyH: keys.length ? Math.round(keys[0].height) : null,
      amounts,
    };
  });
  console.log(name, JSON.stringify({ grid, pay }, null, 1));
  await ctx.close();
}
await browser.close();
