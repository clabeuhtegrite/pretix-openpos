import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { api, errorCode, isRefusal, isRetryable } from "../api";
import { countPayload, countTotal, emptyCount, moment, type CountState } from "../drawer";
import { describeError } from "../errors";
import { t, tn } from "../i18n";
import { formatMoney, fromCents, toCents } from "../money";
import { newNonce } from "../nonce";
import {
  clearPendingMovement, loadPendingMovement, loadQueue, savePendingMovement,
} from "../storage";
import type {
  DrawerAnswer, DrawerEntry, DrawerSession, DrawerState, Pairing, PendingMovement, QueuedSale,
} from "../types";
import CashCount from "./CashCount";

interface Props {
  pairing: Pairing;
  cashier: string;
  online: boolean;
  /**
   * Every state of the drawer this panel reads or writes, so the rest of the
   * till — the payment panel, the banner — knows whether cash can be taken.
   */
  onState: (state: DrawerState) => void;
  onClose: () => void;
}

type Step = "overview" | "opening" | "in" | "out" | "counting";

/**
 * Refusals that mean the drawer is not in the state this screen thought: the
 * other tablet opened it, counted it or closed it. The panel goes back to the
 * overview, which is read again and shows it as it is.
 */
const MOVED_ON = new Set(["drawer_open", "drawer_closed", "count_stale", "count_required", "no_drawer"]);

const noAmount: CountState = { mode: "amount", counts: {}, entry: "" };

/** A movement's amount as the keypad holds it. */
function amountOf(amount: string): CountState {
  return { mode: "amount", counts: {}, entry: String(toCents(amount)) };
}

/**
 * Cash sales this device rang up with no network, for the event on screen,
 * and what they come to.
 *
 * What the drawer should hold is the server's figure, made of the sales the
 * server has. A sale still waiting here is money already in the drawer that
 * the figure does not count yet — and a count made meanwhile comes out over
 * by exactly that much, which is how an honest drawer gets written up as a
 * discrepancy at the end of the night.
 */
function queuedCash(event: string): { n: number; cents: number } {
  const sales = loadQueue().filter(
    (entry): entry is QueuedSale =>
      entry.kind === "sale" && entry.event === event && entry.paymentType === "cash",
  );
  return { n: sales.length, cents: sales.reduce((sum, sale) => sum + toCents(sale.chargedTotal), 0) };
}

/** Said beside the expected amount and on the count, while any are waiting. */
function Queued({ event, currency }: { event: string; currency: string }) {
  const { n, cents } = queuedCash(event);
  if (n === 0) return null;
  return (
    <p className="drawer-warn">
      {tn("drawer.queued", n, { amount: formatMoney(cents, currency) })}
    </p>
  );
}

/** Counted, expected and the difference: a count, or the closing made on one. */
function Figures({
  counted, expected, difference, currency,
}: {
  counted: string;
  expected: string;
  difference: string;
  currency: string;
}) {
  const gap = toCents(difference);
  const amount = formatMoney(Math.abs(gap), currency);
  return (
    <>
      <div className="amount-display">
        <span>{t("drawer.counted")}</span>
        <span className="value">{formatMoney(toCents(counted), currency)}</span>
      </div>
      <div className="amount-display">
        <span>{t("drawer.expected")}</span>
        <span className="value">{formatMoney(toCents(expected), currency)}</span>
      </div>
      <div className={`amount-display drawer-gap${gap === 0 ? " is-right" : " is-off"}`}>
        <span>{t("drawer.difference")}</span>
        <span className="value">
          {gap > 0 ? "+" : ""}
          {formatMoney(gap, currency)}
        </span>
      </div>
      <p className={`drawer-verdict${gap === 0 ? " is-right" : " is-off"}`}>
        {gap === 0
          ? t("drawer.right")
          : gap > 0
            ? t("drawer.over", { amount })
            : t("drawer.short", { amount })}
      </p>
    </>
  );
}

/**
 * What the drawer should hold right now, and what that is made of: the float,
 * the cash taken, the cash handed back, the money put in and taken out. The
 * lines that are still zero stay off, except the sales, which is the one
 * everybody behind the bar looks for.
 */
