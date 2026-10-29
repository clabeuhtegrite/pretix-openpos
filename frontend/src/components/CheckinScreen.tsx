import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api";
import { useConnectivity } from "../connectivity";
import { addScans, doorCount, NO_SCANS, subtractScans, waitingScans } from "../doorCount";
import { describeError, unanswered } from "../errors";
import { t, type MessageKey } from "../i18n";
import { newNonce } from "../nonce";
import { play } from "../sound";
import { loadDoorScans, loadQueue, saveDoorScans } from "../storage";
import type {
  Attendance, CheckinListInfo, DoorScans, Pairing, QueueEntry, RedeemResult, ScanFigures,
} from "../types";
import { useBackClose } from "../useBackClose";
import AttendancePanel from "./AttendancePanel";
import AttendeeSearch from "./AttendeeSearch";
import QrScanner from "./QrScanner";

/**
 * How long a verdict stays up before scanning resumes.
 *
 * Long enough to read the name on it and hand the ticket back without being
 * rushed. A tap on the verdict cuts it short, so a fast queue is never held up
 * by the delay — it only protects the operator who is not looking yet.
 */
const HOLD_OK_MS = 4000;
const HOLD_ERROR_MS = 8000;
/**
 * Ignore the same code for this long, so one ticket in frame is not read ten times.
 *
 * Deliberately longer than the verdict it outlives: a ticket left in front of
 * the lens is decoded again the instant scanning resumes, and re-submitting it
 * would answer a valid entry with a red "already scanned".
 */
const REPEAT_GUARD_MS = 6000;
/**
 * How often the head count is re-read while this screen is open.
 *
 * The other doors and the tills are checking people in too, so the figure goes
 * stale on its own even when nothing is scanned here.
 */
const ATTENDANCE_REFRESH_MS = 60_000;
/**
 * Delay before re-reading it after a scan answered online.
 *
 * Long enough for a burst of tickets to collapse into one request, short enough
 * that the count has moved by the time the operator looks up from the verdict.
 */
const ATTENDANCE_SETTLE_MS = 1200;
/**
 * How long a scan may wait for pretix before the door says it has no answer.
 *
 * A sale can afford the thirty seconds every write gets; a door cannot. With
 * the queue outside, nobody holds a ticket in front of the camera for half a
 * minute of "Checking…": the volunteer waves the person in, and when the
 * request finally failed the scan had left no trace anywhere. Past this the
 * door says, in red, that the ticket was not checked, so that it is scanned
 * again rather than waved through. pretix answers a scan in well under a
 * second; this is several times that.
 */
const LIVE_SCAN_TIMEOUT_MS = 8_000;

/**
 * Buzz on a refusal.
 *
 * At a loud door, looking up at the right moment is not a given. Android
 * vibrates; iOS has no web vibration at all and simply does not, which is why
 * the sound in sound.ts carries this on every iPhone and the red screen stays
 * the actual answer either way.
 */
function buzz(): void {
  try {
    navigator.vibrate?.([120, 60, 120]);
  } catch {
    // Refused without a prior gesture on some browsers. Nothing to do about it.
  }
}

/**
 * Whether a scan let a person in, or merely recorded something.
 *
 * A check-in list set to "all products" accepts a T-shirt and pretix dutifully
 * records the scan — but a merch line has no door, and answering it with the
 * same green "let them in" as a ticket is how a door loses track of its own
 * numbers. An unknown product counts as admission on purpose: telling somebody
 * holding a valid ticket that it admits nobody is the failure that matters, and
 * it must not happen because a product was created after the app loaded.
 */
function admits(result: RedeemResult, admissionItems: number[]): boolean {
  const item = result.position?.item;
  return item == null || admissionItems.includes(item);
}

function reasonLabel(result: RedeemResult): string {
  if (result.status === "incomplete") return t("reason.incomplete");
  const key = `reason.${result.reason ?? "unknown"}` as MessageKey;
  const label = t(key);
  // t() echoes the key back when it is unknown; fall back to a generic refusal
  // rather than showing "reason.something_new" to an operator at the door.
  return label === key ? t("reason.unknown") : label;
}

