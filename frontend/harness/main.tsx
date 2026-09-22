/**
 * Visual harness: the real App against a stubbed server, so screens can be
 * looked at rather than only asserted on. Dev-only, never built or shipped.
 *
 * Query params: ?role=pos|door  ?card=terminal  ?theme=light|dark
 *               ?offline=1  ?queue=3  ?testmode=1  ?update=1  ?photos=1
 *               ?terminal=waiting|paid|failed|stalled|reprice  ?checkout=fail
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "../src/App";
import "../src/styles.css";
import { applyTheme } from "../src/theme";
import * as fx from "./data";

const q = new URLSearchParams(location.search);

localStorage.setItem("openpos.allowBrowser.v1", "1");
localStorage.setItem("openpos.pairing.v1", JSON.stringify(fx.pairing));
localStorage.setItem("openpos.cashier.v1", "Alex");

if (q.get("queue")) {
  const n = Number(q.get("queue"));
  localStorage.setItem(
    "openpos.queue.v1",
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        kind: "sale",
        id: `q${i}`,
        at: new Date(Date.now() - i * 60000).toISOString(),
        event: fx.pairing.event,
        positions: [{ item: 10, variation: null, count: 1, price: "3.00" }],
        chargedTotal: "3.00",
        paymentType: "cash",
        cashGiven: "5.00",
        cashChange: "2.00",
        cashier: "Alex",
        admits: false,
        label: "1× Bière pression 25cl",
      })),
    ),
  );
}

const theme = q.get("theme");
if (theme) localStorage.setItem("openpos.theme.v1", theme);
applyTheme((theme as "light" | "dark") ?? "system");

const conf = fx.config({
  device: {
    serial: fx.pairing.serial,
    name: fx.pairing.deviceName,
    role: q.get("role") ?? "",
    card: q.get("card") ?? "declared",
  },
  ...(q.get("testmode")
    ? { event: { ...fx.config().event, testmode: true } }
    : {}),
  // Unambiguously newer than any build, so ?update=1 keeps working.
  ...(q.get("update") ? { version: "99.0.0" } : {}),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let terminalPolls = 0;

const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/api/v1")) return real(input as RequestInfo, init);

  if (q.get("offline") === "1") throw new TypeError("offline harness");

  await new Promise((r) => setTimeout(r, 40));

  if (url.includes("/openpos/config/")) return json(conf);
  // ?photos=1 met des photos sur un produit sur deux.
  if (url.includes("/openpos/catalog/"))
    return json(q.get("photos") ? fx.withPhotos(fx.catalog) : fx.catalog);
  if (url.includes("/openpos/summary/")) return json(fx.summary);
  if (url.includes("/openpos/history/")) return json({ device: fx.pairing.serial, ...fx.history });
  if (url.includes("/openpos/attendance/")) return json(fx.attendance);
  if (url.includes("/openpos/offline/")) return json(fx.offlineSnapshot);
  // ?terminal= pilote le lecteur : waiting (défaut), paid, failed, stalled,
  // reprice (le serveur tarife autrement que la caisse).
  const reader = q.get("terminal") ?? "waiting";
  const readerAmount = reader === "reprice" ? "12.50" : null;
  if (url.includes("/openpos/terminal/start/")) {
    terminalPolls = 0;
    if (reader === "failed")
      return json({ status: "failed", amount: "0.00", currency: "EUR", failure: "card_declined" });
    return json({ status: "pending", amount: readerAmount, currency: "EUR", failure: "" });
  }
  if (url.includes("/openpos/terminal/status/")) {
    terminalPolls += 1;
    // « stalled » est l'écran d'une caisse qui a perdu le serveur pendant que
    // le lecteur tient encore la carte : on ne répond donc plus du tout.
    if (reader === "stalled" && terminalPolls > 1) throw new TypeError("harness: stalled");
    if (reader === "paid" && terminalPolls > 1)
      return json({ status: "successful", amount: "12.50", currency: "EUR", failure: "" });
    if (reader === "failed")
      return json({ status: "failed", amount: "0.00", currency: "EUR", failure: "card_declined" });
    return json({ status: "pending", amount: readerAmount, currency: "EUR", failure: "" });
  }
  if (url.includes("/openpos/terminal/cancel/")) return json({ status: "cancelled" });
  if (url.includes("/openpos/checkout/")) {
    // ?checkout=fail : la carte a été débitée et la vente ne s'enregistre pas.
    // C'est l'écran que personne ne voit jamais et qu'il faut pouvoir regarder.
    if (q.get("checkout") === "fail")
      return json({ detail: "harness : le serveur refuse d’enregistrer cette vente." }, 400);
    return json({
      order: { code: "POS4L", total: "12.50", url: null },
      journal_seq: 42,
      payment_type: "cash",
      cash_given: "20.00",
      cash_change: "7.50",
      datetime: new Date().toISOString(),
      replayed: false,
      checked_in: 0,
      checkin_errors: [],
      net_total: "12.50",
    });
  }
  if (url.includes("/openpos/cancel/"))
    return json({
      cancellation: { seq: 43, total: "-8.50", payment_type: "cash" },
      credit_note: "POS4K-C1",
      card_refund: null,
      sale: { order: "POS4K", positions: fx.history.results[0].positions },
    });
  if (/\/organizers\/[^/]+\/openpos\/(\?|$)/.test(url))
    return json({
      results: [
        { slug: "soiree-automne", organizer: "demo-club", name: "Soirée d'automne", currency: "EUR", testmode: false, date_from: null },
        { slug: "soiree-hiver", organizer: "demo-club", name: "Soirée d'hiver", currency: "EUR", testmode: false, date_from: null },
      ],
    });
  if (url.includes("/checkinrpc/search/"))
    return json({
      results: [
        { id: 1, order: "ABC12", secret: "s1", attendee_name: "Camille Berthier", seat: null, checkins: [], require_attention: false, order__status: "p" },
        { id: 2, order: "ABC13", secret: "s2", attendee_name: "Jean-Baptiste de La Tour du Pin", seat: null, checkins: [{ list: 7 }], require_attention: false, order__status: "p" },
        { id: 3, order: "ABC14", secret: "s3", attendee_name: "Camille Bertrand", seat: null, checkins: [], require_attention: true, order__status: "p" },
      ],
    });
  if (url.includes("/checkinrpc/redeem/"))
    return json({ status: "ok", position: { order: "ABC12", item: 20, attendee_name: "Camille Berthier" }, list: { id: 7, name: "Porte" } });

  return json({ detail: `harness: no stub for ${url}` }, 404);
};

const container = document.getElementById("root")!;
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
