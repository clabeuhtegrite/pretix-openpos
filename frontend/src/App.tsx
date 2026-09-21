import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "./api";
import { basketFromJournal, customKey, refundKey, repriceCart } from "./basket";
import CheckinScreen from "./components/CheckinScreen";
import CustomSalePanel from "./components/CustomSalePanel";
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
  loadUpdateAttempt, requestPersistence, saveCached, saveCashier, savePairing,
  saveUpdateAttempt,
} from "./storage";
import { useConnectivity } from "./connectivity";
import { drainQueue } from "./sync";
import { applyTheme, loadTheme, saveTheme, watchDeviceTheme, type Theme } from "./theme";
import type {
  Catalog, CartLine, DeviceRole, Pairing, PaymentType, PosConfig, QueuedSale,
  SaleResult, SyncReport,
} from "./types";
import { useBackClose } from "./useBackClose";
import { useOfflineSnapshot } from "./useOfflineSnapshot";
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
 * The check-in list this device scans on.
 *
 * The one it was last switched to at the door, as long as the event still has
 * it; else the list sales check into; else the event's first. Decided here
 * rather than in the door screen because it matters before that screen has
 * ever been opened: the guest list carried for a dropout is fetched for it
 * from the moment the till is paired.
 */
function doorListFor(config: PosConfig | null, chosen: number | null): number | null {
  if (!config) return null;
  const lists = config.checkin.lists;
  if (chosen !== null && lists.some((list) => list.id === chosen)) return chosen;
  return config.checkin.list_id ?? lists[0]?.id ?? null;
}

/**
 * Which screen this device opens on, and what it may reach from there.
 *
 * The role is the server's answer, not a preference held here: it is what makes
 * "a till with a card reader cannot take a card payment the reader did not
 * validate" a rule rather than a hope, and a rule the app enforced on itself
 * would be no rule at all — this page can be a build old enough to predate the
 * reader, or simply edited. So the app renders what it is told, and the server
 * checks the same thing again at checkout.
 *
 * A device nobody has assigned — which is every device paired before roles
 * existed, and every device on a server too old to have the field — is
 * deliberately not treated as a till: it keeps doing both jobs, exactly as it
 * did before. Nothing changes until somebody chooses.
 */
function screensFor(config: PosConfig | null) {
  const role: DeviceRole | undefined = config?.device.role;
  return {
    /** This device's job is the door, whatever screen happens to be on top. */
    atDoor: role === "door",
    /**
     * ...and there is something to scan, so the scanner is both where it opens
     * and where it comes back to after a sale. An event with no check-in list
     * has nothing: sending a door back to an empty scanner after every ticket
     * would be a loop rather than a home screen, so it lives on the grid.
     */
    opensOnDoor: role === "door" && (config?.checkin.lists.length ?? 0) > 0,
    /** A bar till has no door to open; anything unassigned still does. */
    doorReachable: role !== "pos",
  };
}

/**
 * Pull the new build in one tap.
 *
 * The service worker hands static assets out cache-first, so a bare reload
 * would come back with the very bundle it is trying to replace. Dropping the
 * caches first makes the reload fetch the new shell for real.
 */
