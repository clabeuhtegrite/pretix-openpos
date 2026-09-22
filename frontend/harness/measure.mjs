import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:5174/static/pretix_openpos/pwa/harness.html";
/**
 * Les appareils réellement en service : des iPhone tenus en portrait à la
 * porte, des iPad tenus en paysage au bar. Les deux dernières tailles ne sont
 * pas du matériel d'Ad ; elles sont là pour qu'une mise en page cesse de
 * casser ailleurs sans qu'on le voie.
 */
const DEFAULTS = {
  "iPhone mini": { width: 375, height: 812 },
  "iPhone 15": { width: 393, height: 852 },
  "iPhone Pro Max": { width: 440, height: 956 },
  "iPad mini paysage": { width: 1133, height: 744 },
  "iPad 10 paysage": { width: 1180, height: 820 },
  "iPad Pro 12.9 paysage": { width: 1366, height: 1024 },
  "iPad 10 portrait": { width: 820, height: 1180 },
  "téléphone en paysage": { width: 844, height: 390 },
};

// node harness/measure.mjs '{"un autre écran":[1024,768]}'
const sizes = process.argv[2]
  ? Object.fromEntries(
      Object.entries(JSON.parse(process.argv[2])).map(([k, [w, h]]) => [k, { width: w, height: h }]),
    )
  : DEFAULTS;
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
  console.log(
    `${name.padEnd(22)} ${String(viewport.width).padStart(4)}x${String(viewport.height).padEnd(5)}` +
      ` grille ${grid.cols} col de ${grid.colWidth}px` +
      ` | panier ${grid.cartW}px` +
      ` | tuiles ${grid.visibleTiles}/${grid.totalTiles}` +
      ` | clavier ${pay.keysVisible}/${pay.keysTotal} de ${pay.keyH}px` +
      (pay.mustScroll ? " | DOIT DÉFILER" : ""),
  );
  await ctx.close();
}
await browser.close();
