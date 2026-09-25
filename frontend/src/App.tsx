import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, errorCode, type PositionPayload } from "./api";
import { basketFromJournal, customKey, refundKey, repriceCart } from "./basket";
import CheckinScreen from "./components/CheckinScreen";
import CustomSalePanel from "./components/CustomSalePanel";
import DoneScreen from "./components/DoneScreen";
import DrawerPanel from "./components/DrawerPanel";
import { OtherEvents } from "./components/EventChoice";
import HistoryPanel from "./components/HistoryPanel";
import InstallGate, { browserAllowed, isStandalone } from "./components/InstallGate";
import PairingScreen from "./components/PairingScreen";
import PaymentPanel from "./components/PaymentPanel";
import SaleScreen, { type Sellable } from "./components/SaleScreen";
import SettingsPanel from "./components/SettingsPanel";
import SyncPanel from "./components/SyncPanel";
import { briefOf, cashBlockedBy, drawerIcon } from "./drawer";
import { describeError } from "./errors";
import { t } from "./i18n";
import { fromCents, toCents } from "./money";
import { newNonce } from "./nonce";
import { play, setSoundEnabled, soundEnabled, unlock } from "./sound";
import {
  clearBasket, clearPairing, enqueue, loadBasket, loadCached, loadCashier, loadFailures,
  loadPairing, loadQueue, loadUpdateAttempt, queueRevocation, requestPersistence, saveBasket,
  saveCached, saveCashier, savePairing, saveUpdateAttempt,
} from "./storage";
import { useConnectivity } from "./connectivity";
import { drainQueue } from "./sync";
import { applyTheme, loadTheme, saveTheme, watchDeviceTheme, type Theme } from "./theme";
import type {
  Catalog, CartLine, Credit, DeviceRole, DrawerState, Pairing, PaymentType, PosConfig,
  QueuedSale, SaleResult, SyncReport,
} from "./types";
import { useBackClose } from "./useBackClose";
import { markDeviceReported, useDeviceReport } from "./useDeviceReport";
import { useDeviceRevoke } from "./useDeviceRevoke";
import { useOfflineSnapshot } from "./useOfflineSnapshot";
import { useTerminal } from "./useTerminal";
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

/**
 * How often a till with something to send tries again while it believes it
 * is online. Each try is one request when the network is still not taking
 * writes, and nothing at all once the queue is empty.
 */
