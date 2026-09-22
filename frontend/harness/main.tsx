/**
 * Visual harness: the real App against a stubbed server, so screens can be
 * looked at rather than only asserted on. Dev-only, never built or shipped.
 *
 * Query params: ?role=pos|door  ?card=terminal  ?theme=light|dark
 *               ?offline=1  ?queue=3  ?testmode=1  ?update=1
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
localStorage.setItem("openpos.cashier.v1", "Ad");

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
        cashier: "Ad",
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
  ...(q.get("update") ? { version: "0.12.0" } : {}),
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
  if (url.includes("/openpos/catalog/")) return json(fx.catalog);
  if (url.includes("/openpos/summary/")) return json(fx.summary);
  if (url.includes("/openpos/history/")) return json({ device: fx.pairing.serial, ...fx.history });
  if (url.includes("/openpos/attendance/")) return json(fx.attendance);
  if (url.includes("/openpos/offline/"))
    return json({ list: 7, generated_at: new Date().toISOString(), positions: [] });
  if (url.includes("/openpos/terminal/start/")) {
    terminalPolls = 0;
    return json({ status: "pending", amount: "12.50", currency: "EUR", failure: "" });
  }
  if (url.includes("/openpos/terminal/status/")) {
    terminalPolls += 1;
    return json(
      terminalPolls > 200
        ? { status: "successful", amount: "12.50", currency: "EUR", failure: "" }
        : { status: "pending", amount: "12.50", currency: "EUR", failure: "" },
    );
  }
  if (url.includes("/openpos/terminal/cancel/")) return json({ status: "cancelled" });
  if (url.includes("/openpos/checkout/"))
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
        { slug: "soiree-19-09", organizer: "collectif-ano", name: "Soirée du 19 septembre", currency: "EUR", testmode: false, date_from: null },
        { slug: "soiree-17-10", organizer: "collectif-ano", name: "Soirée du 17 octobre", currency: "EUR", testmode: false, date_from: null },
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
