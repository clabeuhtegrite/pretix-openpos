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
    // The system can hand the lock back at any time — low power mode, a call, a
    // permission sheet. Taking it again is right, looping forever if it is
    // being refused in substance is not.
    let retakes = 0;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
        sentinel.addEventListener("release", () => {
          if (released || retakes >= 20) return;
          if (document.visibilityState !== "visible") return;
          retakes += 1;
          void acquire();
        });
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
