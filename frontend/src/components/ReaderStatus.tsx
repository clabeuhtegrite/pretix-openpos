import { Fragment, useEffect, useState } from "react";

import { api } from "../api";
import { moment } from "../drawer";
import { t } from "../i18n";
import type { Pairing, ReaderAnswer, ReaderState } from "../types";

/**
 * SumUp's names for the networks a reader can be on, as people say them.
 *
 * `lte` is the one worth reading: a Solo on its own SIM rather than on the
 * venue's Wi-Fi says so here as "4G". A name SumUp adds one day is shown as it
 * comes rather than dropped.
 */
const NETWORKS: Record<string, string> = {
  "Wi-Fi": "Wi-Fi",
  lte: "4G",
  umts: "3G",
  edge: "2G",
  gprs: "2G",
  btle: "Bluetooth",
  usb: "USB",
};

/** What SumUp says while a cardholder is in front of the reader. */
const BUSY = new Set(["SELECTING_TIP", "WAITING_FOR_CARD", "WAITING_FOR_PIN", "WAITING_FOR_SIGNATURE"]);

/**
 * Below this many percent, the reader is told to go back on its stand.
 *
 * Driven through the Cloud API, a Solo keeps its connection up all evening,
 * and Goodtill, the till software SumUp owns, warns that the battery goes
 * faster for it.
 */
export const LOW_BATTERY = 20;

type Verdict = "ready" | "busy" | "updating" | "offline";

const VERDICTS: Record<Verdict, "reader.ready" | "reader.busy" | "reader.updating" | "reader.offline"> = {
  ready: "reader.ready",
  busy: "reader.busy",
  updating: "reader.updating",
  offline: "reader.offline",
};

/** Offline first: whatever else it says, a reader SumUp cannot reach takes no card. */
function verdictOf(reader: ReaderState): Verdict {
  if (reader.status !== "ONLINE") return "offline";
  if (reader.state === "UPDATING_FIRMWARE") return "updating";
  if (BUSY.has(reader.state)) return "busy";
  return "ready";
}

function Details({ reader, verdict }: { reader: ReaderState; verdict: Verdict }) {
  const low = reader.battery !== null && reader.battery < LOW_BATTERY;
  const network = reader.connection ? (NETWORKS[reader.connection] ?? reader.connection) : null;
  const figures = [
    reader.battery !== null && (
      <span className={low ? "is-low" : undefined}>
        {t(low ? "reader.batteryLow" : "reader.battery", { n: reader.battery })}
      </span>
    ),
    network && <span>{network}</span>,
    reader.firmware && <span>{t("reader.firmware", { version: reader.firmware })}</span>,
  ].filter(Boolean);
  return (
    <>
      {verdict === "offline" && (
        <div className="reader-help">
          {t("reader.offlineHelp")}
          {reader.last_activity && (
            <> {t("reader.lastSeen", { time: moment(reader.last_activity) })}</>
          )}
        </div>
      )}
      {verdict === "updating" && <div className="reader-help">{t("reader.updatingHelp")}</div>}
      {verdict === "busy" && <div className="reader-help">{t("reader.busyHelp")}</div>}
      {/* Each figure kept whole, and the line free to wrap between them: on
          a phone it does, and "Firmware" at the end of one line with its
          number on the next reads as two things. */}
      <div className="reader-meta">
        {figures.map((figure, index) => (
          <Fragment key={index}>
            {index > 0 && " · "}
            {figure}
          </Fragment>
        ))}
      </div>
    </>
  );
}

/**
 * How the till's own card reader is, in its settings: on or off, charged or
 * not, on which network, busy or updating itself.
 *
 * The answer the back office's card readers page gives for every reader, for
 * the one this till drives, where somebody holding the till wants it. Asked
 * when the settings open and again when somebody presses for it, never on a
 * timer: the server asks SumUp each time, and SumUp is not to be leaned on to
 * keep a panel fresh that nobody may be looking at.
 *
 * A reader SumUp says nothing about is "unknown", never "offline": a Solo on
 * older firmware takes payments perfectly well and cannot be asked, and
 * sending a volunteer off to look for a machine that is working is the worse
 * of the two mistakes.
 */
export default function ReaderStatus({ pairing }: { pairing: Pairing }) {
  const [answer, setAnswer] = useState<ReaderAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setAsking(true);
    setFailed(false);
    api
      .terminalReader(pairing, controller.signal)
      .then((data) => {
        if (!cancelled) setAnswer(data);
      })
      .catch(() => {
        if (cancelled) return;
        // Not left showing the last answer under a failure: "ready" from a
        // minute ago, beside "the server could not be asked", reads as ready.
        setAnswer(null);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setAsking(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [pairing, attempt]);

  const reader = answer?.reader ?? null;
  const verdict = reader ? verdictOf(reader) : null;

  return (
    <section className="reader-status" aria-labelledby="reader-status-title">
      <div className="reader-status-head">
        <h3 id="reader-status-title">{t("reader.title")}</h3>
        <button
          type="button"
          className="btn ghost"
          onClick={() => setAttempt((n) => n + 1)}
          disabled={asking}
          aria-busy={asking || undefined}
        >
          {asking ? t("reader.asking") : t("reader.refresh")}
        </button>
      </div>

      {!answer && !failed && <p className="loading">{t("app.loading")}</p>}
      {failed && <div className="reader-help">{t("reader.failed")}</div>}

      {answer && !reader && (
        <>
          <div className="reader-verdict is-unknown">{t("reader.unknown")}</div>
          <div className="reader-help">
            {answer.reason === "not_configured" ? t("reader.notConfigured") : t("reader.noAnswer")}
          </div>
        </>
      )}

      {reader && verdict && (
        <>
          <div className={`reader-verdict is-${verdict}`} role="status">
            {t(VERDICTS[verdict])}
          </div>
          <Details reader={reader} verdict={verdict} />
        </>
      )}
    </section>
  );
}
