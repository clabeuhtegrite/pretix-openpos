import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "./api";
import { basketFromJournal, repriceCart } from "./basket";
import CheckinScreen from "./components/CheckinScreen";
import DoneScreen from "./components/DoneScreen";
import HistoryPanel from "./components/HistoryPanel";
import InstallGate, { browserAllowed, isStandalone } from "./components/InstallGate";
import PairingScreen from "./components/PairingScreen";
import PaymentPanel from "./components/PaymentPanel";
import SaleScreen, { type Sellable } from "./components/SaleScreen";
import SettingsPanel from "./components/SettingsPanel";
import SyncPanel from "./components/SyncPanel";
import { t } from "./i18n";
import { fromCents, toCents } from "./money";
import { newNonce } from "./nonce";
import {
  clearPairing, enqueue, loadCached, loadCashier, loadPairing, loadQueue,
  requestPersistence, saveCached, saveCashier, savePairing,
} from "./storage";
import { useConnectivity } from "./connectivity";
import { drainQueue } from "./sync";
import type {
  Catalog, CartLine, Pairing, PaymentType, PosConfig, QueuedSale,
  SaleResult, SyncReport,
} from "./types";
import { useBackClose } from "./useBackClose";
import { useWakeLock } from "./useWakeLock";

/**
 * How often an idle till re-reads the catalogue.
 *
 * A price edited in the backend has to reach the door without anyone
 * relaunching the app. Only ever while idle: reloading prices under a basket
 * that is already being read out to a customer is how you end up announcing one
 * figure and charging another.
 */
const CATALOG_REFRESH_MS = 60_000;

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.isNetwork ? t("error.offline") : err.message;
  return String(err);
}

/**
 * Pull the new build in one tap.
 *
 * The service worker hands static assets out cache-first, so a bare reload
 * would come back with the very bundle it is trying to replace. Dropping the
 * caches first makes the reload fetch the new shell for real.
 */
async function reloadForUpdate(): Promise<void> {
  try {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  } catch {
    // No Cache API (plain-HTTP dev box): the reload alone still helps.
  }
  window.location.reload();
}

