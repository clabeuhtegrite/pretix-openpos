/**
 * The till's three sounds.
 *
 * The door runs on iPhones, and iOS has no web vibration at all — the refusal
 * buzz in CheckinScreen does nothing there and never has. So at a loud door
 * the only thing saying "not this one" is a red screen the volunteer has to be
 * looking at, in the one moment they are looking at the person instead. A
 * sound is the only channel iOS actually gives a web app, which is why this
 * exists.
 *
 * The tones are synthesised rather than shipped as files: nothing to fetch,
 * nothing to cache, and a till that has lost the network still makes them.
 *
 * One deliberate rudeness. On iOS, Web Audio obeys the ring/silent switch
 * unless the page claims the "playback" audio session, and a volunteer's
 * phone at a door is very often on silent. Since iOS 17 that claim is one
 * property, and this makes it — the refusal has to be heard, and the operator
 * keeps a switch of their own in the settings.
 */

/** What happened, rather than what it should sound like. */
export type Cue = "add" | "ok" | "refused";

const KEY = "openpos.sound.v1";

/**
 * How late a cue may still be played.
 *
 * A cue that finds the audio stopped asks for it back and plays once it runs
 * — if that is quick. Scheduling it on the stopped context instead, as this
 * used to, queued it: every refusal of a silent half hour then came out at
 * once, on whatever tap finally woke the audio, over a ticket that was fine.
 * Half a second is still "this ticket" to the person holding the phone; after
 * that the note says nothing about anything in front of them.
 */
export const STALE_CUE_MS = 500;

/**
 * The events that count as the operator touching the device.
 *
 * All of them, and on every occurrence until the audio actually runs. The HTML
 * spec only lets some events carry the "user activation" a browser wants before
 * it starts audio: a key press, a mouse button going down — and, for a finger,
 * the finger coming *up* (pointerup, touchend, click), never pointerdown. The
 * listener this replaced waited for the first pointerdown and then removed
 * itself. On a phone that first touch is not an activation, so the one attempt
 * it ever made could be exactly the one that cannot work, and the door stayed
 * silent until a relaunch.
 */
const GESTURES = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

/** iOS 17 and later. Absent everywhere else, which is why it is optional. */
interface AudioSession {
  type: string;
}

let enabled = load();
let ctx: AudioContext | null = null;
let claimed = false;
/**
 * A gesture asked the context to resume, the answer came back, and it still
 * was not running.
 *
 * That is what an iPhone does to a context after a phone call, Siri, or a
 * while in the background: it sits "interrupted" (a state only WebKit has) or
 * "suspended", and some of those never come back however often they are asked.
 * A context made fresh inside a gesture always starts, so the next gesture
 * closes this one and makes another rather than asking it forever.
 */
let stuck = false;

function load(): boolean {
  try {
    // On unless it has been turned off: a door with no sound is the case this
    // was written for, and a till nobody has configured is a door.
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage refused. It holds for this session and not past a relaunch,
    // which is not worth interrupting a service for.
  }
  if (on) unlock();
}

/**
 * Ask a context to run, and never let the answer escape.
 *
 * A refused resume rejects its promise, and nothing waits on this one: left
 * unhandled, that is an error report per tap on a device whose audio is
 * merely busy. Resolves either way; whoever cares reads `state` afterwards.
 */