function Holds({ session, currency }: { session: DrawerSession; currency: string }) {
  const lines: { label: string; cents: number; always?: boolean }[] = [
    { label: t("drawer.cashSales"), cents: toCents(session.cash_sales), always: true },
    { label: t("drawer.cashReturned"), cents: toCents(session.cash_returned) },
    { label: t("drawer.cashIn"), cents: toCents(session.cash_in) },
    { label: t("drawer.cashOut"), cents: -toCents(session.cash_out) },
  ];
  return (
    <div className="drawer-sum">
      <dl className="drawer-sum-lines">
        <div>
          <dt>{t("drawer.float")}</dt>
          <dd>{formatMoney(toCents(session.opening_float), currency)}</dd>
        </div>
        {lines
          .filter((line) => line.always || line.cents !== 0)
          .map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>
                {line.cents < 0 ? "−" : "+"}
                {formatMoney(Math.abs(line.cents), currency)}
              </dd>
            </div>
          ))}
      </dl>
      <div className="amount-display drawer-holds">
        <span>{t("drawer.holds")}</span>
        <span className="value">{formatMoney(toCents(session.expected), currency)}</span>
      </div>
    </div>
  );
}

/** Who did it and when, in one line. */
function stamp(
  entry: { datetime: string; cashier: string },
  withCashier: "drawer.countedBy" | "drawer.closedBy",
  alone: "drawer.countedAt" | "drawer.closedAt",
): string {
  const time = moment(entry.datetime);
  return entry.cashier ? t(withCashier, { time, cashier: entry.cashier }) : t(alone, { time });
}

function Movement({ entry, currency }: { entry: DrawerEntry; currency: string }) {
  const out = entry.kind === "out";
  return (
    <li className={`drawer-move${out ? " is-out" : ""}`}>
      <span className="drawer-move-time">{moment(entry.datetime)}</span>
      <span className="drawer-move-reason">
        {entry.reason}
        {entry.cashier && <small>{entry.cashier}</small>}
      </span>
      <span className="drawer-move-amount">
        {out ? "−" : "+"}
        {formatMoney(toCents(entry.amount), currency)}
      </span>
    </li>
  );
}

/**
 * The till's cash drawer: opened on a counted float, topped up or emptied
 * with a reason, counted, closed on that count.
 *
 * What the drawer should hold is on this screen all evening, worked out by
 * the server from the float and every euro moved since, so whoever stands at
 * the till knows what is supposed to be in it. The count at the end says
 * what is actually there, and the difference is something to explain on the
 * spot rather than discover at the treasurer's.
 *
 * Nothing here works offline, deliberately: an opening or a count is a fact
 * about the drawer at a moment, and one queued for later would be recorded
 * against whatever the other tablet did in the meantime.
 */
