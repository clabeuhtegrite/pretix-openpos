import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "./api";
import CheckinScreen from "./components/CheckinScreen";
import DoneScreen from "./components/DoneScreen";
import InstallGate, { browserAllowed, isStandalone } from "./components/InstallGate";
import PairingScreen from "./components/PairingScreen";
import PaymentPanel from "./components/PaymentPanel";
import SaleScreen, { type Sellable } from "./components/SaleScreen";
import SettingsPanel from "./components/SettingsPanel";
import { t } from "./i18n";
import { fromCents, toCents } from "./money";
import { newNonce } from "./nonce";
import {
  clearPairing, loadCashier, loadPairing, saveCashier, savePairing,
} from "./storage";
import type { Catalog, CartLine, Pairing, PaymentType, PosConfig, SaleResult } from "./types";
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

/** Re-price an open basket against a freshly loaded catalogue. */
function repriceCart(lines: CartLine[], catalog: Catalog): CartLine[] {
  const prices = new Map<string, number>();
  for (const category of catalog.categories) {
    for (const item of category.items) {
      if (item.variations.length) {
        for (const variation of item.variations) {
          prices.set(`${item.id}:${variation.id}`, toCents(variation.price));
        }
      } else {
        prices.set(`${item.id}:`, toCents(item.price));
      }
    }
  }
  // A line whose product vanished from the catalogue keeps its price here; the
  // server refuses it at checkout, which is the answer that matters.
  return lines.map((line) =>
    prices.has(line.key) ? { ...line, unitPrice: prices.get(line.key)! } : line,
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.isNetwork ? t("error.offline") : err.message;
  return String(err);
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

  // Evaluated once: display-mode does not change without a reload, and a value
  // that flickers would bounce the operator out of a sale.
  const [gated] = useState(() => !isStandalone() && !browserAllowed());

  useWakeLock(pairing !== null);

  const load = useCallback(async (p: Pairing) => {
    setLoadError(null);
    try {
      const [nextConfig, nextCatalog] = await Promise.all([api.config(p), api.catalog(p)]);
      setConfig(nextConfig);
      setCatalog(nextCatalog);
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
      api
        .catalog(pairing)
        .then((next) => {
          if (!cancelled) setCatalog(next);
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

  function setCount(key: string, count: number) {
    setCart((current) =>
      count <= 0
        ? current.filter((line) => line.key !== key)
        : current.map((line) => (line.key === key ? { ...line, count } : line)),
    );
  }

  async function confirmPayment(paymentType: PaymentType, cashGiven: string | null) {
    if (!pairing || !paying) return;
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
    } catch (err) {
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

  return (
    <div className="app">
      <div className="topbar">
        <h1>{config.event.name}</h1>
        {config.event.testmode && <span className="badge">{t("testmode")}</span>}
        <span className="spacer" />
        {cashier && <span className="badge muted">{cashier}</span>}
        {config.checkin.lists.length > 0 && (
          <button
            className="btn ghost topbar-action"
            onClick={() => setCheckinOpen(true)}
          >
            {t("checkin.open")}
          </button>
        )}
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
        onClear={() => setCart([])}
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
          onClose={() => setCheckinOpen(false)}
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
            setPairing(next);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
