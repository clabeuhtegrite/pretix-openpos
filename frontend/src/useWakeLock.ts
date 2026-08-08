import { useEffect } from "react";

/**
 * Keep the screen awake while the till is in use.
 *
 * A tablet that dims mid-queue costs a few seconds every time. Safari has
 * supported this since 16.4; where it is missing or refused, we simply do
 * nothing rather than nag.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Denied, or the tab is in the background. Nothing useful to say.
      }
    };

    const onVisibilityChange = () => {
      // The lock is dropped whenever the page is hidden, so take it again.
      if (!released && document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void sentinel?.release().catch(() => {});
    };
  }, [enabled]);
}