interface Props {
  pairing: Pairing;
  lists: CheckinListInfo[];
  defaultListId: number | null;
  /** Ids of the products that admit a person; everything else is merchandise. */
  admissionItems: number[];
  /** Told when the operator switches lists, so the door reopens on it. */
  onListChange?: (listId: number) => void;
  /**
   * How a door sells a ticket to somebody who turns up without one.
   *
   * Given only on a device whose role is the door, where this screen is the
   * home screen and the product grid is the place you step out to. A till has
   * no use for it: there the grid is already what is underneath.
   */
  onSell?: () => void;
  /**
   * How many entries the offline queue holds, as the app last counted them.
   *
   * Read for when it goes down: a drain has just handed scans to pretix —
   * scans an earlier build kept on this device, since none is queued any
   * more — and the counter re-reads the server's figure rather than leave
   * them out of it until the next minute.
   */
  pending?: number;
  /**
   * Told whether the door is in the middle of something: a scan being
   * answered, a verdict on screen, a search or the head count open, an error
   * to read. The app waits for none of that before it applies an update, so a
   * reload never lands on a verdict somebody is reading.
   */
  onBusyChange?: (busy: boolean) => void;
  /** A strip over the picture, under the title — the new-version bar. */
  notice?: React.ReactNode;
  onClose: () => void;
}