const DRAIN_RETRY_MS = 15_000;

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
  /**
   * Why the till could not open, when it could not.
   *
   * `refused` is the server turning this device away — the only case where
   * unpairing is the answer, and the only case that offers it.
   */
  const [loadError, setLoadError] = useState<{ text: string; refused: boolean } | null>(null);

  /**
   * The basket, restored if this till was interrupted mid-sale.
   *
   * Read once, from the same storage the effect below writes to, and only for
   * the event this till is paired to. What comes back is priced as it was
   * left; the catalogue may have moved since, which is what the reprice below
   * settles before the operator reads a figure out to anybody.
   */
  const restored = useState(() => (pairing ? loadBasket(pairing.event) : null))[0];
  const [cart, setCart] = useState<CartLine[]>(() => restored?.cart ?? []);
  const [cashier, setCashier] = useState<string>(loadCashier);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [sound, setSound] = useState(soundEnabled);
  /** Read once at startup: the server version a previous reload already tried. */
  const [updateTried] = useState<string | null>(loadUpdateAttempt);

  // Non-null while the payment panel is open. The key is minted once per
  // attempt and reused across retries, so a timeout that actually committed
  // cannot turn into a second sale.
  const [paying, setPaying] = useState<{ key: string } | null>(null);
  const terminal = useTerminal(pairing, (payment) => {
    // The reader has the money. What follows is the same call as any other
    // card sale — the server looks the payment up against this device before
    // it writes anything down, which is the whole point of doing it this way.
    void confirmPayment("card", null, payment.amount);
  });
  const resetTerminal = terminal.reset;
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const [sale, setSale] = useState<SaleResult | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /**
   * Money already taken off the customer by a cancellation they are correcting.
   *
   * Held here rather than in the panel that created it, because it has to
   * outlive that panel: it is spent at the payment step, against a basket the
   * operator may still be editing.
   */
  const [credit, setCredit] = useState<Credit | null>(() => restored?.credit ?? null);

  const online = useConnectivity();
  const [pending, setPending] = useState(() => loadQueue().length);
  /**
   * Entries the server refused, which nobody has dealt with yet.
   *
   * Counted here because the badge is the only door to the panel that shows
   * them. A drain that sends forty sales and has one refused leaves nothing to
   * send and a till that is back online — so the badge used to disappear,
   * taking the unread refusal with it, in direct contradiction of the rule
   * that no refusal is ever swallowed.
   */
  const [failures, setFailures] = useState(() => loadFailures().length);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);

  // Evaluated once: display-mode does not change without a reload, and a value
  // that flickers would bounce the operator out of a sale.
  const [gated] = useState(() => !isStandalone() && !browserAllowed());

  useWakeLock(pairing !== null);
  // So that pretix' device list shows the build this device runs now, not the
  // one it was paired with.
  useDeviceReport(pairing, online);
  // So that a till unpaired here reads revoked there, not active.
  useDeviceRevoke(pairing, online);

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

  /**
   * Start the audio on the first tap, whatever that tap was.
   *
   * No browser will start an audio context outside a gesture, and the sound
   * that matters most — a refused ticket at the door — arrives on a camera
   * frame rather than a tap. So it is claimed at the first opportunity,
   * whichever screen the operator happens to be on.
   */
  useEffect(() => {
    const once = () => {
      unlock();
      window.removeEventListener("pointerdown", once);
    };
    window.addEventListener("pointerdown", once);
    return () => window.removeEventListener("pointerdown", once);
  }, []);

  /**
   * Keep the basket on disk, so a reload does not lose it.
   *
   * An effect rather than a write at each of the dozen places that change the
   * basket: one of those would be missed, and a basket that survives only the
   * reloads somebody remembered to handle is a basket that does not survive.
   * The credit is the part that matters — it is money the till is holding for
   * a customer, and until the corrected sale is recorded it exists nowhere
   * else at all.
   */
  useEffect(() => {
    if (!pairing) return;
    saveBasket(pairing.event, cart, credit);
  }, [pairing, cart, credit]);

  /**
   * Price a restored basket against the catalogue that is actually live.
   *
   * It was saved with the prices of the session that was interrupted, and the
   * tariff may have been edited since. The server would refuse the sale and
   * the panel would recover — that safety net is already there — but the
   * figure the operator reads out to a customer has to be right the first
   * time. Once only: after this the ordinary refresh owns the prices.
   */
  const repriced = useRef(restored === null);
  useEffect(() => {
    if (!catalog || repriced.current) return;
    repriced.current = true;
    setCart((lines) => repriceCart(lines, catalog));
  }, [catalog]);

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
      setFailures(loadFailures().length);
      setSyncing(false);
    }
  }, [pairing]);

  useEffect(() => {
    // Back on the network with something to send, and nobody mid-transaction:
    // interrupting a payment panel to replay a queue would be the worst moment.
    if (!online || pending === 0 || paying !== null) return;
    void sync();
    // And again every little while, for as long as it stays that way. A drain
    // that stopped on a failed request is otherwise retried only when the
    // network is seen to come back, and a failure answered at once by a
    // request that got through — the door's head count, its guest list — is
    // never seen as a coming back at all: the till went offline and online
    // again between two renders. Tried against a real pretix, scans sat on
    // the phone that way, network back and badge showing, until the app was
    // opened again.
    const timer = window.setInterval(() => void sync(), DRAIN_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [online, pending, paying, sync]);

  // Android's back gesture closes what is on top, not the till. The payment
  // panel is deliberately absent: backing out of a half-tendered payment by
  // reflex is not something to make one swipe away.
  useBackClose(customOpen, () => setCustomOpen(false));
  useBackClose(settingsOpen, () => setSettingsOpen(false));
  useBackClose(checkinOpen, () => setCheckinOpen(false));
  useBackClose(historyOpen, () => setHistoryOpen(false));
  useBackClose(syncOpen, () => setSyncOpen(false));
  useBackClose(drawerOpen, () => setDrawerOpen(false));
  useBackClose(sale !== null, () => setSale(null));

  /**
   * The till is asking the server for its event, and has no answer yet.
   *
   * What the error page's retry and the settings panel's reload show while
   * they wait: both used to look exactly as they had before the tap until the
   * answer came, so there was no telling a slow server from a tap that had
   * not registered.
   */
  const [loading, setLoading] = useState(false);
  // Bumped on every call, so an answer for an event the till has since left
  // cannot land on the one it switched to.
  const loadRun = useRef(0);

  /**
   * Open the till on its event: from the server, or from what this device
   * kept when the server does not answer.
   *
   * True when the server answered. The page on screen stays until then — an
   * error included, which is only replaced once there is something to replace
   * it with.
   */
  const load = useCallback(async (p: Pairing): Promise<boolean> => {
    const run = ++loadRun.current;
    setLoading(true);
    try {
      const [nextConfig, nextCatalog] = await Promise.all([api.config(p), api.catalog(p)]);
      if (run !== loadRun.current) return false;
      setLoadError(null);
      setConfig(nextConfig);
      setCatalog(nextCatalog);
      // Kept so the till can be started again during an outage.
      saveCached("config", p.event, nextConfig);
      saveCached("catalog", p.event, nextCatalog);
      return true;
    } catch (err) {
      if (run !== loadRun.current) return false;
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
        setLoadError({ text: t("error.refused", { detail: err.message }), refused: true });
        return false;
      }

      // The event is a series and no date is on tonight. Said rather than
      // papered over with the cache below, because the cache would hand back
      // last week's catalogue and the till would sell against a date that is
      // over — the queue would only find out at the payment, which is the
      // whole shape of the bug this replaced. It is also the one thing here
      // that somebody can fix in a minute from the back office.
      if (errorCode(err) === "series_closed") {
        setLoadError({ text: describeError(err), refused: false });
        return false;
      }

      // Anything else — no network, a gateway answering for a server that is
      // restarting — must not turn a till into a brick mid-evening. If this
      // device has been here before, it opens on what it was last told and goes
      // on selling; the queue is what makes that safe.
      const cachedConfig = loadCached<PosConfig>("config", p.event);
      const cachedCatalog = loadCached<Catalog>("catalog", p.event);
      if (cachedConfig && cachedCatalog) {
        setLoadError(null);
        setConfig(cachedConfig);
        setCatalog(cachedCatalog);
        return false;
      }
      setLoadError({ text: describeError(err), refused: false });
      return false;
    } finally {
      if (run === loadRun.current) setLoading(false);
    }
  }, []);

  /**
   * Why "Recharger le catalogue" did not, when it did not.
   *
   * The panel used to close the moment it was pressed, and a reload that
   * failed looked exactly like one that worked. It now stays open until the
   * answer is in, closes on success, and says so on anything else.
   */
  const [reloadFailed, setReloadFailed] = useState(false);

  async function reloadCatalog(p: Pairing) {
    setReloadFailed(false);
    if (await load(p)) setSettingsOpen(false);
    // A refusal has put the error page up instead, and this panel with the
    // rest of the till is gone from under it; anything else leaves the till
    // selling on the catalogue it had.
    else setReloadFailed(true);
  }

  /** The update bar has been pressed, and the new build is being fetched. */
  const [updating, setUpdating] = useState(false);

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

  /**
   * The drawer panel, once, when the till starts on a drawer that cannot take cash.
   *
   * The start of an evening is when a float gets counted in, and a till that
   * waited for the first customer paying cash to say so would be asking for a
   * count with the customer standing there. Once per launch and no more: a
   * volunteer who closes it has a reason, and the banner under the top bar
   * keeps saying it. Never over a basket restored mid-sale, nor offline, where
   * a drawer can be neither read nor opened.
   */
  const drawerAsked = useRef(false);
  useEffect(() => {
    if (!config || drawerAsked.current) return;
    drawerAsked.current = true;
    if (cashBlockedBy(config.drawer, online) && cart.length === 0 && credit === null) {
      setDrawerOpen(true);
    }
    // Keyed on the config alone: only the first one counts, and what the
    // later ones say is the banner's job.
  }, [config]);

  /**
   * What the drawer panel just read or did, as the rest of the till sees it.
   *
   * Written into the config rather than kept beside it, so the banner, the
   * payment panel and the idle refresh all read one answer — and the refresh,
   * which asks the server every minute, is the one that keeps it right when
   * the drawer is opened or closed on another tablet.
   */
  const applyDrawer = useCallback((state: DrawerState) => {
    setConfig((current) => (current ? { ...current, drawer: briefOf(state) } : current));
  }, []);

  function onPaired(next: Pairing) {
    markDeviceReported(next.serial);
    savePairing(next);
    setPairing(next);
  }

  /**
   * Sell for another event from now on, without pairing again.
   *
   * The basket belongs to the event it was built for, and so does the door:
   * its lists are that event's. What was on screen goes too, so nothing of
   * the previous event can be rung up under the next one's name while its
   * catalogue is on its way.
   */
  function switchEvent(slug: string) {
    if (!pairing || slug === pairing.event) return;
    // A credit is money owed to a customer for a cancelled sale, and it lives
    // nowhere else until the corrected sale is rung up — the same question
    // "Clear" asks before dropping it.
    if (credit && !window.confirm(t("settings.eventCredit", { order: credit.order }))) return;
    const next = { ...pairing, event: slug };
    savePairing(next);
    setCart([]);
    setCredit(null);
    setDoorListId(null);
    // The event being left may be the one that would not open: what is on
    // screen next is the new one loading, not the old one's error.
    setLoadError(null);
    setConfig(null);
    setCatalog(null);
    setPairing(next);
    setSettingsOpen(false);
  }

  function unpair() {
    // Queued, not sent from here: unpairing must work without a network, and
    // useDeviceRevoke sends it the moment there is one.
    if (pairing) queueRevocation(pairing.token);
    clearPairing();
    clearBasket();
    setPairing(null);
    setLoadError(null);
    setConfig(null);
    setCatalog(null);
    setCart([]);
    setCredit(null);
    setSettingsOpen(false);
  }

  function addProduct(product: Sellable) {
    // Before the state update, not after: the point of the click is that the
    // tap registered, whichever way the basket then goes.
    play("add");
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

  /**
   * Emptying the basket abandons the correction, and the credit with it.
   *
   * Asked about only when there is a credit, because only then is the tap
   * expensive: a basket of drinks is ten seconds to ring up again, while a
   * credit is money the till is holding for a customer who is standing
   * there — gone from the app the moment it is dropped, and recoverable only
   * by finding the cancellation again in the history. A dialog on every clear
   * would be a dialog nobody reads by the third one.
   */
  function clearCart() {
    if (credit && !window.confirm(t("sale.clearCredit", { order: credit.order }))) {
      return;
    }
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
  function sellOffline(
    paymentType: PaymentType,
    cashGiven: string | null,
    charged?: string,
  ): SaleResult {
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
      // What the reader took, when one did: the server priced this basket
      // when it put it on the reader, and that is the figure the customer
      // agreed to. Without it the receipt and the sync panel read out this
      // app's own total, which is not what the card paid.
      chargedTotal: charged ?? fromCents(total),
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
      order: { code: "", total: fromCents(Math.max(soldCents, 0)) },
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

  /**
   * The basket as the server wants it: products and quantities.
   *
   * The same statement whether it is going to the card reader or to the
   * checkout, which is what makes the card charge and the order agree — the
   * reader is sent exactly what the order will be built from.
   */
  function positionsPayload(): PositionPayload[] {
    return cart.map((line) => ({
      item: line.itemId,
      variation: line.variationId,
      count: line.count,
      // The two lines the server cannot price on its own: a free amount comes
      // with its figure and its reason, a returned deposit only says that it
      // is one.
      ...(line.description
        ? { price: fromCents(line.unitPrice), description: line.description }
        : {}),
      ...(line.refund ? { refund: true } : {}),
    }));
  }

  /**
   * Put the basket on the card reader, under a key this sale will carry.
   *
   * A fresh key on every attempt, including a retry after a refusal: the
   * server remembers a reader payment by its key, so reusing a spent one would
   * find the refusal it already recorded instead of asking for a card again.
   */
  function startTerminal() {
    const key = newNonce();
    setPaying({ key });
    void terminal.start(key, positionsPayload());
  }

  /**
   * Record the sale the customer has just paid for.
   *
   * `charged` is what a card reader took, when one did: the server priced the
   * basket when it put it on the reader, and that figure — not this app's,
   * whose catalogue can be a refresh behind — is the one the customer agreed
   * to by tapping their card.
   */
  async function confirmPayment(
    paymentType: PaymentType,
    cashGiven: string | null,
    charged?: string,
  ) {
    if (!pairing || !paying) return;

    if (!online) {
      setPayError(null);
      try {
        const result = sellOffline(paymentType, cashGiven, charged);
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
        positions: positionsPayload(),
        payment_type: paymentType,
        cash_given: cashGiven,
        cashier,
        // What the customer was just told. The server refuses rather than
        // charge a different figure — except once a reader has taken the
        // money, where the figure the customer agreed to is the one on the
        // reader, and the basket is the one the server pinned for it.
        expected_total: charged ?? fromCents(total),
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
          const queued = sellOffline(paymentType, cashGiven, charged);
          setSale(queued);
          setPaying(null);
          setCart([]);
          setCredit(null);
        } catch {
          setPayError(t("offline.queueFailed"));
        }
        return;
      }
      const code = errorCode(err);
      if (code === "drawer_closed" || code === "drawer_stale") {
        // The drawer was closed under this till — on the other tablet, or from
        // the back office — or never opened. Nothing was recorded. Reading it
        // again is what lets the panel, which stays open with the message,
        // offer to open it rather than only say no.
        void api.drawer(pairing).then(applyDrawer).catch(() => {});
      }
      if (code === "price_changed") {
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

  // The panel has closed — the sale went through, or the basket came back.
  // Either way nothing is on the reader any more as far as this till goes.
  useEffect(() => {
    if (paying === null) resetTerminal();
  }, [paying, resetTerminal]);

  if (gated) return <InstallGate />;

  if (!pairing) return <PairingScreen onPaired={onPaired} />;

  if (loadError) {
    return (
      <div className="centered">
        <div className="panel">
          <h2>{t("error.title")}</h2>
          <div className="error-banner">{loadError.text}</div>
          <button
            className="btn primary"
            onClick={() => void load(pairing)}
            disabled={loading}
            aria-busy={loading || undefined}
          >
            {loading ? t("error.retrying") : t("error.retry")}
          </button>
          {/* An event that will not open is not the device's only one, and
              the others are one tap away rather than a new pairing. */}
          <OtherEvents pairing={pairing} onPick={switchEvent} />
          {/* Only when the server has turned this device away. A till that
              has merely lost the network is one retry from working, and
              unpairing it costs a new code typed at the back office by
              somebody who is not in the room — which is not a button to leave
              under a volunteer's thumb at one in the morning. */}
          {loadError.refused && (
            <button
              className="btn ghost"
              style={{ marginTop: 10 }}
              onClick={() => {
                if (confirm(t("settings.unpairConfirm"))) unpair();
              }}
            >
              {t("settings.unpair")}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!config || !catalog) {
    return (
      <div className="centered">
        <div className="loading">{t("app.loading")}</div>
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

  // The drawer this till's cash goes into, when it is not open to take any.
  const drawerBlocked = cashBlockedBy(config.drawer, online);

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
        {(!online || pending > 0 || failures > 0) && (
          <button
            className={`btn ghost topbar-action sync-badge${online ? "" : " is-offline"}`}
            onClick={() => setSyncOpen(true)}
          >
            {!online
              ? t("offline.badgeOffline", { n: pending })
              : pending > 0
                ? t("offline.badgePending", { n: pending })
                // Nothing left to send and the network is back, but something
                // was refused and nobody has looked at it. "0 to send" would
                // be true and useless; the badge has to name what is actually
                // outstanding, because it is the only way into the panel that
                // shows it.
                : t("offline.badgeFailed", { n: failures })}
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
        {config.drawer && (
          <button
            className={`icon-button${drawerBlocked ? " is-alert" : ""}`}
            onClick={() => setDrawerOpen(true)}
            aria-label={t("drawer.title", { name: config.drawer.name })}
            title={t("drawer.title", { name: config.drawer.name })}
          >
            {drawerIcon(config.event.currency)}
          </button>
        )}
        <button
          className="icon-button"
          onClick={() => {
            setReloadFailed(false);
            setSettingsOpen(true);
          }}
          aria-label="settings"
        >
          ⚙
        </button>
      </div>

      {/* Said as long as it is true, basket or not: it is the one thing that
          will stop the next cash payment, and the moment to find out is not
          with the customer's note in hand. */}
      {drawerBlocked && (
        <button className="update-bar drawer-bar" onClick={() => setDrawerOpen(true)}>
          {drawerBlocked.stale
            ? t("drawer.bannerStale", { name: drawerBlocked.name })
            : t("drawer.bannerClosed", { name: drawerBlocked.name })}
        </button>
      )}

      {updateAvailable && !servingCustomer && (
        <button
          className="update-bar"
          onClick={() => {
            setUpdating(true);
            void reloadForUpdate(config.version as string);
          }}
          // Nothing to set back: the page is on its way out.
          disabled={updating}
          aria-busy={updating || undefined}
        >
          {updating ? t("update.reloading") : t("update.reload")}
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
          terminal={terminal.state}
          onTerminalStart={startTerminal}
          onTerminalStop={() => void terminal.cancel()}
          busy={busy}
          error={payError}
          credit={credit}
          drawer={drawerBlocked}
          onOpenDrawer={() => setDrawerOpen(true)}
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
          // A scan admitted with no network is money's equivalent at the door:
          // pretix has not heard of it yet, and only this count gets it sent.
          onQueued={() => setPending(loadQueue().length)}
          // And when the count goes down, a drain has just sent some: the
          // door's counter asks the server again rather than wait a minute.
          pending={pending}
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
          // Refusals are cleared from inside the panel, so the count that
          // keeps the badge alive is re-read on the way out.
          onClose={() => {
            setSyncOpen(false);
            setFailures(loadFailures().length);
          }}
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
          sound={sound}
          onSoundChange={(on) => {
            setSound(on);
            setSoundEnabled(on);
            // So the choice is heard the moment it is made, rather than at the
            // next sale.
            if (on) play("ok");
          }}
          onRefresh={() => void reloadCatalog(pairing)}
          refreshing={loading}
          refreshFailed={reloadFailed}
          onUnpair={unpair}
          onClose={() => setSettingsOpen(false)}
          onEventChange={switchEvent}
        />
      )}

      {/* Last, so it lands over the payment panel it may have been opened
          from; its layer also clears the scanner, for a door that has one. */}
      {drawerOpen && (
        <DrawerPanel
          pairing={pairing}
          cashier={cashier}
          online={online}
          onState={applyDrawer}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}
