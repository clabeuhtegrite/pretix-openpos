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

/** iOS 17 and later. Absent everywhere else, which is why it is optional. */
interface AudioSession {
  type: string;
}

let enabled = load();
let ctx: AudioContext | null = null;
let claimed = false;

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
 * Get an audio context, and take it off the ringer switch.
 *
 * Browsers will not start one outside a gesture, which is why this is called
 * from the first tap anywhere in the app rather than from the first cue: a
 * refused ticket is a camera frame, not a tap, and by then it is too late to
 * ask.
 */
export function unlock(): void {
  if (!enabled) return;
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    if (!claimed) {
      const session = (navigator as Navigator & { audioSession?: AudioSession }).audioSession;
      if (session) session.type = "playback";
      claimed = true;
    }
  } catch {
    // No audio on this device or in this context. The screen is still the
    // answer; this was only ever the nudge.
  }
}

/** One note, scheduled relative to the context's own clock. */
function tone(
  at: number,
  freq: number,
  ms: number,
  peak: number,
  shape: OscillatorType,
): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = shape;
  osc.frequency.value = freq;
  // Ramped rather than switched: a square edge on an amplitude is a click of
  // its own, and over a few hundred sales an evening that is what grates.
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + ms / 1000 + 0.02);
}

/**
 * Make the noise for what just happened.
 *
 * Quiet and short for a sale, because it happens several hundred times a
 * night; two falling notes for a refusal, because falling is what every ear
 * in the room already reads as no.
 */
export function play(cue: Cue): void {
  if (!enabled) return;
  unlock();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    if (cue === "add") tone(now, 880, 40, 0.06, "sine");
    else if (cue === "ok") tone(now, 1047, 70, 0.1, "sine");
    else {
      tone(now, 392, 170, 0.18, "triangle");
      tone(now + 0.16, 262, 260, 0.18, "triangle");
    }
  } catch {
    // A context that has been closed under us, or a browser that will not
    // schedule. Not worth a single line on screen.
  }
}
