import { saveDoorResume, saveUpdateAttempt } from "./storage";

/**
 * Moving a device onto a new build without ever leaving it with none.
 *
 * The update bar used to throw every cache away and reload. The cache it threw
 * away holds the only copy of the app a till can start from with no network,
 * and the reload is what was supposed to put the new one there — so an update
 * pressed on a wifi that dropped at that moment, or a server that answered the
 * reload with a 502, left a till that could not open at all until the network
 * came back, at the very moment it would have had to sell offline.
 *
 * Now the service worker fetches the new build first — the page and every file
 * it names — and swaps it in only once all of it is on the device (sw.js,
 * "prepare-update"). Only then does the page reload. If the new build cannot
 * be fetched, nothing changes: the device goes on with the build it has, which
 * still works, and the offer stands.
 */

/**
 * How long a door must be left alone before it installs a new build by itself.
 *
 * Doors are the devices nobody ever closes: the scanner is their home screen,
 * so they used to run the build they were opened with until somebody thought
 * of relaunching every phone by hand. Twenty seconds with no ticket read, no
 * verdict on screen and nothing open is a gap in the queue, and the reload is
 * over in a few seconds more.
 */
export const DOOR_IDLE_UPDATE_MS = 20_000;

/**
 * The same for a till: a minute with an empty basket, nothing being paid and
 * nothing open — a lull, not the moment between two customers who are
 * already standing there.
 */
export const TILL_IDLE_UPDATE_MS = 60_000;

/**
 * How long after a failed attempt the device tries by itself again.
 *
 * A failure is a network that could not bring the new build in, and asking
 * again every twenty seconds would mostly be asking a dead wifi. The bar
 * still takes a tap at any time.
 */
export const UPDATE_RETRY_MS = 5 * 60_000;

/** The message the service worker answers; see sw.js. */
export const PREPARE_UPDATE = "openpos:prepare-update";

/**
 * How long the service worker has to say it has started.
 *
 * One that knows the message answers at once. Silence is a worker from a build
 * before this one, which cannot prepare anything — but whose own navigation
 * handler goes to the network first, so a plain reload still reaches the new
 * build, the way it always did, only without the cache wipe.
 */
export const PREPARE_RECEIPT_MS = 3_000;

/**
 * How long fetching the new build may take once started: the page and its
 * bundle, a few hundred kilobytes over a venue's wifi. Past this it counts as
 * failed, and the device stays where it is.
 */
export const PREPARE_TIMEOUT_MS = 60_000;

/**
 * `ready`: the new build is on the device. `failed`: it could not be fetched,
 * and nothing was changed. `unsupported`: there is no worker to ask — a
 * browser without one, a first load it does not control yet, or an older
 * worker — and a reload is the whole of what can be done.
 */
export type Preparation = "ready" | "failed" | "unsupported";

export function prepareUpdate(): Promise<Preparation> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve("unsupported");

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let timer = 0;
    const finish = (outcome: Preparation) => {
      window.clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(outcome);
    };
    timer = window.setTimeout(() => finish("unsupported"), PREPARE_RECEIPT_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      const state = (event.data as { state?: unknown } | null)?.state;
      if (state === "preparing") {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => finish("failed"), PREPARE_TIMEOUT_MS);
      } else if (state === "ready" || state === "failed") {
        finish(state);
      }
    };
    try {
      worker.postMessage({ type: PREPARE_UPDATE }, [channel.port2]);
    } catch {
      finish("unsupported");
    }
  });
}

/**
 * Fetch the new build, then reload onto it — or say that it could not be done.
 *
 * Resolves `false`, having changed nothing, when the new build could not be
 * fetched. On success the page reloads, and `true` is only ever seen by a test.
 *
 * `reopenDoor` asks the new build to open on the door screen, which it would
 * not otherwise do on a device that also sells: an update that lands while it
 * is scanning must not leave the queue at the door facing a till.
 */
export async function installUpdate(serverVersion: string, reopenDoor: boolean): Promise<boolean> {
  if ((await prepareUpdate()) === "failed") return false;
  // Written before the reload, not after: whatever comes back has to be able
  // to tell that the offer was already taken up — see saveUpdateAttempt.
  saveUpdateAttempt(serverVersion);
  if (reopenDoor) saveDoorResume();
  window.location.reload();
  return true;
}
