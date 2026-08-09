import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { t } from "../i18n";
import type { AttendeeMatch, Pairing } from "../types";

/** Below this, a search matches half the guest list and helps nobody. */
const MIN_QUERY = 2;
/** Let the operator finish typing a name before asking the server. */
const DEBOUNCE_MS = 300;

interface Props {
  pairing: Pairing;
  listId: number;
  onPick: (match: AttendeeMatch) => void;
  onClose: () => void;
}

export default function AttendeeSearch({ pairing, listId, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AttendeeMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
          {busy && <div className="search-note">{t("search.searching")}</div>}
          {!busy && results !== null && results.length === 0 && (
            <div className="search-note">{t("search.none")}</div>
          )}
          {results?.map((match) => {
            const alreadyIn = match.checkins.length > 0;
            return (
              <button
                key={match.id}
                className="search-hit"
                onClick={() => onPick(match)}
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
