import { useEffect, useRef, useState } from "react";

import { api, ApiError } from "./api";
import { forgetRevocation, loadRevocations } from "./storage";
import type { Pairing } from "./types";

/**
 * End in pretix the pairings this till has given up.
 *
 * pretix asks any app that lets a device be removed to say so on
 * `/device/revoke`. Unpairing used to forget the token and nothing else: the
 * device went on reading "active" in the organizer's device list, with a token
 * that still worked and that nobody held any more, until somebody thought of
 * revoking it by hand.
 *
 * Unpairing has to work without a network — a till is often unpaired because
 * something is already wrong — so the token is queued rather than sent on the
 * spot, and sent from here: at launch, right after an unpairing, and again on
 * each return to the network until pretix has answered.
 */

/**
 * Revoke every queued token.
 *
 * `"retry"` only when a request never reached the server. An answer settles a
 * token whatever it was: a refusal comes from a device already revoked or
 * deleted in the back office, where there is nothing left to end. A fault is
 * the exception that keeps the token for the next launch — pretix may not
 * have written anything — without asking again on every return to the
 * network, since the API layer takes a fault for an absent server and would
 * flip the till offline every few seconds.
 */
export async function revokeLeftovers(): Promise<"done" | "retry"> {
  let outcome: "done" | "retry" = "done";
  for (const token of loadRevocations()) {
    try {
      await api.revokeDevice(token);
    } catch (error) {
      if (error instanceof ApiError && error.isNetwork) {
        outcome = "retry";
        continue;
      }
      if (error instanceof ApiError && error.status >= 500) continue;
    }
    forgetRevocation(token);
  }
  return outcome;
}

/**
 * Revoke once per pairing change, as soon as the till is online.
 *
 * Keyed on the pairing so that unpairing — the pairing going away — is what
 * sends the token it leaves behind, while the ordinary life of a paired till
 * asks nothing.
 */
export function useDeviceRevoke(pairing: Pairing | null, online: boolean): void {
  const current = pairing?.serial ?? null;
  /** The pairing whose leftovers are settled; `undefined` before the first try. */
  const settled = useRef<string | null | undefined>(undefined);
  const sending = useRef(false);
  const latest = useRef(current);
  latest.current = current;
  /** Bumped only to look again when the pairing changed mid-request. */
  const [again, setAgain] = useState(0);

  useEffect(() => {
    if (!online || sending.current || settled.current === current) return;
    sending.current = true;
    void revokeLeftovers().then((outcome) => {
      sending.current = false;
      if (outcome === "done") settled.current = current;
      // Unpaired while this was out — right after a launch — and the token
      // that leaves behind has to go too.
      if (latest.current !== current) setAgain((n) => n + 1);
    });
  }, [current, online, again]);
}
