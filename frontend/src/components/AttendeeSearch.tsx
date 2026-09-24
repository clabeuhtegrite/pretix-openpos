import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { t } from "../i18n";
import type { AttendeeMatch, Pairing } from "../types";

/** Below this, a search matches half the guest list and helps nobody. */
const MIN_QUERY = 2;
/** Let the operator finish typing a name before asking the server. */
const DEBOUNCE_MS = 300;
/** How long the confirmation ignores the tap that opened it. */
const CONFIRM_ARM_MS = 500;

interface Props {
  pairing: Pairing;
  listId: number;
  onPick: (match: AttendeeMatch) => void;
  onClose: () => void;
}

export default function AttendeeSearch({ pairing, listId, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  /**
   * The hit the operator tapped, held back until they confirm it.
   *
   * A scan cannot admit the wrong person — the barcode is the person. A name
   * search can: the results are a list of strangers' names an arm's length
   * apart on a phone held in one hand, at a door, in the dark, with a queue.
   * So the tap selects, and a second, differently placed gesture admits.
   */
  const [pending, setPending] = useState<AttendeeMatch | null>(null);
  /**
   * Whether the confirmation has been on screen long enough to be answered.
   *
   * Placing the admit button away from the list does not protect anything: the
   * results scroll, so a row can sit under any point of the screen, and the
   * button measured out to overlap the third and fourth of them. What a tap
   * cannot outrun is time — half a second no thumb bridges by accident, and no
   * operator who meant it will notice.
   */
  const [armed, setArmed] = useState(false);
  const [results, setResults] = useState<AttendeeMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!pending) inputRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    setArmed(false);
    const timer = window.setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setResults(null);
      setError(null);
      return;
    }

    // Abort in flight on every keystroke, so a slow early request cannot land
    // after a later one and show stale results.
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const data = await api.searchAttendees(pairing, {
          listId,
          query: trimmed,
          signal: controller.signal,
        });
        setResults(data.results);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(t("error.offline"));
      } finally {
        setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, listId, pairing]);

  if (pending) {
    const name = pending.attendee_name?.trim();
    const alreadyIn = pending.checkins.length > 0;
    return (
      <div className="overlay overlay-top" onClick={(e) => e.stopPropagation()}>
        <div className="panel search-panel" onClick={(e) => e.stopPropagation()}>
          <h2>{t("search.confirmTitle")}</h2>

          {/* The name at the size it has to be read from: at arm's length,
              against the face of somebody waiting to be let in. */}
          <div className="confirm-name">{name || pending.order}</div>
          <div className="confirm-meta">
            {name
              ? [pending.order, pending.seat?.name].filter(Boolean).join(" · ")
              : t("search.confirmNoName")}
          </div>

          {alreadyIn && <div className="confirm-warn">{t("search.confirmAlreadyIn")}</div>}
          {pending.require_attention && (
            <div className="confirm-warn">{t("search.confirmAttention")}</div>
          )}

          {/* Refusing stays reachable throughout — the guard is on admitting
              somebody by accident, never on changing your mind. */}
          <button className="btn ghost confirm-back" onClick={() => setPending(null)}>
            {t("search.confirmBack")}
          </button>
          <button
            className="btn success confirm-admit"
            disabled={!armed}
            onClick={() => onPick(pending)}
          >
            {t("search.confirmAdmit")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay overlay-top" onClick={onClose}>
      <div className="panel search-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("search.title")}</h2>

        <div className="field">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.placeholder")}
            autoCapitalize="words"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="help">{t("search.hint")}</div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="search-results">
          {busy && <div className="search-note loading">{t("search.searching")}</div>}
          {!busy && results !== null && results.length === 0 && (
            <div className="search-note">{t("search.none")}</div>
          )}
          {results?.map((match) => {
            const alreadyIn = match.checkins.length > 0;
            return (
              <button
                key={match.id}
                className="search-hit"
                onClick={() => setPending(match)}
              >
                <span className="search-hit-name">
                  {match.attendee_name || match.order}
                </span>
                <span className="search-hit-meta">
                  {[match.order, match.seat?.name].filter(Boolean).join(" · ")}
                </span>
                {alreadyIn && (
                  <span className="search-hit-badge">{t("search.alreadyIn")}</span>
                )}
              </button>
            );
          })}
        </div>

        <button className="btn ghost" onClick={onClose}>
          {t("settings.close")}
        </button>
      </div>
    </div>
  );
}
