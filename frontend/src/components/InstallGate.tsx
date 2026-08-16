import { useEffect, useState } from "react";

import { t } from "../i18n";

const ALLOW_BROWSER_KEY = "openpos.allowBrowser.v1";

/** Chrome's install prompt, which no published typing covers. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

/**
 * True when the app was launched from the home screen rather than a browser tab.
 *
 * iOS never implemented the display-mode media query for home-screen apps and
 * uses its own navigator.standalone instead, so both have to be consulted.
 */
export function isStandalone(): boolean {
  const iosStandalone =
    "standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayMode =
    typeof window.matchMedia === "function" &&
    ["standalone", "fullscreen", "minimal-ui"].some(
      (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
    );
  return iosStandalone || displayMode;
}

/**
 * Escape hatch, on purpose.
 *
 * Opening `/openpos/?browser=1` once allows browser use on this device from then
 * on. It exists because being locked out of the till on the night of an event —
 * because a browser misreports its display mode, or because the app has not been
 * installed yet on a replacement device — is a worse failure than a volunteer
 * using a tab.
 */
export function browserAllowed(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("browser") === "1") {
      localStorage.setItem(ALLOW_BROWSER_KEY, "1");
      return true;
    }
    return localStorage.getItem(ALLOW_BROWSER_KEY) === "1";
  } catch {
    return false;
  }
}

export default function InstallGate() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Android and desktop Chrome offer to install the app themselves, which is
  // one tap instead of a hunt through a browser menu. Safari fires nothing of
  // the sort, so iOS keeps the written steps — the only route it has.
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Without this the browser shows its own banner whenever it feels like it,
      // which on a counter is a dialog nobody asked for mid-service.
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  return (
    <div className="gate">
      <div className="panel">
        <div className="gate-icon" aria-hidden="true">
          📲
        </div>
        <h2>{t("gate.title")}</h2>
        <p style={{ lineHeight: 1.5, color: "var(--text-dim)" }}>{t("gate.why")}</p>

        {installPrompt ? (
          <button
            className="btn primary"
            style={{ marginTop: 8 }}
            onClick={() => {
              void installPrompt.prompt();
              // One shot per event: a second call is refused by the browser.
              setInstallPrompt(null);
            }}
          >
            {t("gate.install")}
          </button>
        ) : (
          <ol>
            {ios ? (
              <>
                <li>{t("gate.ios1")}</li>
                <li>{t("gate.ios2")}</li>
                <li>{t("gate.ios3")}</li>
              </>
            ) : (
              <>
                <li>{t("gate.other1")}</li>
                <li>{t("gate.other2")}</li>
              </>
            )}
          </ol>
        )}

        <div className="gate-escape">{t("gate.escape")}</div>
      </div>
    </div>
  );
}
