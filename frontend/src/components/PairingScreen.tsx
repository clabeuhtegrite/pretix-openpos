import { useState } from "react";

import { api, ApiError } from "../api";
import { t } from "../i18n";
import type { EventSummary, I18nString, Pairing } from "../types";

/** pretix returns display names either flat or as a locale map. */
function localize(value: I18nString): string {
  if (typeof value === "string") return value;
  return value[navigator.language.slice(0, 2)] ?? Object.values(value)[0] ?? "";
}

/**
 * The pairing QR that pretix shows contains a JSON blob. Accept that verbatim
 * as well as a bare token, because "scan it with the camera app and paste"
 * is the realistic flow on an iPad without a QR library.
 */
function extractToken(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: string };
      if (parsed.token) return parsed.token;
    } catch {
      // Fall through and try it as a plain token.
    }
  }
  return trimmed;
}

interface Props {
  onPaired: (pairing: Pairing) => void;
}

export default function PairingScreen({ onPaired }: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [partial, setPartial] = useState<Omit<Pairing, "event"> | null>(null);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    const token = extractToken(input);
    if (!token) return;

    setBusy(true);
    setError(null);
    try {
      const device = await api.initialize(token);
      const base = {
        token: device.api_token,
        organizer: device.organizer,
        serial: device.unique_serial,
        deviceName: device.name,
      };
      const list = await api.listEvents(device.organizer, device.api_token);
      if (list.results.length === 1) {
        onPaired({ ...base, event: list.results[0].slug });
        return;
      }
      setPartial(base);
      setEvents(list.results);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.isNetwork
            ? t("error.offline")
            : err.message
          : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  if (events && partial) {
    return (
      <div className="centered">
        <div className="panel">
          <h2>{t("pairing.chooseEvent")}</h2>
          {events.length === 0 ? (
            <>
              <p>{t("pairing.noEvents")}</p>
              <button
                className="btn ghost"
                onClick={() => {
                  setEvents(null);
                  setPartial(null);
                }}
              >
                {t("pairing.retry")}
              </button>
            </>
          ) : (
            <div className="event-list">
              {events.map((event) => (
                <button key={event.slug} onClick={() => onPaired({ ...partial, event: event.slug })}>
                  {localize(event.name)}
                  <span className="slug">{event.slug}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="centered">
      <form className="panel" onSubmit={pair}>
        <h2>{t("pairing.title")}</h2>
        <p className="help" style={{ marginTop: 0, marginBottom: 20 }}>
          {t("pairing.intro")}
        </p>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="token">{t("pairing.token")}</label>
          <input
            id="token"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            placeholder="xxxxxxxxxxxxxxxx"
          />
          <div className="help">{t("pairing.tokenHelp")}</div>
        </div>
        <button className="btn primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? t("pairing.pairing") : t("pairing.submit")}
        </button>
      </form>
    </div>
  );
}