export default function DrawerPanel({ pairing, cashier, online, onState, onClose }: Props) {
  /**
   * The movement sent and never answered for, if there is one — see
   * PendingMovement. Read once, when the panel opens: it opens on that
   * movement, as it was, to be sent again under the same key.
   */
  const [pendingMove, setPendingMove] = useState<PendingMovement | null>(() =>
    loadPendingMovement(pairing.serial, pairing.event),
  );
  const [state, setState] = useState<DrawerState | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(() => pendingMove?.kind ?? "overview");
  const [count, setCount] = useState<CountState>(noAmount);
  const [move, setMove] = useState<CountState>(() =>
    pendingMove ? amountOf(pendingMove.amount) : noAmount,
  );
  const [reason, setReason] = useState(() => pendingMove?.reason ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** The drawer is being read, which is what "Réessayer" waits on. */
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A prop that changes identity on every render of the till must not reload
  // the drawer each time it does.
  const report = useRef(onState);
  report.current = onState;

  /**
   * The key a request is sent under, reused only for the same request.
   *
   * A retry after a network failure goes under the same key, so an opening
   * whose answer was lost is found rather than refused as "already open". A
   * request with different figures gets a key of its own: the server would
   * otherwise hand back the first one and quietly ignore the correction.
   * Movements are the exception, and keep theirs: see recordMove.
   */
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const keyFor = (signature: string) => {
    if (attempt.current?.signature !== signature) {
      attempt.current = { signature, key: newNonce() };
    }
    return attempt.current.key;
  };

  const read = useCallback(
    async (signal?: AbortSignal) => {
      setReading(true);
      try {
        const next = await api.drawer(pairing, signal);
        setState(next);
        setLoadFailed(null);
        report.current(next);
      } catch (e) {
        if (signal?.aborted) return;
        setLoadFailed(describeError(e));
      } finally {
        setReading(false);
      }
    },
    [pairing],
  );

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);

  /**
   * Send one request under `key`, and settle what the answer settles.
   *
   * `forget` drops the key once it has been answered for, and `final` says
   * which failures are an answer: by default anything but a lost request or
   * a server fault.
   */
  async function submit(
    key: string,
    send: (key: string) => Promise<DrawerAnswer>,
    then: (answer: DrawerAnswer) => void,
    forget: () => void,
    final: (error: unknown) => boolean = (e) => !isRetryable(e),
  ) {
    setBusy(true);
    setError(null);
    try {
      const answer = await send(key);
      forget();
      setState(answer);
      report.current(answer);
      then(answer);
    } catch (e) {
      setError(describeError(e));
      if (final(e)) {
        // Understood and refused: a new try is a new request.
        forget();
        if (MOVED_ON.has(errorCode(e) ?? "")) {
          setStep("overview");
          void read();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const forgetAttempt = () => {
    attempt.current = null;
  };

  const forgetMove = () => {
    clearPendingMovement();
    setPendingMove(null);
  };

  const drawer = state?.drawer ?? null;
  const session = state?.session ?? null;
  const currency = drawer?.currency ?? "";
  const counted = countTotal(count);
  const moved = countTotal(move);

  function begin(next: Step) {
    setError(null);
    if (next === "opening" || next === "counting") setCount(emptyCount(drawer?.denominations ?? []));
    if (next === "in" || next === "out") {
      // A movement of this kind sent and never answered for comes back as it
      // was, and goes again under its key.
      const kept = pendingMove?.kind === next ? pendingMove : null;
      setMove(kept ? amountOf(kept.amount) : noAmount);
      setReason(kept?.reason ?? "");
    }
    setStep(next);
  }

  function back() {
    setError(null);
    setStep("overview");
  }

  function openDrawer() {
    const payload = { ...countPayload(count), cashier };
    void submit(
      keyFor(`open:${JSON.stringify(payload)}`),
      (key) => api.drawerOpen(pairing, { idempotency_key: key, ...payload }),
      // The drawer is open and the till can take cash: that is what this
      // panel was opened for, whether from the top bar or in the middle of a
      // payment, and the banner going away is the confirmation.
      () => onClose(),
      forgetAttempt,
    );
  }

  function recordCount() {
    const payload = { ...countPayload(count), cashier };
    void submit(
      keyFor(`count:${JSON.stringify(payload)}`),
      (key) => api.drawerCount(pairing, { idempotency_key: key, ...payload }),
      () => {
        setNote("");
        setStep("overview");
      },
      forgetAttempt,
    );
  }

  /**
   * Money put in or taken out, under one key for as long as it is not answered for.
   *
   * Not the key-per-figures of the other requests. An opening, a count or a
   * closing sent twice is caught by the drawer's own state — it is already
   * open, the count is superseded — but a movement is not: the second one is
   * money leaving twice. So the key is written down with the movement before
   * it leaves, and stays with it through a closed panel, a reload and a
   * retouched reason, until the server has answered for it — with the entry,
   * or with a refusal. Sent again, a movement that did arrive is handed back
   * as the entry already made, and the list shows it as it was recorded. One
   * at a time: a movement the other way sent meanwhile takes its place.
   */
  function recordMove(kind: "in" | "out") {
    const payload = { kind, amount: fromCents(moved), reason: reason.trim(), cashier };
    const pending: PendingMovement = {
      serial: pairing.serial,
      event: pairing.event,
      kind,
      amount: payload.amount,
      reason: payload.reason,
      key: pendingMove?.kind === kind ? pendingMove.key : newNonce(),
      at: new Date().toISOString(),
    };
    savePendingMovement(pending);
    setPendingMove(pending);
    void submit(
      pending.key,
      (key) => api.drawerMovement(pairing, { idempotency_key: key, ...payload }),
      () => setStep("overview"),
      forgetMove,
      // Anything short of an answer about this movement — a lost request, a
      // fault, the device turned away, "not now" — leaves it unanswered for.
      isRefusal,
    );
  }

  function closeOnCount(seq: number) {
    const payload = { count_seq: seq, reason: note.trim(), cashier };
    void submit(
      keyFor(`close:${JSON.stringify(payload)}`),
      (key) => api.drawerClose(pairing, { idempotency_key: key, ...payload }),
      () => setNote(""),
      forgetAttempt,
    );
  }

  function closeUncounted() {
    if (!drawer || !window.confirm(t("drawer.closeUncountedConfirm", { name: drawer.name }))) return;
    const payload = { uncounted: true, cashier };
    void submit(
      keyFor(`close:${JSON.stringify(payload)}`),
      (key) => api.drawerClose(pairing, { idempotency_key: key, ...payload }),
      () => {},
      forgetAttempt,
    );
  }

  const offline = !online;
  const locked = busy || offline;
  const current = session?.count?.current ? session.count : null;
  const title = drawer ? t("drawer.title", { name: drawer.name }) : t("drawer.heading");

  let body: ReactNode;
  let footer: ReactNode;
  const leave = (
    <button className="btn ghost" style={{ flex: 1 }} onClick={onClose} disabled={busy}>
      {t("drawer.back")}
    </button>
  );
  const stepBack = (
    <button className="btn ghost" style={{ flex: 1 }} onClick={back} disabled={busy}>
      {t("drawer.back")}
    </button>
  );

  if (!state) {
    body = loadFailed ? (
      <>
        <div className="error-banner">{loadFailed}</div>
        <button
          className="btn"
          onClick={() => void read()}
          disabled={reading}
          aria-busy={reading || undefined}
        >
          {reading ? t("app.loading") : t("drawer.retry")}
        </button>
      </>
    ) : (
      <p className="drawer-status loading">{t("app.loading")}</p>
    );
    footer = <div className="pay-buttons">{leave}</div>;
  } else if (!drawer) {
    body = <p className="drawer-status">{t("drawer.none")}</p>;
    footer = <div className="pay-buttons">{leave}</div>;
  } else if (step === "opening" || step === "counting") {
    const opening = step === "opening";
    body = (
      <>
        <p className="drawer-status">{opening ? t("drawer.openHelp") : t("drawer.countHelp")}</p>
        {/* The count is about to be set against the expected amount, which
            is short of these: said before the notes are counted, not after
            a difference nobody can explain. */}
        {!opening && <Queued event={pairing.event} currency={currency} />}
        <CashCount
          value={count}
          onChange={setCount}
          currency={currency}
          denominations={drawer.denominations}
          disabled={busy}
          usualCents={opening && drawer.opening_float !== null ? toCents(drawer.opening_float) : null}
        />
      </>
    );
    footer = (
      <>
        <div className="amount-display">
          <span>{t("drawer.counted")}</span>
          <span className="value">{formatMoney(counted, currency)}</span>
        </div>
        <div className="pay-buttons">
          {stepBack}
          <button
            className={`btn ${opening ? "success" : "primary"}`}
            style={{ flex: 2 }}
            onClick={opening ? openDrawer : recordCount}
            disabled={locked}
            aria-busy={busy || undefined}
          >
            {busy
              ? t("drawer.working")
              : opening
                ? t("drawer.openWith", { amount: formatMoney(counted, currency) })
                : t("drawer.countRecord")}
          </button>
        </div>
      </>
    );
  } else if (step === "in" || step === "out") {
    const into = step === "in";
    body = (
      <>
        <p className="drawer-status">{into ? t("drawer.inHelp") : t("drawer.outHelp")}</p>
        {pendingMove?.kind === step && !busy && (
          <p className="drawer-warn">{t("drawer.moveUnanswered")}</p>
        )}
        <div className="field">
          <label htmlFor="drawer-reason">{t("drawer.reason")}</label>
          <input
            id="drawer-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={into ? t("drawer.inPlaceholder") : t("drawer.outPlaceholder")}
            maxLength={190}
            autoComplete="off"
            disabled={busy}
          />
        </div>
        <CashCount value={move} onChange={setMove} currency={currency} denominations={[]} disabled={busy} />
      </>
    );
    footer = (
      <>
        <div className="amount-display">
          <span>{t("drawer.amount")}</span>
          <span className="value">{formatMoney(moved, currency)}</span>
        </div>
        <div className="pay-buttons">
          {stepBack}
          <button
            className="btn primary"
            style={{ flex: 2 }}
            onClick={() => recordMove(step)}
            disabled={locked || moved === 0 || !reason.trim()}
            aria-busy={busy || undefined}
          >
            {busy
              ? t("drawer.working")
              : t(into ? "drawer.putIn" : "drawer.takeOut", { amount: formatMoney(moved, currency) })}
          </button>
        </div>
      </>
    );
  } else if (!session) {
    const last = state.last_closed;
    body = (
      <>
        <p className="drawer-status">{t("drawer.isClosed")}</p>
        {last && (
          <div className="drawer-result">
            <div className="drawer-result-head">
              {stamp(
                { datetime: last.closed_at, cashier: last.cashier },
                "drawer.closedBy",
                "drawer.closedAt",
              )}
            </div>
            {last.amount === null || last.difference === null ? (
              <p className="drawer-verdict">{t("drawer.closedUncounted")}</p>
            ) : (
              <Figures
                counted={last.amount}
                expected={last.expected}
                difference={last.difference}
                currency={currency}
              />
            )}
          </div>
        )}
      </>
    );
    footer = (
      <div className="pay-buttons">
        {leave}
        <button
          className="btn primary"
          style={{ flex: 2 }}
          onClick={() => begin("opening")}
          disabled={locked}
        >
          {t("drawer.openAction")}
        </button>
      </div>
    );
  } else {
    const since = moment(session.opened_at);
    const countBlock = session.count ? (
      current ? (
        <div className="drawer-result">
          <div className="drawer-result-head">{stamp(current, "drawer.countedBy", "drawer.countedAt")}</div>
          <Figures
            counted={current.amount ?? "0.00"}
            expected={current.expected}
            difference={current.difference}
            currency={currency}
          />
          <div className="field">
            <label htmlFor="drawer-note">{t("drawer.note")}</label>
            <input
              id="drawer-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("drawer.notePlaceholder")}
              maxLength={190}
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <button className="btn ghost" onClick={() => begin("counting")} disabled={locked}>
            {t("drawer.recount")}
          </button>
        </div>
      ) : (
        <p className="drawer-note">
          {t("drawer.countMoved", {
            time: moment(session.count.datetime),
            amount: formatMoney(toCents(session.count.amount), currency),
          })}
        </p>
      )
    ) : null;

    if (session.stale) {
      body = (
        <>
          <div className="drawer-warn">
            <strong>{t("drawer.staleSince", { time: since })}</strong> {t("drawer.staleHelp")}
          </div>
          <Holds session={session} currency={currency} />
          <Queued event={pairing.event} currency={currency} />
          {countBlock}
        </>
      );
    } else {
      body = (
        <>
          <p className="drawer-status">
            {session.opened_by
              ? t("drawer.openedBy", { time: since, cashier: session.opened_by })
              : t("drawer.openedAt", { time: since })}
          </p>
          <Holds session={session} currency={currency} />
          <Queued event={pairing.event} currency={currency} />
          {countBlock}
          <h3 className="drawer-subtitle">{t("drawer.movements")}</h3>
          {session.movements.length ? (
            <ul className="drawer-moves">
              {session.movements.map((entry) => (
                <Movement key={entry.seq} entry={entry} currency={currency} />
              ))}
            </ul>
          ) : (
            <p className="drawer-note">{t("drawer.noMovements")}</p>
          )}
          <div className="drawer-row">
            <button className="btn" onClick={() => begin("in")} disabled={locked}>
              {t("drawer.in")}
            </button>
            <button className="btn" onClick={() => begin("out")} disabled={locked}>
              {t("drawer.out")}
            </button>
          </div>
        </>
      );
    }

    footer = (
      <div className="pay-buttons">
        {leave}
        {current ? (
          <button
            className="btn success"
            style={{ flex: 2 }}
            onClick={() => closeOnCount(current.seq)}
            disabled={locked}
            aria-busy={busy || undefined}
          >
            {busy ? t("drawer.working") : t("drawer.closeAction")}
          </button>
        ) : session.stale ? (
          <button
            className="btn danger"
            style={{ flex: 2 }}
            onClick={closeUncounted}
            disabled={locked}
            aria-busy={busy || undefined}
          >
            {busy ? t("drawer.working") : t("drawer.closeUncounted")}
          </button>
        ) : (
          <button
            className="btn primary"
            style={{ flex: 2 }}
            onClick={() => begin("counting")}
            disabled={locked}
          >
            {t("drawer.countAction")}
          </button>
        )}
      </div>
    );
  }

  const counting = step === "opening" || step === "counting";
  return (
    <div className="overlay overlay-top">
      <div className={`panel pay-panel drawer-panel${counting ? " is-counting" : ""}`}>
        <h2>{title}</h2>
        {offline && <div className="drawer-offline">{t("drawer.offline")}</div>}
        {error && <div className="error-banner">{error}</div>}
        <div className="pay-body">{body}</div>
        <div className="pay-actions">{footer}</div>
      </div>
    </div>
  );
}
