import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "../api";
import { t, type MessageKey } from "../i18n";
import { newNonce } from "../nonce";
import type { Attendance, CheckinListInfo, Pairing, RedeemResult } from "../types";
import AttendancePanel from "./AttendancePanel";
import AttendeeSearch from "./AttendeeSearch";
import QrScanner from "./QrScanner";

/** How long a verdict stays up before scanning resumes. */
const HOLD_OK_MS = 1500;
const HOLD_ERROR_MS = 6000;
/** Ignore the same code for this long, so one ticket in frame is not read ten times. */
const REPEAT_GUARD_MS = 3000;
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
  onClose: () => void;
}

export default function CheckinScreen({ pairing, lists, defaultListId, onClose }: Props) {
  const [listId, setListId] = useState<number | null>(
    defaultListId ?? (lists.length ? lists[0].id : null),
  );
  const [verdict, setVerdict] = useState<RedeemResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [counts, setCounts] = useState({ ok: 0, ko: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);

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
      if (previous && previous.code === code && Date.now() - previous.at < REPEAT_GUARD_MS) return;
      lastCodeRef.current = { code, at: Date.now() };

      busyRef.current = true;
      setBusy(true);
      setFatal(null);
      try {
        const result = await api.redeem(pairing, {
          secret: code,
          lists: [listId],
          nonce: newNonce(),
        });
        setVerdict(result);
        setCounts((c) =>
          result.status === "ok" ? { ...c, ok: c.ok + 1 } : { ...c, ko: c.ko + 1 },
        );
        if (result.status === "ok") {
          // The room just changed. Ask the server rather than adding one here:
          // this screen has no way of knowing whether the product that was just
          // scanned admits anybody, and a head count that drifts is worthless.
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
    [listId, pairing, loadAttendance],
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

  const tone =
    verdict?.status === "ok" ? (verdict.require_attention ? "warn" : "ok") : "ko";

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
              onChange={(e) => setListId(Number(e.target.value))}
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
          <div className="scanner-counter">
            {busy ? t("checkin.busy") : t("checkin.counter", { ok: counts.ok, ko: counts.ko })}
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
            {verdict.status === "ok" ? t("checkin.ok") : reasonLabel(verdict)}
          </div>
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
