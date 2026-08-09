import { t } from "../i18n";

const ALLOW_BROWSER_KEY = "openpos.allowBrowser.v1";

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

  return (
    <div className="gate">
      <div className="panel">
        <div className="gate-icon" aria-hidden="true">
          📲
        </div>
        <h2>{t("gate.title")}</h2>
        <p style={{ lineHeight: 1.5, color: "var(--text-dim)" }}>{t("gate.why")}</p>
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
        <div className="gate-escape">{t("gate.escape")}</div>
      </div>
    </div>
  );
}