export default function App() {
  const [pairing, setPairing] = useState<Pairing | null>(loadPairing);
  const [config, setConfig] = useState<PosConfig | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [cashier, setCashier] = useState<string>(loadCashier);

  // Non-null while the payment panel is open. The key is minted once per
  // attempt and reused across retries, so a timeout that actually committed
  // cannot turn into a second sale.
  const [paying, setPaying] = useState<{ key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const [sale, setSale] = useState<SaleResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * Money already taken off the customer by a cancellation they are correcting.
   *
   * Held here rather than in the panel that created it, because it has to
   * outlive that panel: it is spent at the payment step, against a basket the
   * operator may still be editing.
   */
  const [credit, setCredit] = useState<{ amountCents: number; order: string } | null>(null);

  const online = useConnectivity();
  const [pending, setPending] = useState(() => loadQueue().length);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);

  // Evaluated once: display-mode does not change without a reload, and a value
  // that flickers would bounce the operator out of a sale.
  const [gated] = useState(() => !isStandalone() && !browserAllowed());

  useWakeLock(pairing !== null);

  // What is queued is money that exists nowhere else yet; ask the browser not
  // to evict it.
  useEffect(requestPersistence, []);

  // A ref, not the state above: the automatic drain and a tap on "send now" can
  // land in the same tick, and a state flag would not have flipped yet. The
  // server would survive it — every entry is idempotent — but the report would
  // count each sale twice.
  const syncingRef = useRef(false);

  const sync = useCallback(async () => {
    if (!pairing || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const report = await drainQueue(pairing);
      // Only worth showing when it did something: draining an empty queue on
      // every reconnection would be a dialog nobody asked for.
      if (report.sales || report.checkins || report.failed) setLastSync(report);
    } finally {
      syncingRef.current = false;
      setPending(loadQueue().length);
      setSyncing(false);
    }
  }, [pairing]);

  useEffect(() => {
    // Back on the network with something to send, and nobody mid-transaction:
    // interrupting a payment panel to replay a queue would be the worst moment.
    if (!online || pending === 0 || paying !== null) return;
    void sync();
  }, [online, pending, paying, sync]);

  // Android's back gesture closes what is on top, not the till. The payment
  // panel is deliberately absent: backing out of a half-tendered payment by
  // reflex is not something to make one swipe away.
  useBackClose(settingsOpen, () => setSettingsOpen(false));
  useBackClose(checkinOpen, () => setCheckinOpen(false));
  useBackClose(historyOpen, () => setHistoryOpen(false));
  useBackClose(syncOpen, () => setSyncOpen(false));
  useBackClose(sale !== null, () => setSale(null));

  const load = useCallback(async (p: Pairing) => {
    setLoadError(null);
    try {
      const [nextConfig, nextCatalog] = await Promise.all([api.config(p), api.catalog(p)]);
      setConfig(nextConfig);
      setCatalog(nextCatalog);
      // Kept so the till can be started again during an outage.
      saveCached("config", p.event, nextConfig);
      saveCached("catalog", p.event, nextCatalog);
    } catch (err) {
      // A revoked or deleted device should send the operator back to pairing
      // rather than leave them staring at an error they cannot fix.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearPairing();
        setPairing(null);
        setConfig(null);
        setCatalog(null);
        return;
      }

      // Anything else — no network, a gateway answering for a server that is
      // restarting — must not turn a till into a brick mid-evening. If this
      // device has been here before, it opens on what it was last told and goes
      // on selling; the queue is what makes that safe.
      const cachedConfig = loadCached<PosConfig>("config", p.event);
      const cachedCatalog = loadCached<Catalog>("catalog", p.event);
      if (cachedConfig && cachedCatalog) {
        setConfig(cachedConfig);
        setCatalog(cachedCatalog);
        return;
      }
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    if (pairing) void load(pairing);
  }, [pairing, load]);

  // True whenever a customer is mid-transaction and the catalogue must hold still.
  const servingCustomer =
    cart.length > 0 || paying !== null || sale !== null || checkinOpen;

  useEffect(() => {
    if (!pairing || servingCustomer) return;
    let cancelled = false;

    const refresh = () => {
      // Config rides along with the catalogue: it is where the server's
      // version comes from, and it also lets a check-in list added mid-evening
      // reach the door without a relaunch.
      Promise.all([api.catalog(pairing), api.config(pairing)])
        .then(([nextCatalog, nextConfig]) => {
          if (cancelled) return;
          setCatalog(nextCatalog);
          setConfig(nextConfig);
          saveCached("catalog", pairing.event, nextCatalog);
          saveCached("config", pairing.event, nextConfig);
        })
        .catch(() => {
          // A missed refresh is harmless: the previous catalogue stays on
          // screen and the server still prices the sale itself.
        });
    };

    refresh();
    const timer = window.setInterval(refresh, CATALOG_REFRESH_MS);
    // Coming back to the app is the other moment prices may have moved.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pairing, servingCustomer]);

  function onPaired(next: Pairing) {
    savePairing(next);
    setPairing(next);
  }

  function unpair() {
    clearPairing();
    setPairing(null);
    setConfig(null);
    setCatalog(null);
    setCart([]);
    setSettingsOpen(false);
  }

  function addProduct(product: Sellable) {
    setCart((current) => {
      const existing = current.find((line) => line.key === product.key);
      if (!existing) {
        return [
          ...current,
          {
            key: product.key,
            itemId: product.itemId,
            variationId: product.variationId,
            label: product.label,
            unitPrice: product.priceCents,
            count: 1,
            available: product.available,
          },
        ];
      }
      if (existing.available !== null && existing.count >= existing.available) return current;
      return current.map((line) =>
        line.key === product.key ? { ...line, count: line.count + 1 } : line,
      );
    });
  }

  /** Emptying the basket abandons the correction, and the credit with it. */
  function clearCart() {
    setCart([]);
    setCredit(null);
  }

  function setCount(key: string, count: number) {
    setCart((current) =>
      count <= 0
        ? current.filter((line) => line.key !== key)
        : current.map((line) => (line.key === key ? { ...line, count } : line)),
    );
  }

  /**
   * Record a sale the server cannot be told about yet.
   *
   * Written to storage before anything is shown, and only then confirmed: if
   * the write fails there is no sale, and the operator is told so while the
   * customer is still standing there — rather than being shown a receipt for
   * something that will never exist.
   */
  function sellOffline(paymentType: PaymentType, cashGiven: string | null): SaleResult {
    const admissionItems = new Set(config?.admission_items ?? []);
    const entry: QueuedSale = {
      kind: "sale",
      id: paying!.key,
      at: new Date().toISOString(),
      event: pairing!.event,
      positions: cart.map((line) => ({
        item: line.itemId,
        variation: line.variationId,
        count: line.count,
        // What the customer was charged, from the tariff this till had cached.
        // The server compares it with its own on replay and reports any gap.
        price: fromCents(line.unitPrice),
      })),
      chargedTotal: fromCents(total),
      paymentType,
      cashGiven,
      cashChange:
        cashGiven === null ? null : fromCents(Math.max(toCents(cashGiven) - total, 0)),
      cashier,
      admits: cart.some((line) => admissionItems.has(line.itemId)),
      label: cart.map((line) => `${line.count}× ${line.label}`).join(", "),
    };
    enqueue(entry);
    setPending(loadQueue().length);

    // Shaped like a server answer so every screen downstream stays unchanged;
    // what it does not have is an order code, because no order exists yet.
    return {
      order: { code: "", total: entry.chargedTotal, url: null },
      journal_seq: 0,
      payment_type: paymentType,
      cash_given: cashGiven,
      cash_change: entry.cashChange,
      datetime: entry.at,
      replayed: false,
      // Nobody has been checked in server-side; the replay will do it. The
      // basket still decides whether a person walks in, which is what the
      // screen is about to say.
      checked_in: entry.admits ? 1 : 0,
      checkin_errors: [],
      offline: true,
    };
  }

  async function confirmPayment(paymentType: PaymentType, cashGiven: string | null) {
    if (!pairing || !paying) return;

    if (!online) {
      setPayError(null);
      try {
        const result = sellOffline(paymentType, cashGiven);
        setSale(result);
        setPaying(null);
        setCart([]);
        setCredit(null);
      } catch {
        setPayError(t("offline.queueFailed"));
      }
      return;
    }

    setBusy(true);
    setPayError(null);
    try {
      const result = await api.checkout(pairing, {
        idempotency_key: paying.key,
        positions: cart.map((line) => ({
          item: line.itemId,
          variation: line.variationId,
          count: line.count,
        })),
        payment_type: paymentType,
        cash_given: cashGiven,
        cashier,
        // What the customer was just told. The server refuses rather than
        // charge a different figure.
        expected_total: fromCents(total),
      });
      setSale(result);
      setPaying(null);
      setCart([]);
      // Spent: the corrected order has been settled against it.
      setCredit(null);
    } catch (err) {
      if (err instanceof ApiError && (err.isNetwork || err.status >= 500)) {
        // The server could not take this sale: the network died, or it answered
        // with a fault of its own. Either way the sale is not lost and the
        // customer is not asked to pay again — it goes to the queue under the
        // SAME idempotency key, so if the request did in fact commit before the
        // answer went missing, the replay recognises it and returns the
        // original order instead of selling a second time.
        //
        // A 4xx is the opposite case and deliberately not caught here: the
        // server understood and refused, and queueing a refusal would only mean
        // being refused again later, out of sight of the person who could fix it.
        try {
          const queued = sellOffline(paymentType, cashGiven);
          setSale(queued);
          setPaying(null);
          setCart([]);
          setCredit(null);
        } catch {
          setPayError(t("offline.queueFailed"));
        }
        return;
      }
      if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === "price_changed") {
        // Prices moved under an open basket. Nothing was charged. Pull the new
        // catalogue and re-price the basket in place, so the payment panel —
        // which stays open with the message — shows the figure that will
        // actually be taken.
        void api
          .catalog(pairing)
          .then((next) => {
            setCatalog(next);
            setCart((lines) => repriceCart(lines, next));
          })
          .catch(() => {});
      }
      setPayError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (gated) return <InstallGate />;

  if (!pairing) return <PairingScreen onPaired={onPaired} />;

  if (loadError) {
    return (
      <div className="centered">
        <div className="panel">
          <h2>{t("error.title")}</h2>
          <div className="error-banner">{loadError}</div>
          <button className="btn primary" onClick={() => void load(pairing)}>
            {t("error.retry")}
          </button>
          <button className="btn ghost" style={{ marginTop: 10 }} onClick={unpair}>
            {t("settings.unpair")}
          </button>
        </div>
      </div>
    );
  }

  if (!config || !catalog) {
    return (
      <div className="centered">
        <div style={{ color: "var(--text-dim)" }}>…</div>
      </div>
    );
  }

  const total = cart.reduce((sum, line) => sum + line.unitPrice * line.count, 0);

  // The server has been upgraded under this till. Only ever offered between
  // customers — reloading is safe (the queue and pairing survive it), but the
  // button must not sit next to a basket being rung up.
  const updateAvailable = config.version !== undefined && config.version !== __APP_VERSION__;

  return (
    <div className="app">
      <div className="topbar">
        <h1>{config.event.name}</h1>
        {config.event.testmode && <span className="badge">{t("testmode")}</span>}
        <span className="spacer" />
        {updateAvailable && !servingCustomer && (
          <button className="btn ghost topbar-action" onClick={() => void reloadForUpdate()}>
            {t("update.reload")}
          </button>
        )}
        {cashier && <span className="badge muted">{cashier}</span>}
        {config.checkin.lists.length > 0 && (
          <button
            className="btn ghost topbar-action"
            onClick={() => setCheckinOpen(true)}
          >
            {t("checkin.open")}
          </button>
        )}
        {(!online || pending > 0) && (
          <button
            className={`btn ghost topbar-action sync-badge${online ? "" : " is-offline"}`}
            onClick={() => setSyncOpen(true)}
          >
            {online
              ? t("offline.badgePending", { n: pending })
              : t("offline.badgeOffline", { n: pending })}
          </button>
        )}
        <button
          className="icon-button"
          onClick={() => setHistoryOpen(true)}
          aria-label={t("history.open")}
          title={t("history.open")}
        >
          🧾
        </button>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="settings">
          ⚙
        </button>
      </div>

      <SaleScreen
        catalog={catalog}
        cart={cart}
        currency={config.event.currency}
        onAdd={addProduct}
        onSetCount={setCount}
        onClear={clearCart}
        onCharge={() => {
          setPayError(null);
          setPaying({ key: newNonce() });
        }}
      />

      {paying && (
        <PaymentPanel
          totalCents={total}
          currency={config.event.currency}
          denominations={config.cash_denominations}
          busy={busy}
          error={payError}
          credit={credit}
          onConfirm={confirmPayment}
          onCancel={() => setPaying(null)}
        />
      )}

      {sale && (
        <DoneScreen
          sale={sale}
          currency={config.event.currency}
          onDismiss={() => setSale(null)}
        />
      )}

      {checkinOpen && (
        <CheckinScreen
          pairing={pairing}
          lists={config.checkin.lists}
          defaultListId={config.checkin.list_id}
          admissionItems={config.admission_items}
          onClose={() => setCheckinOpen(false)}
        />
      )}

      {syncOpen && (
        <SyncPanel
          online={online}
          syncing={syncing}
          report={lastSync}
          onSync={() => void sync()}
          onClose={() => setSyncOpen(false)}
        />
      )}

      {historyOpen && (
        <HistoryPanel
          pairing={pairing}
          currency={config.event.currency}
          cashier={cashier}
          onReuse={(positions, granted) => {
            // Straight into the basket, replacing whatever was there: this only
            // ever runs right after a cancellation, and the operator asked for
            // these exact lines to correct.
            setCart(basketFromJournal(positions, catalog));
            setCredit(granted);
            setHistoryOpen(false);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          pairing={pairing}
          currency={config.event.currency}
          cashier={cashier}
          onCashierChange={(name) => {
            setCashier(name);
            saveCashier(name);
          }}
          onRefresh={() => {
            void load(pairing);
            setSettingsOpen(false);
          }}
          onUnpair={unpair}
          onClose={() => setSettingsOpen(false)}
          onEventChange={(slug) => {
            // The basket belongs to the event it was built for.
            const next = { ...pairing, event: slug };
            savePairing(next);
            setCart([]);
            setCredit(null);
            setPairing(next);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
