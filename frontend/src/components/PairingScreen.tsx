import { useState } from "react";

import { api } from "../api";
import { describeError } from "../errors";
import { t } from "../i18n";
import type { Pairing, PosEventList } from "../types";
import { EventButtons, UnavailableEvents } from "./EventChoice";
import QrScanner from "./QrScanner";

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
  const [events, setEvents] = useState<PosEventList | null>(null);
  const [partial, setPartial] = useState<Omit<Pairing, "event"> | null>(null);
  const [scanning, setScanning] = useState(false);

  async function pair(raw: string) {
    const token = extractToken(raw);
    if (!token) return;

    setScanning(false);
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
      // Only events that actually run Open POS: the device token grants access
      // to events, which is not the same thing as the organizer having opened a
      // till on them. Offering one would pair the device onto an event whose
      // endpoints then refuse it.
      const list = await api.posEvents(device.organizer, device.api_token);
      if (list.results.length === 1) {
        onPaired({ ...base, event: list.results[0].slug });
        return;
      }
      setPartial(base);
      setEvents(list);
    } catch (err) {
      // The same wording as everywhere else: a pairing tried against a pretix
      // that is restarting used to say "HTTP 502" to the person holding a
      // brand-new till.
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (events && partial) {
    return (
      <div className="centered">
        <div className="panel">
          <h2>{t("pairing.chooseEvent")}</h2>
          {events.results.length === 0 ? (
            <>
              <p>{t("pairing.noEvents")}</p>
              <UnavailableEvents events={events.unavailable ?? []} />
              <button
                className="btn ghost"
                style={{ marginTop: 16 }}
                onClick={() => {
                  setEvents(null);
                  setPartial(null);
                }}
              >
                {t("pairing.retry")}
              </button>
            </>
          ) : (
            <>
              <EventButtons
                events={events.results}
                onPick={(slug) => onPaired({ ...partial, event: slug })}
              />
              <UnavailableEvents events={events.unavailable ?? []} />
            </>
          )}
        </div>
      </div>
    );
  }

  if (scanning) {
    return (
      <QrScanner
        title={t("pairing.scanTitle")}
        hint={t("pairing.scanHint")}
        onDecode={(text) => void pair(text)}
        onClose={() => setScanning(false)}
      />
    );
  }

  return (
    <div className="centered">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void pair(input);
        }}
      >
        <h2>{t("pairing.title")}</h2>
        <p className="help" style={{ marginTop: 0, marginBottom: 20 }}>
          {t("pairing.intro")}
        </p>
        {error && <div className="error-banner">{error}</div>}

        <button
          type="button"
          className="btn primary"
          style={{ marginBottom: 18 }}
          onClick={() => {
            setError(null);
            setScanning(true);
          }}
          disabled={busy}
        >
          📷 {t("scan.open")}
        </button>
        <div className="divider">{t("pairing.orType")}</div>

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
        <button
          className="btn"
          type="submit"
          disabled={busy || !input.trim()}
          aria-busy={busy || undefined}
        >
          {busy ? t("pairing.pairing") : t("pairing.submit")}
        </button>
      </form>
    </div>
  );
}