export default function CheckinScreen({
  pairing, lists, defaultListId, admissionItems, onListChange, onSell, pending = 0, onBusyChange,
  notice, onClose,
}: Props) {
  const [listId, setListId] = useState<number | null>(
    defaultListId ?? (lists.length ? lists[0].id : null),
  );
  // The lists arrive with the config, which is now read again while this
  // screen is up. One deleted in pretix meanwhile must not stay selected:
  // every scan would go to a list that no longer exists. Back to the one the
  // app would open on now, which it has already checked is still there.
  const listGone = listId !== null && !lists.some((list) => list.id === listId);
  useEffect(() => {
    if (!listGone) return;
    setListId(
      defaultListId !== null && lists.some((list) => list.id === defaultListId)
        ? defaultListId
        : lists[0]?.id ?? null,
    );
  }, [listGone, defaultListId, lists]);
  const [verdict, setVerdict] = useState<RedeemResult | null>(null);
  /**
   * A scan pretix did not answer, put where its verdict would be, with what
   * went wrong in describeError's words.
   *
   * The door never answers a ticket by itself. Up to 0.29 it did, from a copy
   * of the guest list it carried, and queued the scan for pretix; scans went
   * missing that way, and since 0.30 every verdict is pretix' own. When pretix
   * says nothing — the network died under the scan, pretix is restarting, a
   * proxy stopped waiting (408), the device was asked to slow down (429): see
   * unanswered in errors.ts — the door says that instead, as plainly as it
   * says no, and the ticket is scanned again.
   */
  const [noAnswer, setNoAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  /**
   * Tonight's scans as the server last counted them — or, until it answers,
   * as it counted them before this page was last loaded.
   */
  const [doorScans, setDoorScans] = useState<DoorScans | null>(() =>
    loadDoorScans(pairing.event),
  );
  /**
   * Every scan pretix answered on this screen, and how many of them the figure
   * on screen already counts.
   *
   * A refresh counts the scans answered before it was sent; the ones answered
   * since are added on top until the next one. Kept as a running total and a
   * mark rather than a count that goes up and down, so that two refreshes in
   * flight at once — a scan's, and the minute's — cannot take the same scans
   * off twice. `live` is the difference, for rendering.
   */
  const liveTotalRef = useRef<ScanFigures>(NO_SCANS);
  const countedRef = useRef<{ run: number; scans: ScanFigures }>({ run: 0, scans: NO_SCANS });
  const [live, setLive] = useState<ScanFigures>(NO_SCANS);
  /**
   * The queue as it stood when the server's figure came in: what the figure
   * does not count yet. See doorCount for why it is not simply the queue as it
   * stands. Only ever scans an earlier build kept; this one queues none.
   */
  const [queueSeen, setQueueSeen] = useState<QueueEntry[]>(loadQueue);
  const [searchOpen, setSearchOpen] = useState(false);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);

  // Said under the picture, so the door knows before the next ticket that a
  // scan cannot be checked; every scan is still sent, since the server is the
  // only judge of whether it can be reached.
  const online = useConnectivity();

  // Refs, not state: these gate the decode callback and must not re-render it.
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);
  /**
   * The nonce of each scan pretix left unanswered, by list and code.
   *
   * The request may have reached pretix and only the answer been lost on the
   * way back. Scanned again under a fresh nonce, that ticket would come back
   * "already scanned", in red, for somebody pretix has just let in. Sent again
   * under the same one, pretix recognises the scan it already holds and says
   * yes. Dropped as soon as pretix has given the ticket a verdict.
   */
  const unansweredRef = useRef(new Map<string, string>());
  const busyRef = useRef(false);
  const holdRef = useRef<number | undefined>(undefined);
  const settleRef = useRef<number | undefined>(undefined);
  // Bumped on every request, so a slow answer for the list we just left — or
  // for a count that has since been refreshed — cannot land on the screen.
  const attendanceRunRef = useRef(0);

  useEffect(
    () => () => {
      window.clearTimeout(holdRef.current);
      window.clearTimeout(settleRef.current);
    },
    [],
  );

  const loadAttendance = useCallback(async () => {
    if (!listId) return;
    const run = ++attendanceRunRef.current;
    const asked = liveTotalRef.current;
    setAttendanceBusy(true);
    try {
      const data = await api.attendance(pairing, listId);
      // Taken from any answer newer than the one on screen, even one a later
      // request has overtaken for the list: the scans are the event's.
      if (data.scans && run > countedRef.current.run) {
        countedRef.current = { run, scans: asked };
        setLive(subtractScans(liveTotalRef.current, asked));
        setDoorScans(data.scans);
        setQueueSeen(loadQueue());
        saveDoorScans(pairing.event, data.scans);
      }
      if (attendanceRunRef.current !== run) return;
      setAttendance(data);
      setAttendanceError(null);
    } catch (e) {
      if (attendanceRunRef.current !== run) return;
      // The count is informational: a failure leaves the last known figure on
      // the button rather than taking the operator out of scanning.
      setAttendanceError(describeError(e));
    } finally {
      if (attendanceRunRef.current === run) setAttendanceBusy(false);
    }
  }, [listId, pairing]);

  useEffect(() => {
    if (!listId) return;
    // A figure counted on another list would be worse than no figure at all.
    setAttendance(null);
    void loadAttendance();
    const timer = window.setInterval(() => void loadAttendance(), ATTENDANCE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [listId, loadAttendance]);

  // The queue went down: a drain has just handed scans to pretix, and the
  // figure is read again rather than a minute later. Not on the network
  // merely coming back: that is also what a failed request followed by one
  // that got through looks like, and on a network that drops writes but not
  // reads it alternates as fast as the requests go. The minute's refresh
  // catches up the other doors' figure either way.
  const pendingRef = useRef(pending);
  useEffect(() => {
    if (pending < pendingRef.current) void loadAttendance();
    pendingRef.current = pending;
  }, [pending, loadAttendance]);

  const count = useMemo(
    () => doorCount(doorScans, live, queueSeen, pairing.event),
    [doorScans, live, queueSeen, pairing.event],
  );
  const waiting = useMemo(
    () => waitingScans(loadQueue(), pairing.event),
    // Both stand for the queue, which lives in storage: what this screen
    // queued, and what the app last counted after a drain.
    [queueSeen, pending, pairing.event],
  );

  useBackClose(searchOpen, () => setSearchOpen(false));
  useBackClose(attendanceOpen, () => setAttendanceOpen(false));

  const resume = useCallback(() => {
    window.clearTimeout(holdRef.current);
    setVerdict(null);
    setNoAnswer(null);
  }, []);

  const submit = useCallback(
    async (secret: string) => {
      if (busyRef.current || !listId) return;
      const code = secret.trim();
      if (!code) return;

      const previous = lastCodeRef.current;
      if (previous && previous.code === code && Date.now() - previous.at < REPEAT_GUARD_MS) {
        // Sliding window: every frame the ticket is still in view pushes the
        // guard back, so it expires once the ticket is out of frame rather than
        // a fixed time after the first read.
        previous.at = Date.now();
        return;
      }
      lastCodeRef.current = { code, at: Date.now() };

      busyRef.current = true;
      setBusy(true);
      setFatal(null);
      setNoAnswer(null);
      const attempt = `${listId}:${code}`;
      try {
        const nonce = unansweredRef.current.get(attempt) ?? newNonce();
        let result: RedeemResult;
        try {
          result = await api.redeem(pairing, {
            secret: code,
            lists: [listId],
            nonce,
            timeoutMs: LIVE_SCAN_TIMEOUT_MS,
          });
        } catch (e) {
          // "Not now" rather than "no": nothing says whether pretix took the
          // scan, so nothing is shown as if it had. Red, like a refusal, with
          // the refusal's sound, because a door reads anything but green as
          // "stop" — and the same ticket can be scanned again at once, under
          // the same nonce.
          if (!unanswered(e)) throw e;
          unansweredRef.current.set(attempt, nonce);
          lastCodeRef.current = null;
          setNoAnswer(describeError(e));
          play("refused");
          buzz();
          window.clearTimeout(holdRef.current);
          holdRef.current = window.setTimeout(() => setNoAnswer(null), HOLD_ERROR_MS);
          return;
        }
        unansweredRef.current.delete(attempt);
        liveTotalRef.current = addScans(
          liveTotalRef.current,
          result.status !== "ok"
            ? { ...NO_SCANS, refused: 1 }
            : admits(result, admissionItems)
              ? { ...NO_SCANS, admitted: 1 }
              : { ...NO_SCANS, other: 1 },
        );
        setLive(subtractScans(liveTotalRef.current, countedRef.current.scans));
        setVerdict(result);
        // Heard, not felt: the door is all iPhones and none of them vibrate.
        // A scan that went through says so too, quietly, because silence on a
        // scan reads as "did it even read it?" and gets the ticket presented
        // twice.
        if (result.status === "ok") {
          play("ok");
          // The room may just have changed. Still asked of the server rather
          // than added up here: the figure counts every door and every till,
          // and one kept locally would drift from the first scan made
          // elsewhere. A refusal moves nothing but the counter below, which
          // counts it already.
          window.clearTimeout(settleRef.current);
          settleRef.current = window.setTimeout(() => void loadAttendance(), ATTENDANCE_SETTLE_MS);
        } else {
          play("refused");
          buzz();
        }
        window.clearTimeout(holdRef.current);
        holdRef.current = window.setTimeout(
          () => setVerdict(null),
          result.status === "ok" ? HOLD_OK_MS : HOLD_ERROR_MS,
        );
      } catch (e) {
        // The device refused by the server: let the operator retry the same
        // ticket.
        lastCodeRef.current = null;
        setFatal(describeError(e));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [listId, pairing, loadAttendance, admissionItems],
  );

  // What the app waits on before an update: see onBusyChange. Said false on
  // the way out too, so a door closed mid-verdict does not hold it for ever.
  const occupied =
    busy || verdict !== null || noAnswer !== null || searchOpen || attendanceOpen || fatal !== null;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  useEffect(() => {
    onBusyChangeRef.current?.(occupied);
  }, [occupied]);
  useEffect(() => () => onBusyChangeRef.current?.(false), []);

  if (!lists.length) {
    return (
      <div className="overlay">
        <div className="panel">
          <h2>{t("checkin.title")}</h2>
          <div className="error-banner">{t("checkin.noList")}</div>
          <button className="btn primary" onClick={onClose}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    );
  }

  const admitted = verdict !== null && verdict.status === "ok" && admits(verdict, admissionItems);
  const tone =
    verdict?.status !== "ok"
      ? "ko"
      : !admitted
        ? "info"
        : verdict.require_attention
          ? "warn"
          : "ok";

  return (
    <QrScanner
      title={t("checkin.title")}
      hint={t("checkin.hint")}
      paused={busy || verdict !== null || noAnswer !== null || searchOpen || attendanceOpen}
      onDecode={submit}
      onClose={onClose}
      // Tickets carry a QR code and nothing a human could retype, so there is no
      // manual entry to fall back on here — unlike pairing, where pretix prints
      // the code as text next to the QR. What there is, is the name search at
      // the bottom of this very screen; the hint used to say "there is nothing
      // to type" right above it.
      errorHint={t("scan.findByName", { search: t("search.open") })}
      banner={notice}
      footer={
        <div className="scanner-footer">
          {lists.length > 1 && (
            <select
              className="scanner-select"
              value={listId ?? ""}
              onChange={(e) => {
                const next = Number(e.target.value);
                setListId(next);
                onListChange?.(next);
              }}
              aria-label={t("checkin.list")}
            >
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          )}
          <div className="scanner-actions">
            {onSell && (
              // First on purpose: it is the one thing on this screen that takes
              // money, and the queue it serves is somebody standing at the door
              // without a ticket. On a row of its own above the other two, for
              // the reason given beside .sell-button in styles.css.
              <button className="btn sell-button" onClick={onSell}>
                🛒 {t("checkin.sell")}
              </button>
            )}
            <button className="btn" onClick={() => setSearchOpen(true)} disabled={!listId}>
              🔍 {t("search.open")}
            </button>
            <button
              className="btn attendance-button"
              onClick={() => {
                setAttendanceOpen(true);
                void loadAttendance();
              }}
              disabled={!listId}
              // Only the figure fits in a quarter of the row; the button still
              // has to announce itself to anyone not reading the screen.
              aria-label={
                attendance
                  ? t("attendance.button", { n: attendance.inside })
                  : t("attendance.title")
              }
            >
              👥 {attendance ? attendance.inside : "…"}
            </button>
          </div>
          {!online && <div className="scanner-offline">{t("checkin.offlineNotice")}</div>}
          <div className="scanner-counter">
            <div>
              {busy
                ? t("checkin.busy")
                : [
                    t("checkin.counter", {
                      ok: count.device.admitted,
                      ko: count.device.refused,
                    }),
                    ...(count.device.other > 0
                      ? [t("checkin.counterOther", { n: count.device.other })]
                      : []),
                    // Said, not hidden: these are scans pretix has not heard
                    // of yet — kept by an earlier build, which answered some
                    // tickets itself — and the badge in the topbar is not in
                    // view here.
                    ...(waiting > 0 ? [t("checkin.counterWaiting", { n: waiting })] : []),
                  ].join(" · ")}
            </div>
            <div className="scanner-counter-event">
              {count.event === null
                ? t("checkin.counterEventUnknown")
                : t("checkin.counterEvent", { n: count.event })}
            </div>
          </div>
          {fatal && <div className="error-banner">{fatal}</div>}
        </div>
      }
    >
      {busy && (
        // On the picture, where the operator is looking, rather than only in
        // the line under it. pretix usually answers before this shows at all:
        // it fades in after a moment, so a quick scan goes straight to its
        // verdict and a slow one is seen to have been read.
        <div className="scanner-status is-checking">{t("checkin.busy")}</div>
      )}

      {searchOpen && listId && (
        <AttendeeSearch
          pairing={pairing}
          listId={listId}
          onPick={(match) => {
            setSearchOpen(false);
            // The repeat guard is keyed on the code; a deliberate pick of the
            // same person should not be swallowed as a duplicate frame.
            lastCodeRef.current = null;
            void submit(match.secret);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {attendanceOpen && (
        <AttendancePanel
          data={attendance}
          busy={attendanceBusy}
          error={attendanceError}
          onRefresh={() => void loadAttendance()}
          onClose={() => setAttendanceOpen(false)}
        />
      )}

      {verdict && (
        <div className={`verdict ${tone}`} onClick={resume} role="status">
          <div className="verdict-headline">
            {verdict.status !== "ok"
              ? reasonLabel(verdict)
              : admitted
                ? t("checkin.ok")
                : t("checkin.noEntry")}
          </div>
          {verdict.status !== "ok" && verdict.reason_explanation && (
            // pretix' own words for a refusal by rule — which window the ticket
            // is valid in, for instance. The label above names the kind of
            // refusal; this is the part the operator can actually explain.
            <div className="verdict-note">{verdict.reason_explanation}</div>
          )}
          {verdict.status === "ok" && !admitted && (
            <div className="verdict-note">{t("checkin.noEntryHint")}</div>
          )}
          {verdict.status === "ok" && verdict.require_attention && (
            <div className="verdict-attention">{t("checkin.attention")}</div>
          )}
          <div className="verdict-meta">
            {[verdict.position?.attendee_name, verdict.position?.order]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {verdict.checkin_texts?.map((text, i) => (
            <div className="verdict-note" key={i}>
              {text}
            </div>
          ))}
        </div>
      )}

      {noAnswer && (
        <div className="verdict ko" onClick={resume} role="status">
          <div className="verdict-headline">{t("checkin.noAnswer")}</div>
          <div className="verdict-note">{t("checkin.noAnswerHint")}</div>
          <div className="verdict-meta">{noAnswer}</div>
        </div>
      )}
    </QrScanner>
  );
}
