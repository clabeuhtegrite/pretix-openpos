import { useEffect, useRef } from "react";

import { api, ApiError, deviceDescription } from "./api";
import { loadDeviceReport, saveDeviceReport } from "./storage";
import type { DeviceDescription, Pairing } from "./types";

/**
 * Keep pretix' device list telling the truth about this device.
 *
 * The organizer's device list shows, beside each device, the software and the
 * version it runs, and pretix learns both from the device alone: once at
 * pairing, then each time the device reports again on `/device/update`. The
 * till only ever did the first. Every device went on showing the build it was
 * paired with through every release after it, while pretixSCAN, which reports
 * after each of its own updates, showed its real one on the line below.
 *
 * The till now reports at launch whenever what it would say differs from what
 * pretix last accepted: a new build, or a system update, which moves the user
 * agent. Not at every launch, because pretix writes an entry in the device's
 * history for each report, and a phone reopened twenty times in an evening
 * would bury the entries that matter under identical ones.
 */

function same(known: DeviceDescription | null, current: DeviceDescription): boolean {
  if (!known) return false;
  const keys = Object.keys(current) as (keyof DeviceDescription)[];
  return keys.every((key) => known[key] === current[key]);
}

/**
 * Tell pretix what this device runs, if it was told something else.
 *
 * `"retry"` only for a request that never reached the server, which is worth
 * sending again once the till is back online. An answer is not, whatever it
 * was: a refusal will be the same next time, and a fault repeated on every
 * return to the network would flip the till offline every few seconds, since
 * the API layer takes a fault for an absent server. Both wait for the next
 * launch.
 */
export async function reportDevice(pairing: Pairing): Promise<"done" | "retry"> {
  const description = deviceDescription();
  if (same(loadDeviceReport(pairing.serial), description)) return "done";
  try {
    await api.updateDevice(pairing.token, description);
  } catch (error) {
    return error instanceof ApiError && error.isNetwork ? "retry" : "done";
  }
  saveDeviceReport(pairing.serial, description);
  return "done";
}

/**
 * Pairing has just told pretix all of this.
 *
 * `/device/initialize` carries the same description, so reporting it again at
 * the first launch would only put a second entry in the new device's history,
 * a second after the first.
 */
export function markDeviceReported(serial: string): void {
  saveDeviceReport(serial, deviceDescription());
}

/**
 * Report once per launch, as soon as the till is paired and online.
 *
 * Tried again on each return to the network until it has gone through or been
 * answered, so a till opened in a dead corner of the venue reports when it
 * finds the wifi.
 */
export function useDeviceReport(pairing: Pairing | null, online: boolean): void {
  /** The device whose report is settled for this launch. */
  const settled = useRef<string | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (!pairing || !online || sending.current || settled.current === pairing.serial) return;
    sending.current = true;
    void reportDevice(pairing).then((outcome) => {
      sending.current = false;
      if (outcome === "done") settled.current = pairing.serial;
    });
  }, [pairing, online]);
}
