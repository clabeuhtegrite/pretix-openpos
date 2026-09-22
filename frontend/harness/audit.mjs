import { chromium } from "playwright";

/**
 * Tap targets and colour contrast, measured on the rendered app.
 *
 * Every scene below is walked in both palettes. A screen nobody walks to is a
 * screen nobody checks, which is how the card flow shipped with no styling at
 * all, so a scene is cheaper to add here than a finding is to miss.
 */
const BASE = process.env.BASE ?? "http://localhost:5174/static/pretix_openpos/pwa/harness.html";

const SCENES = [
  { name: "caisse", q: "role=pos", steps: [{ text: "Bière pression 25cl" }] },
  { name: "quantité", q: "role=pos", steps: [{ text: "Bière pression 25cl" }, { click: ".line .count" }] },
  { name: "encaissement", q: "role=pos", steps: [{ text: "Bière pression 25cl" }, { text: "Encaisser" }] },
  { name: "espèces", q: "role=pos", steps: [{ text: "Bière pression 25cl" }, { text: "Encaisser" }, { text: "Espèces" }] },
  { name: "lecteur", q: "role=pos&card=terminal", steps: [{ text: "Bière pression 25cl" }, { text: "Encaisser" }, { text: "Carte" }, { wait: 2500 }] },
  { name: "montant libre", q: "role=pos", steps: [{ text: "Montant libre" }] },
  { name: "journal", q: "role=pos", steps: [{ click: ".icon-button" }] },
  { name: "porte", q: "role=door", steps: [] },
  { name: "porte, scans en attente", q: "role=door&scans=3&redeem=fail", steps: [{ wait: 600 }] },
  {
    name: "porte, réponse hors ligne",
    q: "role=door&redeem=fail",
    steps: [
      { text: "Chercher un nom" },
      { fill: [".search-panel input", "Cam"] },
      { wait: 600 },
      { click: ".search-hit" },
      { wait: 600 },
      { click: ".confirm-admit" },
    ],
  },
  { name: "effectif par appareil", q: "role=door", steps: [{ click: ".attendance-button" }, { wait: 300 }] },
  { name: "réglages", q: "role=pos", steps: [{ click: '[aria-label="settings"]' }] },
  { name: "hors ligne", q: "role=pos&offline=1&queue=3", steps: [] },
];

function lum(c) {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
const parse = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
let failures = 0;
for (const scheme of ["dark", "light"]) {
 console.log(`\n===== ${scheme} =====`);
 for (const scene of SCENES) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, locale: "fr-FR", colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?browser=1&${scene.q}${scheme === "light" ? "&theme=light" : ""}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  for (const step of scene.steps) {
    try {
      if (step.text) await page.getByText(step.text, { exact: false }).first().click({ timeout: 3000 });
      if (step.click) await page.locator(step.click).first().click({ timeout: 3000 });
      if (step.fill) await page.fill(step.fill[0], step.fill[1], { timeout: 3000 });
      if (step.wait) await page.waitForTimeout(step.wait);
      await page.waitForTimeout(150);
    } catch (e) {
      console.log(`  ! ${scene.name}: ${JSON.stringify(step)} -> ${String(e).split("\n")[0]}`);
    }
  }
  await page.waitForTimeout(150);

  const data = await page.evaluate(() => {
    // The composited background behind an element: every wash on the way up is
    // laid over the one under it, because a red at 15% opacity is not a red.
    const bgOf = (el) => {
      const layers = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = (getComputedStyle(n).backgroundColor.match(/[\d.]+/g) || []).map(Number);
        const a = c.length > 3 ? c[3] : 1;
        if (c.length >= 3 && a > 0) {
          layers.unshift([c[0], c[1], c[2], a]);
          if (a === 1) break;
        }
        n = n.parentElement;
      }
      const root = (getComputedStyle(document.documentElement).backgroundColor.match(/[\d.]+/g) || [255, 255, 255]).map(Number);
      let out = [root[0], root[1], root[2]];
      for (const [r, g, b, a] of layers) out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
      return `rgb(${out.join(", ")})`;
    };
    const small = [];
    for (const el of document.querySelectorAll("button, select, input, [role=tab]")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.width < 44 || r.height < 44)
        small.push({ tag: el.tagName, cls: el.className, text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) });
    }
    const text = [];
    for (const el of document.querySelectorAll("span, div, p, small, td, th, label, button")) {
      if (!el.childNodes.length) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
      if (!own) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      text.push({ t: own.slice(0, 26), fg: cs.color, bg: bgOf(el), size: parseFloat(cs.fontSize), weight: cs.fontWeight, cls: el.className });
    }
    return { small, text };
  });

  const small = data.small;
  const seen = new Set();
  const bad = [];
  for (const t of data.text) {
    const k = t.t + t.fg + t.bg;
    if (seen.has(k)) continue;
    seen.add(k);
    const fg = (t.fg.match(/[\d.]+/g) || []).map(Number);
    const bg = parse(t.bg);
    const a = fg.length > 3 ? fg[3] : 1;
    const r = ratio([0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)), bg);
    const large = t.size >= 24 || (t.size >= 18.66 && Number(t.weight) >= 700);
    const need = large ? 3 : 4.5;
    if (r < need) bad.push({ ...t, r: r.toFixed(2), need });
  }
  if (small.length || bad.length) {
    failures += small.length + bad.length;
    console.log(` ${scene.name}`);
    small.forEach((t) => console.log(`   cible ${t.w}x${t.h}  ${t.cls} | ${t.text}`));
    bad.forEach((b) => console.log(`   ${b.r} (il en faut ${b.need})  "${b.t}"  ${b.size}px  ${b.cls}`));
  } else {
    console.log(` ${scene.name}: ok`);
  }
  await ctx.close();
 }
}
await browser.close();
if (failures) {
  console.log(`\n${failures} à corriger.`);
  process.exitCode = 1;
}
