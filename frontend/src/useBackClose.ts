import { useEffect, useRef } from "react";

/**
 * Let the system back gesture close an overlay instead of the app.
 *
 * Android wires its back button and edge swipe to session history, and an
 * installed PWA sitting on a single entry has nowhere to go back to: the
 * gesture closes the whole till, taking an open basket with it. So every
 * overlay pushes one history entry while it is open and pops it again when it
 * closes — back then means "close this", and only reaches the app itself once
 * nothing is open.
 *
 * iOS has no such control and is unaffected either way.
 */

interface Entry {
  close: () => void;
  /** Set when the gesture is what closed it, so the cleanup does not pop again. */
  popped: boolean;
}

/** What is open, innermost last. */
const stack: Entry[] = [];

/**
 * Pops we caused ourselves and must not act on.
 *
 * Closing an overlay from the UI has to give back the entry it pushed, which
 * means calling history.back() — and that fires the same event as a real back
 * press. Left unaccounted for, the overlay underneath would take it as its own
 * cue and close too: tapping "Close" on a panel shut the scanner behind it.
 */
let selfPops = 0;

let listening = false;

function onPopState(): void {
  if (selfPops > 0) {
    selfPops -= 1;
    return;
  }
  const top = stack.pop();
  if (!top) return;
  top.popped = true;
  top.close();
}

export function useBackClose(active: boolean, onClose: () => void): void {
  // Held in a ref so a caller passing an inline arrow does not re-run the
  // effect on every render — which would push a history entry each time.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!active) return;

    // A single listener for the whole app: a back press wakes every listener
    // there is, so one overlay per listener would close them all at once.
    if (!listening) {
      window.addEventListener("popstate", onPopState);
      listening = true;
    }

    const entry: Entry = { close: () => close.current(), popped: false };
    stack.push(entry);
    window.history.pushState({ openposOverlay: true }, "");

    return () => {
      const at = stack.lastIndexOf(entry);
      if (at !== -1) stack.splice(at, 1);
      if (!entry.popped) {
        selfPops += 1;
        window.history.back();
      }
    };
  }, [active]);
}
