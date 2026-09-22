import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../api";
import { useConnectivity } from "../connectivity";
import { t, type MessageKey } from "../i18n";
import { newNonce } from "../nonce";
import { indexSnapshot, offlineVerdict } from "../offline";
import { enqueue, loadQueue } from "../storage";
import type { Attendance, CheckinListInfo, Pairing, RedeemResult } from "../types";
import { useBackClose } from "../useBackClose";
import { useOfflineSnapshot } from "../useOfflineSnapshot";
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
 * Delay before re-reading it after a successful scan.
 *
 * Long enough for a burst of tickets to collapse into one request, short enough
 * that the count has moved by the time the operator looks up from the verdict.
 */
const ATTENDANCE_SETTLE_MS = 1200;

/**
 * Buzz on a refusal.
 *
 * At a loud door, looking up at the right moment is not a given. Android
 * vibrates; iOS has no web vibration at all and simply does not, which is why
 * the red screen stays the actual answer and this is only a nudge.
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
  /**
   * Told when the operator switches lists, so the app can go on carrying the
   * guest list of this door after the screen is closed, and reopen it here.
   */
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
   * Told when an entry has just been added to the offline queue.
   *
   * The app owns the badge and the automatic drain, and both are driven off a
   * count it keeps. Without this, a door that only ever scans queued entries
   * the app never heard about: the badge read "0" after a whole evening, and
   * the drain bailed out the moment the network came back because as far as it
   * knew there was nothing to send. The entries sat in the browser until
   * somebody happened to relaunch the app.
   */
  onQueued?: () => void;
  onClose: () => void;
}

export default function CheckinScreen({
  pairing, lists, defaultListId, admissionItems, onListChange, onSell, onQueued, onClose,
}: Props) {
  const [listId, setListId] = useState<number | null>(
    defaultListId ?? (lists.length ? lists[0].id : null),
  );
  const [verdict, setVerdict] = useState<RedeemResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [counts, setCounts] = useState({ ok: 0, ko: 0, other: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);

  const online = useConnectivity();
  // Kept fresh for the list on screen while there is a network, because it is
  // the only thing that will answer a scan once there is not.
  const snapshot = useOfflineSnapshot(pairing, listId, online);
  // Indexed once per snapshot, not per scan; also carries which list it is
  // for, so a door switched mid-dropout is answered with "no guest list"
  // rather than with the other door's.
  const snapshotIndex = useMemo(() => indexSnapshot(snapshot), [snapshot]);
  const snapshotUsable = snapshotIndex !== null && snapshotIndex.listId === listId;
  // Scanned on this device since the snapshot was taken, so a second scan of the
  // same ticket is caught without waiting for the network to come back.
  const scannedHereRef = useRef<Set<string>>(
    new Set(loadQueue().filter((e) => e.kind === "checkin").map((e) => e.secret)),
  );

  // Refs, not state: these gate the decode callback and must not re-render it.
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);
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
    setAttendanceBusy(true);
    try {
      const data = await api.attendance(pairing, listId);
      if (attendanceRunRef.current !== run) return;
      setAttendance(data);
      setAttendanceError(null);
    } catch (e) {
      if (attendanceRunRef.current !== run) return;
      // The count is informational: a failure leaves the last known figure on
      // the button rather than taking the operator out of scanning.
      setAttendanceError(e instanceof ApiError && e.isNetwork ? t("error.offline") : String(e));
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

  useBackClose(searchOpen, () => setSearchOpen(false));
  useBackClose(attendanceOpen, () => setAttendanceOpen(false));

  const resume = useCallback(() => {
    window.clearTimeout(holdRef.current);
    setVerdict(null);
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
      try {
        let result: RedeemResult;
        if (online) {
          result = await api.redeem(pairing, {
            secret: code,
            lists: [listId],
            nonce: newNonce(),
          });
        } else {
          // No server to ask: answer from the snapshot, and queue what was
          // admitted so pretix hears about it — with this timestamp — later.
          result = offlineVerdict(snapshotIndex, listId, code, scannedHereRef.current);
          if (result.status === "ok") {
            scannedHereRef.current.add(code);
            enqueue({
              kind: "checkin",
              id: newNonce(),
              at: new Date().toISOString(),
              event: pairing.event,
              list: listId,
              secret: code,
              name: result.position?.attendee_name ?? "",
            });
            onQueued?.();
          }
        }
        setVerdict(result);
        setCounts((c) => {
          if (result.status !== "ok") return { ...c, ko: c.ko + 1 };
          return admits(result, admissionItems)
            ? { ...c, ok: c.ok + 1 }
            : { ...c, other: c.other + 1 };
        });
        if (result.status !== "ok") buzz();
        if (result.status === "ok" && online) {
          // The room may just have changed. Still asked of the server rather
          // than added up here: the figure counts every door and every till,
          // and one kept locally would drift from the first scan made elsewhere.
          window.clearTimeout(settleRef.current);
          settleRef.current = window.setTimeout(() => void loadAttendance(), ATTENDANCE_SETTLE_MS);
        }
        window.clearTimeout(holdRef.current);
        holdRef.current = window.setTimeout(
          () => setVerdict(null),
          result.status === "ok" ? HOLD_OK_MS : HOLD_ERROR_MS,
        );
      } catch (e) {
        // Transport or auth failure: let the operator retry the same ticket.
        lastCodeRef.current = null;
        setFatal(e instanceof ApiError && e.isNetwork ? t("error.offline") : String(e));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [listId, pairing, loadAttendance, admissionItems, online, snapshotIndex],
  );

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
      paused={busy || verdict !== null || searchOpen || attendanceOpen}
      onDecode={submit}
      onClose={onClose}
      // Tickets carry a QR code and nothing a human could retype, so there is no
      // manual entry to fall back on here — unlike pairing, where pretix prints
      // the code as text next to the QR.
      errorHint={t("scan.cameraRequired")}
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
              // First in the row on purpose: it is the one thing on this screen
              // that takes money, and the queue it serves is somebody standing
              // at the door without a ticket.
              <button className="btn" onClick={onSell}>
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
          {!online && (
            <div className="scanner-offline">
              {snapshotUsable
                ? t("offline.scanning", { n: snapshotIndex.count })
                : t("offline.noSnapshot")}
            </div>
          )}
          <div className="scanner-counter">
            {busy
              ? t("checkin.busy")
              : t("checkin.counter", { ok: counts.ok, ko: counts.ko }) +
                (counts.other > 0 ? ` · ${t("checkin.counterOther", { n: counts.other })}` : "")}
          </div>
          {fatal && <div className="error-banner">{fatal}</div>}
        </div>
      }
    >
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
    </QrScanner>
  );
}