async function reloadForUpdate(serverVersion: string): Promise<void> {
  // Written before the reload, not after: whatever comes back has to be able to
  // tell that the offer was already taken up.
  saveUpdateAttempt(serverVersion);
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
  const [theme, setTheme] = useState<Theme>(loadTheme);
  /** Read once at startup: the server version a previous reload already tried. */
  const [updateTried] = useState<string | null>(loadUpdateAttempt);

  // Non-null while the payment panel is open. The key is minted once per
  // attempt and reused across retries, so a timeout that actually committed
  // cannot turn into a second sale.
  const [paying, setPaying] = useState<{ key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const [sale, setSale] = useState<SaleResult | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
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

  // main.tsx has already painted this once before the first render; running it
  // again here is what makes a change in the settings panel take effect, and
  // costs one attribute write on mount.
  useEffect(() => applyTheme(theme), [theme]);
  // The palette itself follows the device through a CSS media query, with no
  // help from here. Only the status-bar colour has to be told.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => watchDeviceTheme(() => themeRef.current), []);

  // What is queued is money that exists nowhere else yet; ask the browser not
  // to evict it.
  useEffect(requestPersistence, []);

  const { atDoor, opensOnDoor, doorReachable } = screensFor(config);

  // A door device opens on the scanner. An effect rather than an initial state,
  // because the role arrives with the config a moment after the first render;
  // and keyed on the answer rather than run once on mount, so an idle catalogue
  // refresh that hands back the same role does not shove the scanner back over
  // a basket the volunteer is in the middle of ringing up.
  useEffect(() => {
    if (opensOnDoor) setCheckinOpen(true);
  }, [opensOnDoor]);

  /** The list last chosen at the door, so the door reopens on it — see doorListFor. */
  const [doorListId, setDoorListId] = useState<number | null>(null);
  const doorList = doorListFor(config, doorListId);
  // The guest list for a dropout, fetched from the moment the till is paired
  // rather than the first time somebody opens the scanner. The door screen
  // fetches for the list on screen while it is open, and this stands down for
  // that time, so the two never run side by side.
  useOfflineSnapshot(pairing, doorList, online && !checkinOpen);

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
  useBackClose(customOpen, () => setCustomOpen(false));
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
      // A 401 or 403 is the server refusing this till: revoked, deleted, or
      // Open POS switched off on its event. It is said on screen with the way
      // out next to it — retry, or unpair — and never acted on by clearing the
      // pairing. An earlier version did exactly that, and the same two status
      // codes are what a CDN or a firewall in front of pretix answers with
      // when it challenges a request: a till that unpaired itself on one of
      // those at nine in the evening cannot be brought back without somebody
      // at the back office minting a new code. Nor does it fall back on the
      // cache below: a revoked device selling from a stale catalogue would
      // only be refused again at the first sale, in front of a customer.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setLoadError(t("error.refused", { detail: err.message }));
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
  // The free-amount panel counts even with an empty basket: an amount typed
  // against a tariff that moves underneath it is the same bug one step earlier.
  const servingCustomer =
    cart.length > 0 || paying !== null || sale !== null || checkinOpen || customOpen;

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

  /**
   * A price and a reason the cashier typed, as its own basket line.
   *
   * Never merged with anything: two free amounts are two different things
   * even at the same price, hence a key of its own per line.
   */
  function addCustom(amountCents: number, reason: string) {
    if (!config?.custom_sale?.item) return;
    setCart((current) => [
      ...current,
      {
        key: customKey(newNonce()),
        itemId: config.custom_sale!.item as number,
        variationId: null,
        label: reason,
        unitPrice: amountCents,
        count: 1,
        available: null,
        description: reason,
      },
    ]);
    setCustomOpen(false);
  }

  /**
   * A cup coming back over the counter.
   *
   * A negative line in the ordinary basket rather than a flow of its own, so
   * that "two beers and I am returning three cups" is one transaction and one
   * amount to settle — which is what actually happens at a bar.
   */
  function addDepositBack() {
    const deposit = config?.deposit;
    if (!deposit?.item || deposit.price === null) return;
    const key = refundKey(deposit.item);
    const unitPrice = -toCents(deposit.price);
    setCart((current) => {
      const existing = current.find((line) => line.key === key);
      if (existing) {
        return current.map((line) =>
          line.key === key ? { ...line, count: line.count + 1 } : line,
        );
      }
      return [
        ...current,
        {
          key,
          itemId: deposit.item as number,
          variationId: null,
          label: t("deposit.line", { name: deposit.name ?? "" }),
          unitPrice,
          count: 1,
          available: null,
          refund: true,
        },
      ];
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
        // Negative on a deposit handed back, which is the same statement of
        // fact pointing the other way.
        price: fromCents(line.unitPrice),
        ...(line.description ? { description: line.description } : {}),
        ...(line.refund ? { refund: true } : {}),
      })),
      chargedTotal: fromCents(total),
      paymentType,
      cashGiven,
      cashChange:
        cashGiven === null ? null : fromCents(Math.max(toCents(cashGiven) - total, 0)),
      cashier,
      // A returned cup lets nobody in, whatever product it is booked against.
      admits: cart.some((line) => !line.refund && admissionItems.has(line.itemId)),
      label: cart.map((line) => `${line.count}× ${line.label}`).join(", "),
    };
    enqueue(entry);
    setPending(loadQueue().length);

    // Shaped like a server answer so every screen downstream stays unchanged;
    // what it does not have is an order code, because no order exists yet.
    return {
      order: { code: "", total: fromCents(Math.max(soldCents, 0)), url: null },
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
      deposit_refund: refundedCents > 0 ? fromCents(refundedCents) : null,
      net_total: entry.chargedTotal,
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
          // The two lines the server cannot price on its own: a free amount
          // comes with its figure and its reason, a returned deposit only
          // says that it is one.
          ...(line.description
            ? { price: fromCents(line.unitPrice), description: line.description }
            : {}),
          ...(line.refund ? { refund: true } : {}),
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
          <button
            className="btn ghost"
            style={{ marginTop: 10 }}
            onClick={() => {
              if (confirm(t("settings.unpairConfirm"))) unpair();
            }}
          >
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

  // Three figures, and they are only the same one when no deposit comes back.
  // `total` is what changes hands; `soldCents` is what the order is worth, and
  // is what pretix is told about; `refundedCents` is what leaves the drawer.
  const total = cart.reduce((sum, line) => sum + line.unitPrice * line.count, 0);
  const soldCents = cart.reduce(
    (sum, line) => sum + (line.refund ? 0 : line.unitPrice * line.count),
    0,
  );
  const refundedCents = soldCents - total;

  // The server has been upgraded under this till. Only ever offered between
  // customers — reloading is safe (the queue and pairing survive it), but the
  // prompt must not sit next to a basket being rung up. And only ever offered
  // once per server version: if the till came back from that reload still
  // mismatched, the build it was served cannot satisfy this server and asking
  // again every minute would be noise for the rest of the evening.
  const updateAvailable =
    config.version !== undefined &&
    config.version !== __APP_VERSION__ &&
    config.version !== updateTried;

  return (
    <div className="app">
      <div className="topbar">
        <h1>{config.event.name}</h1>
        {config.event.testmode && <span className="badge">{t("testmode")}</span>}
        <span className="spacer" />
        {cashier && <span className="badge muted">{cashier}</span>}
        {doorReachable && config.checkin.lists.length > 0 && !checkinOpen && (
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

      {updateAvailable && !servingCustomer && (
        <button
          className="update-bar"
          onClick={() => void reloadForUpdate(config.version as string)}
        >
          {t("update.reload")}
        </button>
      )}

      <SaleScreen
        catalog={catalog}
        cart={cart}
        currency={config.event.currency}
        customSale={
          config.custom_sale?.enabled && config.custom_sale.name
            ? { name: config.custom_sale.name }
            : null
        }
        depositBack={
          config.deposit?.enabled && config.deposit.price !== null
            ? {
                name: config.deposit.name ?? "",
                priceCents: toCents(config.deposit.price),
              }
            : null
        }
        onAdd={addProduct}
        onCustomSale={() => setCustomOpen(true)}
        onDepositBack={addDepositBack}
        onSetCount={setCount}
        onClear={clearCart}
        onCharge={() => {
          setPayError(null);
          setPaying({ key: newNonce() });
        }}
      />

      {customOpen && (
        <CustomSalePanel
          currency={config.event.currency}
          productName={config.custom_sale?.name ?? ""}
          onAdd={addCustom}
          onCancel={() => setCustomOpen(false)}
        />
      )}

      {paying && (
        <PaymentPanel
          totalCents={total}
          currency={config.event.currency}
          denominations={config.cash_denominations}
          cardMode={config.device.card ?? "declared"}
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
          onDismiss={() => {
            setSale(null);
            // At the door the grid is a detour, not a destination: the ticket
            // has been sold and the next person in the queue is holding a QR
            // code. A till stays where it is.
            if (opensOnDoor) setCheckinOpen(true);
          }}
        />
      )}

      {checkinOpen && (
        <CheckinScreen
          pairing={pairing}
          lists={config.checkin.lists}
          defaultListId={doorList}
          admissionItems={config.admission_items}
          onListChange={setDoorListId}
          // The door steps out to the grid to sell a ticket; every other device
          // already has the grid underneath and is merely closing an overlay.
          onSell={atDoor ? () => setCheckinOpen(false) : undefined}
          onClose={() => setCheckinOpen(false)}
        />
      )}

      {syncOpen && (
        <SyncPanel
          online={online}
          syncing={syncing}
          report={lastSync}
          event={pairing.event}
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
          theme={theme}
          onThemeChange={(next) => {
            setTheme(next);
            saveTheme(next);
          }}
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
            // So does the door: its lists belong to the event too.
            setDoorListId(null);
            setPairing(next);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