function resume(context: AudioContext): Promise<void> {
  try {
    return Promise.resolve(context.resume()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * The context, made if there is none yet, and the ringer switch claimed.
 *
 * A closed context cannot be reopened, so one is replaced; anything else is
 * kept — whether it runs is `unlock`'s and `play`'s business.
 */
function ensure(): AudioContext | null {
  if (!claimed) {
    // Before the context exists, so that it starts in the playback session
    // rather than being moved there mid-sound.
    const session = (navigator as Navigator & { audioSession?: AudioSession }).audioSession;
    if (session) session.type = "playback";
    claimed = true;
  }
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (ctx?.state === "closed") ctx = null;
  ctx ??= new Ctor();
  return ctx;
}

/**
 * Get the audio running, from inside a gesture.
 *
 * Browsers will not start a context outside one, which is why this is called
 * on the operator's taps rather than on the first cue: a refused ticket is a
 * camera frame, not a tap, and by then it is too late to ask. Anything that is
 * not "running" is asked to resume — "suspended", and WebKit's "interrupted"
 * alike — and a context that a previous gesture could not bring back is
 * replaced by a fresh one (see `stuck`).
 */
export function unlock(): void {
  if (!enabled) return;
  try {
    if (stuck && ctx && ctx.state !== "running") {
      const old = ctx;
      ctx = null;
      try {
        void Promise.resolve(old.close()).catch(() => {});
      } catch {
        // Already gone; all that mattered was letting go of it.
      }
    }
    stuck = false;
    const context = ensure();
    if (!context || context.state === "running") return;
    void resume(context).then(() => {
      if (context === ctx && context.state !== "running") stuck = true;
    });
  } catch {
    // No audio on this device or in this context. The screen is still the
    // answer; this was only ever the nudge.
  }
}

/**
 * Ask a stopped context back, outside any gesture.
 *
 * Coming back to the app — from the lock screen, a call, the app switcher — is
 * when iOS hands the audio back, and it does not always restart it itself.
 * Asking costs nothing when it is not allowed, and when it is, the next refusal
 * at the door is heard without anyone having to touch the screen first. Never
 * counted as a failed attempt: without a gesture, "no" is the expected answer.
 */
function wake(): void {
  if (!enabled || !ctx) return;
  if (ctx.state === "closed") {
    ctx = null;
    return;
  }
  if (ctx.state !== "running") void resume(ctx);
}

/**
 * Keep the audio ready for a cue that comes with no tap, for as long as the app
 * runs. Returns the way to stop.
 *
 * Every gesture tries again until the context runs — the first tap is not
 * always one the browser accepts, and an iPhone takes the audio away again
 * after a call or a spell in the background — and coming back to the app asks
 * for it at once. Once the context runs, a gesture costs one comparison.
 */
export function keepSoundReady(): () => void {
  const onGesture = () => {
    if (ctx?.state !== "running") unlock();
  };
  const onReturn = () => {
    if (document.visibilityState !== "hidden") wake();
  };
  for (const type of GESTURES) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", onReturn);
  window.addEventListener("pageshow", onReturn);
  window.addEventListener("focus", onReturn);
  return () => {
    for (const type of GESTURES) window.removeEventListener(type, onGesture, { capture: true });
    document.removeEventListener("visibilitychange", onReturn);
    window.removeEventListener("pageshow", onReturn);
    window.removeEventListener("focus", onReturn);
  };
}

/** One note, scheduled relative to the context's own clock. */
function tone(
  context: AudioContext,
  at: number,
  freq: number,
  ms: number,
  peak: number,
  shape: OscillatorType,
): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = shape;
  osc.frequency.value = freq;
  // Ramped rather than switched: a square edge on an amplitude is a click of
  // its own, and over a few hundred sales an evening that is what grates.
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
  osc.connect(gain).connect(context.destination);
  osc.start(at);
  osc.stop(at + ms / 1000 + 0.02);
}

function sound(context: AudioContext, cue: Cue): void {
  try {
    const now = context.currentTime;
    if (cue === "add") tone(context, now, 880, 40, 0.06, "sine");
    else if (cue === "ok") tone(context, now, 1047, 70, 0.1, "sine");
    else {
      tone(context, now, 392, 170, 0.18, "triangle");
      tone(context, now + 0.16, 262, 260, 0.18, "triangle");
    }
  } catch {
    // A context that has been closed under us, or a browser that will not
    // schedule. Not worth a single line on screen.
  }
}

/**
 * Make the noise for what just happened.
 *
 * Quiet and short for a sale, because it happens several hundred times a
 * night; two falling notes for a refusal, because falling is what every ear
 * in the room already reads as no. On a context that is not running, the cue
 * waits for it to resume and is dropped if that takes longer than
 * `STALE_CUE_MS`.
 */
export function play(cue: Cue): void {
  if (!enabled) return;
  let context: AudioContext | null;
  try {
    context = ensure();
  } catch {
    return;
  }
  if (!context) return;
  if (context.state === "running") {
    sound(context, cue);
    return;
  }
  const asked = Date.now();
  const target = context;
  void resume(target).then(() => {
    if (target !== ctx || target.state !== "running") return;
    if (Date.now() - asked > STALE_CUE_MS) return;
    sound(target, cue);
  });
}
