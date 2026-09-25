/**
 * Visual harness: the real App against a stubbed server, so screens can be
 * looked at rather than only asserted on. Dev-only, never built or shipped.
 *
 * Query params: ?role=pos|door  ?card=terminal  ?theme=light|dark
 *               ?offline=1  ?queue=3  ?scans=3  ?testmode=1  ?update=1  ?photos=1
 *               ?terminal=waiting|paid|failed|stalled|reprice  ?checkout=fail
 *               ?events=one|blocked|mixed  ?load=refused|series|cdn  ?redeem=fail
 *               ?takings=empty|nights|series  ?drawer=closed|open|stale|counted|moved
 *               ?slow=1  ?cancel=already|backoffice|lost  ?camera=busy
 *               ?cached=1  ?snapshot=HH:MM|yesterday  ?update=fail
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

// ?scans=N : N scans faits hors ligne attendent d'être envoyés, le dernier
// étant un billet refusé. Avec ?redeem=fail, ils y restent.
if (q.get("scans")) {
  const n = Number(q.get("scans"));
  const queue = JSON.parse(localStorage.getItem("openpos.queue.v1") ?? "[]");
  localStorage.setItem(
    "openpos.queue.v1",
    JSON.stringify([
      ...queue,
      ...Array.from({ length: n }, (_, i) => ({
        kind: "checkin",
        id: `s${i}`,
        at: new Date(Date.now() - (n - i) * 45000).toISOString(),
        event: fx.pairing.event,
        list: 7,
        secret: i === n - 1 ? "zzzz9999yyyy8888" : `aaaa000${i}bbbb000${i}`,
        name: i === n - 1 ? "" : ["Léa Garnier", "Noé Fabre", "Inès Roussel"][i % 3],
        ...(i === n - 1 ? { refused: "invalid" } : { admits: true }),
      })),
    ]),
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

// ?snapshot=HH:MM : la liste embarquée a été tirée aujourd'hui à cette heure ;
// « yesterday » : hier à 21:14. Ce que la porte dit de son âge hors ligne.
const pulledAt = (() => {
  const asked = q.get("snapshot");
  if (!asked) return fx.offlineSnapshot.generated;
  const at = new Date();
  if (asked === "yesterday") {
    at.setDate(at.getDate() - 1);
    at.setHours(21, 14, 0, 0);
  } else {
    const [h, m] = asked.split(":").map(Number);
    at.setHours(h, m, 0, 0);
  }
  return at.toISOString();
})();
const guestList = { ...fx.offlineSnapshot, generated: pulledAt };

// ?cached=1 : l'appareil a déjà été ouvert en ligne — configuration,
// catalogue et liste embarquée sont sur le disque. Avec ?offline=1, c'est une
// caisse rouverte pendant une coupure, plutôt qu'un premier lancement sans
// réseau.
if (q.get("cached")) {
  localStorage.setItem(`openpos.config.v1.${fx.pairing.event}`, JSON.stringify(conf));
  localStorage.setItem(`openpos.catalog.v1.${fx.pairing.event}`, JSON.stringify(fx.catalog));
  localStorage.setItem("openpos.snapshot.v1", JSON.stringify(guestList));
}

// ?camera=busy : une autre app tient la caméra à l'ouverture du scanner ; elle
// est libre au premier « Réessayer la caméra ». Libérée par l'appui, pas par
// le premier refus : en développement, StrictMode monte le scanner deux fois,
// et le premier montage, jeté aussitôt, consommerait ce refus à lui seul.
if (q.get("camera") === "busy" && navigator.mediaDevices?.getUserMedia) {
  const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let busy = true;
  document.addEventListener(
    "click",
    (event) => {
      if ((event.target as Element | null)?.closest?.(".scanner-retry")) busy = false;
    },
    true,
  );
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (busy) throw new DOMException("Could not start video source", "NotReadableError");
    return open(constraints);
  };
}

// ?update=fail : un service worker répond à la demande de mise à jour qu'il
// n'a pas pu télécharger la nouvelle version (update.ts).
if (q.get("update") === "fail") {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: {
        postMessage: (_message: unknown, [port]: MessagePort[]) => {
          port.postMessage({ state: "preparing" });
          setTimeout(() => port.postMessage({ state: "failed" }), 1500);
        },
      },
    },
  });
}

// ?cancel= : ce que le serveur répond à une annulation. « already » : la
// vente l'était déjà, sous une autre clé ; « backoffice » : depuis le
// back-office de pretix ; « lost » : la première réponse se perd en route
// (la vente est annulée côté serveur), la suivante revient.
const cancelMode = q.get("cancel");
const cancelledSeqs = new Set<number>();

// ?drawer= : la caisse espèces de cet appareil, et ce qu'elle a vécu ce soir.
// « closed » fermée (la dernière soirée s'est finie sur un écart d'un euro) ;
// « open » ouverte, avec une entrée et une sortie ; « stale » ouverte depuis un
// autre jour ; « counted » comptée, prête à fermer ; « moved » comptée, puis
// une vente est passée. Les boutons de l'app la font vraiment changer d'état.
type DrawerStub = {
  drawer: typeof fx.drawerInfo;
  session: ReturnType<typeof fx.drawerSession> | null;
  last_closed: ReturnType<typeof fx.lastClosed> | null;
};
const drawerMode = q.get("drawer");
const counted = (current: boolean) => ({
  seq: 4, kind: "count", datetime: new Date(Date.now() - 4 * 60000).toISOString(),
  amount: "306.50", reason: "", cashier: "Alex", device: "Caisse bar 1",
  expected: "307.50", difference: "-1.00", current,
});
let drawer: DrawerStub | null = drawerMode
  ? {
      drawer: fx.drawerInfo,
      session:
        drawerMode === "closed"
          ? null
          : drawerMode === "stale"
            ? { ...fx.drawerSession(), stale: true, movements: [], opened_at: new Date(Date.now() - 4 * 86400000).toISOString() }
            : {
                ...fx.drawerSession(),
                count: drawerMode === "counted" ? counted(true) : drawerMode === "moved" ? counted(false) : null,
              },
      last_closed: drawerMode === "closed" ? fx.lastClosed() : null,
    }
  : null;
let drawerSeq = 10;
const drawerBrief = () =>
  drawer && {
    id: drawer.drawer.id,
    name: drawer.drawer.name,
    open: drawer.session !== null,
    stale: drawer.session?.stale ?? false,
  };
const drawerCash = () => {
  // Ce que la caisse devrait contenir : fond, ventes espèces, entrées, sorties.
  const session = drawer?.session;
  if (!session) return 0;
  const moves = session.movements.reduce(
    (sum, m) => sum + (m.kind === "in" ? 1 : -1) * Number(m.amount),
    0,
  );
  return Number(session.opening_float) + Number(fx.drawerSales) + Number(fx.drawerReturned) + moves;
};
// L'état de la caisse tel que le serveur le rend : la séance ouverte porte ce
// qu'elle doit contenir, et de quoi c'est fait.
const drawerState = () => {
  if (!drawer?.session) return drawer;
  const session = drawer.session;
  const moved = (kind: string) =>
    session.movements.filter((m) => m.kind === kind).reduce((sum, m) => sum + Number(m.amount), 0);
  return {
    ...drawer,
    session: {
      ...session,
      expected: drawerCash().toFixed(2),
      cash_sales: Number(fx.drawerSales).toFixed(2),
      cash_returned: Number(fx.drawerReturned).toFixed(2),
      cash_in: moved("in").toFixed(2),
      cash_out: moved("out").toFixed(2),
    },
  };
};
const entry = (kind: string, amount: string | null, extra: Record<string, unknown> = {}) => ({
  seq: ++drawerSeq, kind, datetime: new Date().toISOString(), amount, reason: "",
  cashier: "Alex", device: fx.pairing.deviceName, ...extra,
});
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}"));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let terminalPolls = 0;
let terminalStopped = false;

// ?events= : ce que l'appareil peut atteindre. Par défaut deux événements
// ouverts ; « one » le seul où il est ; « blocked » un second sans Open POS ;
// « mixed » les deux ouverts plus un sans Open POS.
const autumn = { slug: "soiree-automne", organizer: "demo-club", name: "Soirée d'automne", currency: "EUR", testmode: false, date_from: "2026-09-26T18:00:00Z" };
const winter = { slug: "soiree-hiver", organizer: "demo-club", name: "Soirée d'hiver", currency: "EUR", testmode: false, date_from: "2026-12-12T19:00:00Z" };
const ball = { slug: "bal-masque", organizer: "demo-club", name: "Bal masqué", currency: "EUR", testmode: false, date_from: "2026-10-31T19:00:00Z" };
const disabled = (event: typeof autumn) => ({ ...event, reason: "plugin_disabled" });
const eventList = {
  one: { results: [autumn], unavailable: [] },
  blocked: { results: [autumn], unavailable: [disabled(winter)] },
  mixed: { results: [autumn, winter], unavailable: [disabled(ball)] },
}[q.get("events") ?? ""] ?? { results: [autumn, winter], unavailable: [] };

// ?load= : l'événement de l'appareil ne s'ouvre pas, les autres oui.
// « refused » : Open POS désactivé dessus ; « series » : rien ce soir ;
// « cdn » : un pare-feu devant pretix répond par sa propre page 403.
const stuck = (url: string) => {
  const mode = q.get("load");
  if (!mode || !url.includes(`/events/${fx.pairing.event}/`)) return null;
  if (mode === "series") {
    return json({
      detail: ["Rien n’est programmé ce soir. Cet événement est une série, et la caisse vend la date qui a lieu — ajoutez-en une pour ce soir, ou vérifiez qu’elle est activée."],
      code: "series_closed",
    }, 400);
  }
  if (mode === "cdn") {
    return new Response("<!DOCTYPE html><html><title>Attention Required!</title></html>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    });
  }
  return json({ detail: `Open POS n’est pas activé sur l’événement ${fx.pairing.event}.` }, 403);
};

const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/api/v1")) return real(input as RequestInfo, init);

  if (q.get("offline") === "1") throw new TypeError("offline harness");

  // ?slow=1 : le serveur met deux secondes et demie à répondre, le temps de
  // voir ce que chaque écran montre pendant qu'il attend.
  await new Promise((r) => setTimeout(r, q.get("slow") ? 2500 : 40));

  // Ce que l'appareil dit de lui à pretix quand sa version a changé. pretix
  // répond par la fiche de l'appareil, que la caisse ne lit pas.
  if (url.includes("/device/update")) return json({ unique_serial: fx.pairing.serial });
  if (url.includes("/openpos/config/")) return stuck(url) ?? json({ ...conf, drawer: drawerBrief() });
  if (url.includes("/openpos/drawer/") && drawer) {
    const body = bodyOf(init);
    if (url.includes("/drawer/open/")) {
      const opened = entry("open", body.amount);
      drawer = {
        ...drawer,
        session: { ...fx.drawerSession(), opened_at: opened.datetime, opening_float: body.amount, movements: [], count: null },
        last_closed: null,
      };
      return json({ ...drawerState(), entry: opened });
    }
    if (url.includes("/drawer/movement/") && drawer.session) {
      const moved = entry(body.kind, body.amount, { reason: body.reason });
      drawer.session = { ...drawer.session, movements: [...drawer.session.movements, moved], count: null };
      return json({ ...drawerState(), entry: moved });
    }
    if (url.includes("/drawer/count/") && drawer.session) {
      const expected = drawerCash();
      const made = entry("count", body.amount, {
        expected: expected.toFixed(2),
        difference: (Number(body.amount) - expected).toFixed(2),
      });
      drawer.session = { ...drawer.session, count: { ...made, current: true } };
      return json({ ...drawerState(), entry: made });
    }
    if (url.includes("/drawer/close/") && drawer.session) {
      const count = drawer.session.count as null | { amount: string; difference: string };
      const closing = entry("close", count ? count.amount : null, { reason: body.reason ?? "" });
      drawer = {
        ...drawer,
        last_closed: {
          id: drawer.session.id,
          opened_at: drawer.session.opened_at,
          closed_at: closing.datetime,
          cashier: "Alex",
          amount: count ? count.amount : null,
          expected: drawerCash().toFixed(2),
          difference: count ? count.difference : null,
        } as ReturnType<typeof fx.lastClosed>,
        session: null,
      };
      return json({ ...drawerState(), entry: closing });
    }
    return json(drawerState());
  }
  // ?photos=1 met des photos sur un produit sur deux.
  if (url.includes("/openpos/catalog/"))
    return stuck(url) ?? json(q.get("photos") ? fx.withPhotos(fx.catalog) : fx.catalog);
  // ?takings= : empty (rien de vendu), nights (deux soirées), series (une date).
  if (url.includes("/openpos/summary/"))
    return json(fx.summary(q.get("takings"), !!q.get("testmode")));
  if (url.includes("/openpos/history/"))
    return json({
      device: fx.pairing.serial,
      ...fx.history,
      results: fx.history.results.map((line) =>
        cancelledSeqs.has(line.seq) ? { ...line, cancelled: true, can_cancel: false } : line,
      ),
    });
  if (url.includes("/openpos/attendance/")) return json(fx.attendance);
  if (url.includes("/openpos/offline/")) return json(guestList);
  // ?terminal= pilote le lecteur : waiting (défaut), paid, failed, stalled,
  // reprice (le serveur tarife autrement que la caisse).
  const reader = q.get("terminal") ?? "waiting";
  const readerAmount = reader === "reprice" ? "12.50" : null;
  if (url.includes("/openpos/terminal/start/")) {
    terminalPolls = 0;
    terminalStopped = false;
    if (reader === "failed")
      return json({ status: "failed", amount: "0.00", currency: "EUR", failure: "card_declined" });
    return json({ status: "pending", amount: readerAmount, currency: "EUR", failure: "" });
  }
  if (url.includes("/openpos/terminal/status/")) {
    terminalPolls += 1;
    // « stalled » est l'écran d'une caisse qui a perdu le serveur pendant que
    // le lecteur tient encore la carte : on ne répond donc plus du tout.
    if (reader === "stalled" && terminalPolls > 1) throw new TypeError("harness: stalled");
    if (terminalStopped)
      return json({ status: "failed", amount: readerAmount, currency: "EUR", failure: "CANCELLED" });
    if (reader === "paid" && terminalPolls > 1)
      return json({ status: "successful", amount: "12.50", currency: "EUR", failure: "" });
    if (reader === "failed")
      return json({ status: "failed", amount: "0.00", currency: "EUR", failure: "card_declined" });
    return json({ status: "pending", amount: readerAmount, currency: "EUR", failure: "" });
  }
  // Comme en vrai : le serveur demande l'arrêt au lecteur puis relit SumUp,
  // ce qui prend deux à trois secondes, et l'arrêt étant asynchrone chez
  // SumUp, sa réponse dit encore « en cours ». C'est la relève suivante qui
  // trouve le paiement annulé.
  if (url.includes("/openpos/terminal/cancel/")) {
    await new Promise((r) => setTimeout(r, 2500));
    terminalStopped = true;
    return json({ status: "pending", amount: readerAmount, currency: "EUR", failure: "" });
  }
  if (url.includes("/openpos/checkout/")) {
    const sale = bodyOf(init);
    if (sale.payment_type === "cash" && drawer && (!drawer.session || drawer.session.stale))
      return json({
        drawer: ["La caisse espèces de cet appareil n’est pas ouverte. Ouvrez-la sur un fond compté avant d’encaisser ou de rendre des espèces."],
        code: "drawer_closed",
      }, 400);
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
  if (url.includes("/openpos/cancel/")) {
    const seq = bodyOf(init).seq as number;
    const before = cancelledSeqs.has(seq);
    cancelledSeqs.add(seq);
    if (cancelMode === "lost" && !before) throw new TypeError("harness: the answer got lost");
    return json({
      cancellation: { seq: 43, total: "-8.50", payment_type: "cash" },
      credit_note: "POS4K-C1",
      card_refund: null,
      sale: { order: "POS4K", positions: fx.history.results[0].positions },
      replayed: before || cancelMode === "already" || cancelMode === "backoffice",
      ...(cancelMode === "already" || cancelMode === "backoffice" ? { already_cancelled: true } : {}),
      ...(cancelMode === "backoffice" ? { by_back_office: true } : {}),
    });
  }
  if (/\/organizers\/[^/]+\/openpos\/(\?|$)/.test(url)) return json(eventList);
  if (url.includes("/checkinrpc/search/"))
    return json({
      results: [
        { id: 1, order: "ABC12", secret: "aaaa1111bbbb2222", attendee_name: "Camille Berthier", seat: null, checkins: [], require_attention: false, order__status: "p" },
        { id: 2, order: "ABC13", secret: "s2", attendee_name: "Jean-Baptiste de La Tour du Pin", seat: null, checkins: [{ list: 7 }], require_attention: false, order__status: "p" },
        { id: 3, order: "ABC14", secret: "s3", attendee_name: "Camille Bertrand", seat: null, checkins: [], require_attention: true, order__status: "p" },
      ],
    });
  // ?redeem=fail : le réseau lâche sous le scan, le reste répond.
  if (url.includes("/checkinrpc/redeem/") && q.get("redeem") === "fail")
    throw new TypeError("harness: the network died under the scan");
  if (url.includes("/failed_checkins/")) {
    if (q.get("redeem") === "fail") throw new TypeError("harness: still no network");
    return json({}, 201);
  }
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
