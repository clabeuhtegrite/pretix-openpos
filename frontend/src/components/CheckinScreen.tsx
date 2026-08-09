import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "../api";
import { t, type MessageKey } from "../i18n";
import { newNonce } from "../nonce";
import type { CheckinListInfo, Pairing, RedeemResult } from "../types";
import QrScanner from "./QrScanner";

/** How long a verdict stays up before scanning resumes. */
const HOLD_OK_MS = 1500;
const HOLD_ERROR_MS = 6000;
/** Ignore the same code for this long, so one ticket in frame is not read ten times. */
const REPEAT_GUARD_MS = 3000;

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
  const [manual, setManual] = useState("");

  // Refs, not state: these gate the decode callback and must not re-render it.
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);
  const busyRef = useRef(false);
  const holdRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(holdRef.current), []);

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
    [listId, pairing],
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
      paused={busy || verdict !== null}
      onDecode={submit}
      onClose={onClose}
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
          <form
            className="scanner-manual"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(manual);
              setManual("");
            }}
          >
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder={t("checkin.manualPlaceholder")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              // A keyboard-wedge barcode reader types here and presses Enter.
              autoComplete="off"
            />
            <button className="btn" type="submit" disabled={busy || !manual.trim()}>
              {busy ? t("checkin.busy") : t("checkin.submit")}
            </button>
          </form>
          <div className="scanner-counter">
            {t("checkin.counter", { ok: counts.ok, ko: counts.ko })}
          </div>
          {fatal && <div className="error-banner">{fatal}</div>}
        </div>
      }
    >
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
