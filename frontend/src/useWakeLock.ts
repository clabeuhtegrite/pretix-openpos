import { useEffect } from "react";

/**
 * Keep the screen awake while the till is in use.
 *
 * A tablet that dims mid-queue costs a few seconds every time, and a door
 * phone that locks takes its camera down with it. Safari has had the API since
 * 16.4 — but only in a tab. In an app opened from the home screen, which is the
 * only way this one runs on an iPhone or an iPad, it does nothing before
 * iOS/iPadOS 18.4 (WebKit bug 254545): the screen sleeps on the Auto-Lock delay
 * whatever is asked here. Nothing on this side can tell that apart from a lock
 * that works, which is why the pre-event checklist in docs/fonctionnement.md
 * (§7.0) asks for 18.4 or later, or Auto-Lock set to Never. Where the API is
 * missing or refused, we simply do nothing rather than nag.
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
        // Granted is not the same as held on an older iPhone: before 18.4, a
        // home-screen app gets this far and still goes dark (see above).
        sentinel = await navigator.wakeLock.request("screen");
        sentinel.addEventListener("release", () => {
          if (released || retakes >= 20) return;
          if (document.visibilityState !== "visible") return;
          retakes += 1;
          void acquire();
        });
      } catch {
        // Denied — low power mode does — or the app is in the background.
        // Nothing useful to say.
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
