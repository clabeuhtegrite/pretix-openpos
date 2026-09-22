import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:5174/static/pretix_openpos/pwa/harness.html";

function lum(c) {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
const parse = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
for (const scheme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, locale: "fr-FR", colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?browser=1${scheme === "light" ? "&theme=light" : ""}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.getByText("Bière pression 25cl", { exact: false }).first().click();
  await page.waitForTimeout(150);

  const data = await page.evaluate(() => {
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
        n = n.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
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

  console.log(`\n===== ${scheme} =====`);
  console.log("tap targets < 44px:", data.small.length);
  data.small.forEach((s) => console.log("  ", s.w + "x" + s.h, s.cls, "|", s.text));
  const seen = new Set();
  const bad = [];
  for (const t of data.text) {
    const k = t.t + t.fg + t.bg;
    if (seen.has(k)) continue;
    seen.add(k);
    const r = ratio(parse(t.fg), parse(t.bg));
    const large = t.size >= 24 || (t.size >= 18.66 && Number(t.weight) >= 700);
    const need = large ? 3 : 4.5;
    if (r < need) bad.push({ ...t, r: r.toFixed(2), need });
  }
  console.log("contrast below WCAG AA:", bad.length);
  bad.forEach((b) => console.log(`   ${b.r} (need ${b.need})  "${b.t}"  ${b.size}px  ${b.cls}`));
  await ctx.close();
}
await browser.close();
