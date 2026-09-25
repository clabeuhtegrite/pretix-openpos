import { useEffect, useState } from "react";

import { locale, t } from "../i18n";
import { loadFailures, loadQueue, saveFailures } from "../storage";
import { sendable } from "../sync";
import type { QueueEntry, SyncHalt, SyncReport } from "../types";

/**
 * What the till is still holding, and what happened when it last let go.
 *
 * The whole reason offline mode is safe to use is that nothing about it is
 * implicit: how many sales are waiting, what the server made of them, and above
 * all what it refused. A queue that drains silently and a queue that loses a
 * sale look identical from behind the counter — so this screen exists to make
 * them look different.
 */

interface Props {
  online: boolean;
  syncing: boolean;
  report: SyncReport | null;
  /** The event this till is selling for; the queue may hold entries for others. */
  event: string;
  onSync: () => void;
  onClose: () => void;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Why the last run stopped short, when that is something to read.
 *
 * Every one of these left the whole queue where it was, and each says so:
 * what used to happen instead was the queue emptying itself into the refused
 * list one sale at a time. A run that stopped for want of a network says
 * nothing more here — the line at the top already does.
 */
function Halt({ halt }: { halt: SyncHalt }) {
  if (halt.kind === "unreachable") return null;
  if (halt.kind === "device") {
    // The one that needs somebody: a revoked till sends nothing until it is
    // paired again, and pairing it again is what sends everything.
    return <div className="error-banner">{t("offline.haltedDevice", { detail: halt.message })}</div>;
  }
  if (halt.kind === "wait" && halt.retryAt !== null) {
    return (
      <div className="attendance-note">
        {t("offline.haltedWait", {
          // To the second: the server asks for seconds, not minutes.
          time: new Date(halt.retryAt).toLocaleTimeString(locale, {
            hour: "2-digit", minute: "2-digit", second: "2-digit",
          }),
        })}
      </div>
    );
  }
  return <div className="history-warn">{t("offline.haltedOther", { detail: halt.message })}</div>;
}

function kind(entry: QueueEntry): string {
  if (entry.kind === "sale") return t("offline.aSale");
  // A refusal waits here too: pretix writes down every scan it refuses, and
  // one refused offline goes to it like any other scan.
  return entry.refused ? t("offline.aRefusal") : t("offline.aCheckin");
}

/** One queued entry, whichever list it is in. */
function queued(entry: QueueEntry) {
  return (
    <div key={entry.id} className="history-row is-cancellation">
      <span className="history-row-main">
        <span className="history-row-order">
          {time(entry.at)} · {kind(entry)}
        </span>
        <span className="history-row-meta">
          {entry.kind === "sale" ? entry.label : entry.name || entry.secret.slice(0, 8)}
        </span>
      </span>
      <span className="history-row-total">
        {entry.kind === "sale" ? entry.chargedTotal : entry.refused ? "✕" : "→"}
      </span>
    </div>
  );
}

export default function SyncPanel({ online, syncing, report, event, onSync, onClose }: Props) {
  const [queue, setQueue] = useState(() => loadQueue());
  const [failures, setFailures] = useState(() => loadFailures());

  // Re-read whenever a drain starts or finishes. Read once, this panel went on
  // listing sales that had just been sent from the button right below it —
  // which is the exact thing it exists to make visible.
  useEffect(() => {
    setQueue(loadQueue());
    setFailures(loadFailures());
  }, [syncing, report]);

  // What the next drain will send, and what it will leave for later: sales of
  // another event, which only that event's checkout can take.
  const mine = queue.filter((entry) => sendable(entry, event));
  const elsewhere = queue.filter((entry) => !sendable(entry, event));
  const sales = mine.filter((entry) => entry.kind === "sale");
  const checkins = mine.filter((entry) => entry.kind === "checkin");
  const otherEvents = [...new Set(elsewhere.map((entry) => entry.event))].join(", ");

  return (
    <div className="overlay overlay-top" onClick={onClose}>
      <div className="panel history-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("offline.title")}</h2>

        <div className={`sync-state${online ? " is-online" : ""}`}>
          {online ? t("offline.online") : t("offline.offline")}
        </div>

        {mine.length === 0 ? (
          <div className="attendance-note">{t("offline.nothingPending")}</div>
        ) : (
          <>
            <div className="attendance-note">
              {t("offline.pending", { sales: sales.length, checkins: checkins.length })}
            </div>
            <div className="history-list">{mine.map(queued)}</div>
          </>
        )}

        {elsewhere.length > 0 && (
          // Neither pending nor refused: they belong to an event this till is no
          // longer on. Said plainly, because the badge in the topbar counts them
          // and "send now" will not shift them however often it is pressed.
          <>
            <div className="attendance-note">
              {t("offline.stranded", { n: elsewhere.length, events: otherEvents })}
            </div>
            <div className="history-list">{elsewhere.map(queued)}</div>
          </>
        )}

        {report && (
          <div className="sync-report">
            <div className="attendance-note">
              {t("offline.lastRun", {
                sales: report.sales,
                checkins: report.checkins,
                failed: report.failed,
              })}
            </div>
            {report.checkins > 0 && (
              // Where to look for them afterwards, and how to tell them apart.
              <div className="attendance-note">{t("offline.marked")}</div>
            )}
            {report.halted && <Halt halt={report.halted} />}
            {report.offTariff.map((line, i) => (
              // A price moved while this till could not be told: the customer
              // paid one figure, the tariff says another. Nobody can put that
              // right from here, but pretending it did not happen is worse.
              <div className="history-warn" key={`t${i}`}>
                {t("offline.offTariff", {
                  order: line.order,
                  item: line.item_name,
                  charged: line.charged,
                  tariff: line.tariff,
                })}
              </div>
            ))}
            {report.contested.map((line, i) => (
              <div className="history-warn" key={`c${i}`}>
                {t("offline.contested", { name: line.name, reason: line.reason })}
              </div>
            ))}
          </div>
        )}

        {failures.length > 0 && (
          <>
            <h3 className="attendance-subtitle">{t("offline.refused")}</h3>
            {failures.map((failure, i) => (
              <div className="error-banner" key={i}>
                {time(failure.entry.at)} ·{" "}
                {failure.entry.kind === "sale"
                  ? `${failure.entry.label} (${failure.entry.chargedTotal})`
                  : failure.entry.secret.slice(0, 8)}
                <br />
                {failure.message}
              </div>
            ))}
            <button
              className="btn ghost"
              onClick={() => {
                // Cleared by hand, on purpose: this is the one list that must
                // not disappear because an app was restarted.
                saveFailures([]);
                setFailures([]);
              }}
            >
              {t("offline.dismissRefused")}
            </button>
          </>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
          <button
            className="btn primary"
            disabled={!online || syncing || mine.length === 0}
            aria-busy={syncing || undefined}
            onClick={onSync}
          >
            {syncing ? t("offline.syncing") : t("offline.sync")}
          </button>
          <button className="btn ghost" onClick={onClose}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
