import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The till's sounds.
 *
 * What is worth asserting here is not the pitch of anything: it is that a
 * refusal makes a noise at a door where nothing else can, that the setting is
 * obeyed and survives a relaunch, and that a device with no audio at all goes
 * on selling. jsdom has no Web Audio, so one is built here — which also makes
 * the scheduling visible.
 */

interface Node { connect: (to: unknown) => unknown }

/**
 * What a context does when asked to resume: come back ("run"), answer without
 * coming back ("stay" — an iPhone after a call), refuse ("reject" — no gesture),
 * or never answer ("hang" — Chrome holds the promise until a real gesture).
 */
type Resumes = "run" | "stay" | "reject" | "hang";

function makeContext(started: { freq: number; type: string; at: number }[]) {
  const context = {
    state: "running" as string,
    currentTime: 0,
    resumes: "run" as Resumes,
    resume: vi.fn((): Promise<void> => {
      if (context.resumes === "run") {
        context.state = "running";
        return Promise.resolve();
      }
      if (context.resumes === "stay") return Promise.resolve();
      if (context.resumes === "reject") return Promise.reject(new Error("NotAllowedError"));
      return new Promise<void>(() => {});
    }),
    close: vi.fn(() => {
      context.state = "closed";
      return Promise.resolve();
    }),
    destination: {},
    createGain: () => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: (to: unknown) => to,
    }),
    createOscillator: () => {
      const osc = {
        type: "sine",
        frequency: { value: 0 },
        connect: (to: Node) => to,
        start: (at: number) => started.push({ freq: osc.frequency.value, type: osc.type, at }),
        stop: vi.fn(),
      };
      return osc;
    },
  };
  return context;
}

/**
 * A Web Audio that records what it is asked to do.
 *
 * `context` is the first context the module will get; any later `new` makes a
 * fresh one, running, and every context made is in `contexts`.
 */
function fakeAudio() {
  const started: { freq: number; type: string; at: number }[] = [];
  const context = makeContext(started);
  const contexts: ReturnType<typeof makeContext>[] = [];
  // A real function, not an arrow: the module calls `new` on it.
  const ctor = vi.fn(function () {
    const next = contexts.length === 0 ? context : makeContext(started);
    contexts.push(next);
    return next;
  });
  Object.defineProperty(window, "AudioContext", { value: ctor, configurable: true, writable: true });
  return { started, context, ctor, contexts };
}

/** Let the promises a resume hands back settle. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The document says it is on screen, or not. */
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

async function load() {
  vi.resetModules();
  return await import("./sound");
}

/** Whatever a test armed, disarmed after it — even one that failed half-way. */
const armed: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  armed.splice(0).forEach((stop) => stop());
  Reflect.deleteProperty(window, "AudioContext");
  Reflect.deleteProperty(navigator, "audioSession");
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
});

describe("what it plays", () => {
  it("clicks once for a product going in the basket", async () => {
    const audio = fakeAudio();
    const { play } = await load();

    play("add");

    expect(audio.started).toHaveLength(1);
  });

  it("answers a refusal with two notes, the second lower than the first", async () => {
    // Falling is what an ear reads as no, without being taught.
    const audio = fakeAudio();
    const { play } = await load();

    play("refused");

    expect(audio.started).toHaveLength(2);
    expect(audio.started[1].freq).toBeLessThan(audio.started[0].freq);
    expect(audio.started[1].at).toBeGreaterThan(audio.started[0].at);
  });

  it("does not answer a refusal the way it answers a sale", async () => {
    const audio = fakeAudio();
    const { play } = await load();

    play("ok");
    const admitted = audio.started[0].freq;
    play("refused");

    expect(audio.started[1].freq).not.toBe(admitted);
  });

  it("opens one audio context and keeps it", async () => {
    const audio = fakeAudio();
    const { play } = await load();

    play("add");
    play("ok");
    play("refused");

    expect(audio.ctor).toHaveBeenCalledTimes(1);
  });

  it("wakes a context the browser had suspended", async () => {
    const audio = fakeAudio();
    audio.context.state = "suspended";
    const { play } = await load();

    play("add");

    expect(audio.context.resume).toHaveBeenCalled();
  });
});

describe("a cue that finds the audio stopped", () => {
  it("is played once the audio is back", async () => {
    const audio = fakeAudio();
    audio.context.state = "suspended";
    const { play } = await load();

    play("refused");
    expect(audio.started).toHaveLength(0);
    await settle();

    expect(audio.started).toHaveLength(2);
  });

  it("is dropped when the audio comes back too late for it to mean anything", async () => {
    const audio = fakeAudio();
    audio.context.state = "suspended";
    let answer: () => void = () => {};
    audio.context.resume.mockImplementation(() => new Promise<void>((resolve) => {
      answer = () => {
        audio.context.state = "running";
        resolve();
      };
    }));
    const { play, STALE_CUE_MS } = await load();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    play("refused");
    now.mockReturnValue(1_000 + STALE_CUE_MS + 1);
    answer();
    await settle();

    expect(audio.started).toHaveLength(0);
  });

  it("is not kept to come out with the others on whatever tap wakes the audio", async () => {
    // Scheduled on a stopped context, cues queue on its frozen clock: a
    // silent half hour of refusals then played at once, over a ticket that
    // was fine.
    const audio = fakeAudio();
    audio.context.state = "interrupted";
    audio.context.resumes = "stay";
    const { keepSoundReady, play } = await load();
    armed.push(keepSoundReady());
    play("refused");
    play("refused");
    await settle();

    audio.context.resumes = "run";
    window.dispatchEvent(new Event("pointerup"));
    await settle();

    expect(audio.started).toHaveLength(0);
  });

  it("does not leave a refused resume unanswered", async () => {
    // Nothing waits on the promise a refused resume rejects; left unhandled
    // it is an error report per cue on a device whose audio is merely busy.
    // An unhandled rejection fails the suite on its own.
    const audio = fakeAudio();
    audio.context.state = "suspended";
    audio.context.resumes = "reject";
    const { play, unlock } = await load();

    play("ok");
    unlock();
    await settle();

    expect(audio.started).toHaveLength(0);
  });
});

describe("keeping the audio ready", () => {
  it("makes no context before the operator has touched anything", async () => {
    // One made outside a gesture starts stopped, and on some browsers stays so.
    const audio = fakeAudio();
    const { keepSoundReady } = await load();

    armed.push(keepSoundReady());

    expect(audio.ctor).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pointerup"));
    expect(audio.ctor).toHaveBeenCalledTimes(1);
  });

  it("asks again on every tap until the audio runs, not only on the first", async () => {
    // A finger going down is not a gesture a browser accepts for audio — only
    // its coming up is — and the listener this replaced tried once, on the
    // first pointerdown, and never again.
    const audio = fakeAudio();
    audio.context.state = "suspended";
    audio.context.resumes = "hang";
    const { keepSoundReady } = await load();
    armed.push(keepSoundReady());

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("pointerup"));
    expect(audio.context.resume).toHaveBeenCalledTimes(2);

    audio.context.resumes = "run";
    window.dispatchEvent(new Event("click"));
    expect(audio.context.state).toBe("running");

    window.dispatchEvent(new Event("touchend"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(audio.context.resume).toHaveBeenCalledTimes(3);
    expect(audio.ctor).toHaveBeenCalledTimes(1);
  });

  it("treats an iPhone's 'interrupted' like 'suspended'", async () => {
    // A state only WebKit has: what a call or Siri leaves the audio in.
    const audio = fakeAudio();
    audio.context.state = "interrupted";
    const { keepSoundReady, play } = await load();
    armed.push(keepSoundReady());

    window.dispatchEvent(new Event("pointerup"));
    await settle();
    play("refused");

    expect(audio.context.resume).toHaveBeenCalledTimes(1);
    expect(audio.started).toHaveLength(2);
  });

  it("replaces a context that a tap could not bring back", async () => {
    // An iPhone after a call can leave a context that answers every resume
    // and never runs again. A fresh one made inside a gesture always starts.
    const audio = fakeAudio();
    audio.context.state = "interrupted";
    audio.context.resumes = "stay";
    const { keepSoundReady, play } = await load();
    armed.push(keepSoundReady());

    window.dispatchEvent(new Event("pointerup"));
    await settle();
    window.dispatchEvent(new Event("pointerup"));
    play("refused");

    expect(audio.context.close).toHaveBeenCalledTimes(1);
    expect(audio.ctor).toHaveBeenCalledTimes(2);
    expect(audio.contexts[1].state).toBe("running");
    expect(audio.started).toHaveLength(2);
  });

  it("lets go of a stuck context even when closing it fails", async () => {
    // Closing is only a courtesy to the audio hardware; a refusal to close,
    // as a rejection or as a throw, must not keep the old context in place.
    const audio = fakeAudio();
    audio.context.state = "interrupted";
    audio.context.resumes = "stay";
    audio.context.close.mockImplementation(() => Promise.reject(new Error("InvalidStateError")));
    const { keepSoundReady } = await load();
    armed.push(keepSoundReady());
    window.dispatchEvent(new Event("pointerup"));
    await settle();
    window.dispatchEvent(new Event("pointerup"));
    await settle();

    const second = audio.contexts[1];
    second.state = "interrupted";
    second.resumes = "stay";
    second.close.mockImplementation(() => {
      throw new Error("InvalidStateError");
    });
    window.dispatchEvent(new Event("pointerup"));
    await settle();
    window.dispatchEvent(new Event("pointerup"));

    expect(audio.ctor).toHaveBeenCalledTimes(3);
    expect(audio.contexts[2].state).toBe("running");
  });

  it("does the same for a resume that was refused outright", async () => {
    const audio = fakeAudio();
    audio.context.state = "suspended";
    audio.context.resumes = "reject";
    const { keepSoundReady } = await load();
    armed.push(keepSoundReady());

    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    window.dispatchEvent(new Event("pointerup"));

    expect(audio.ctor).toHaveBeenCalledTimes(2);
  });

  it("makes a new context when the old one was closed under it", async () => {
    // A closed context cannot be reopened; asking it to resume is wasted.
    const audio = fakeAudio();
    const { keepSoundReady } = await load();
    armed.push(keepSoundReady());
    window.dispatchEvent(new Event("pointerup"));
    audio.context.state = "closed";

    window.dispatchEvent(new Event("pointerup"));

    expect(audio.ctor).toHaveBeenCalledTimes(2);
    expect(audio.context.resume).not.toHaveBeenCalled();
    expect(audio.contexts[1].state).toBe("running");
  });

  it("asks for the audio back as soon as the app is on screen again", async () => {
    // Back from the lock screen or a call is when iOS hands the audio back,
    // and the next refusal must not wait for somebody to touch the screen.
    const audio = fakeAudio();
    const { keepSoundReady } = await load();
    armed.push(keepSoundReady());
    window.dispatchEvent(new Event("pointerup"));
    audio.context.resumes = "hang";
    window.dispatchEvent(new Event("focus"));
    expect(audio.context.resume).not.toHaveBeenCalled();

    audio.context.state = "suspended";
    visibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(audio.context.resume).not.toHaveBeenCalled();

    visibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("focus"));

    expect(audio.context.resume).toHaveBeenCalledTimes(3);
  });

  it("does not count a refused resume on return as a failed tap", async () => {
    // Without a gesture, "no" is the expected answer: the context is kept
    // for the next tap to wake rather than thrown away.
    const audio = fakeAudio();
    const { keepSoundReady } = await load();
    armed.push(keepSoundReady());
    window.dispatchEvent(new Event("pointerup"));
    audio.context.state = "suspended";
    audio.context.resumes = "reject";

    window.dispatchEvent(new Event("focus"));
    await settle();
    audio.context.resumes = "run";
    window.dispatchEvent(new Event("pointerup"));

    expect(audio.ctor).toHaveBeenCalledTimes(1);
    expect(audio.context.state).toBe("running");
  });

  it("forgets a closed context on return, and makes a new one on the next tap", async () => {
    const audio = fakeAudio();
    const { keepSoundReady } = await load();
    armed.push(keepSoundReady());
    window.dispatchEvent(new Event("pointerup"));
    audio.context.state = "closed";

    window.dispatchEvent(new Event("pageshow"));
    expect(audio.ctor).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pointerup"));

    expect(audio.ctor).toHaveBeenCalledTimes(2);
  });

  it("leaves the audio alone while the sound is switched off", async () => {
    const audio = fakeAudio();
    const { keepSoundReady, setSoundEnabled } = await load();
    setSoundEnabled(false);
    armed.push(keepSoundReady());

    window.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("focus"));

    expect(audio.ctor).not.toHaveBeenCalled();
  });

  it("stops listening when told to", async () => {
    const audio = fakeAudio();
    audio.context.state = "suspended";
    const { keepSoundReady } = await load();
    const stop = keepSoundReady();

    stop();
    window.dispatchEvent(new Event("pointerup"));
    window.dispatchEvent(new Event("focus"));

    expect(audio.ctor).not.toHaveBeenCalled();
  });
});

describe("the switch on a volunteer's phone", () => {
  it("takes the phone off its ringer switch, which is where iOS silences this", async () => {
    // iOS obeys the ring/silent switch for Web Audio unless the page asks for
    // the playback session. A door phone is very often on silent, and the one
    // sound that matters is the one it would swallow.
    fakeAudio();
    const session = { type: "ambient" };
    Object.defineProperty(navigator, "audioSession", { value: session, configurable: true });
    const { play } = await load();

    play("refused");

    expect(session.type).toBe("playback");
  });

  it("says nothing about audio sessions on a browser that has none", async () => {
    fakeAudio();
    const { play } = await load();

    expect(() => play("refused")).not.toThrow();
  });
});

describe("the setting", () => {
  it("is on for a till nobody has configured", async () => {
    const { soundEnabled } = await load();

    expect(soundEnabled()).toBe(true);
  });

  it("stays off across a relaunch", async () => {
    const first = await load();
    first.setSoundEnabled(false);

    const second = await load();

    expect(second.soundEnabled()).toBe(false);
  });

  it("makes no noise once it is off", async () => {
    const audio = fakeAudio();
    const { play, setSoundEnabled } = await load();
    setSoundEnabled(false);

    play("refused");

    expect(audio.started).toHaveLength(0);
  });

  it("comes back on", async () => {
    const audio = fakeAudio();
    const { play, setSoundEnabled } = await load();
    setSoundEnabled(false);
    setSoundEnabled(true);

    play("add");

    expect(audio.started).toHaveLength(1);
  });

  it("holds for the session when storage refuses to keep it", async () => {
    fakeAudio();
    const { play, setSoundEnabled, soundEnabled } = await load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    setSoundEnabled(false);

    expect(soundEnabled()).toBe(false);
    expect(() => play("add")).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe("a device that cannot make a sound", () => {
  it("goes on selling when there is no Web Audio at all", async () => {
    const { play, unlock } = await load();

    expect(() => unlock()).not.toThrow();
    expect(() => play("refused")).not.toThrow();
  });

  it("goes on selling when the context refuses to open", async () => {
    Object.defineProperty(window, "AudioContext", {
      value: vi.fn(function () {
        throw new Error("no audio hardware");
      }),
      configurable: true,
      writable: true,
    });
    const { play } = await load();

    expect(() => play("add")).not.toThrow();
  });

  it("goes on selling when scheduling a note throws", async () => {
    const audio = fakeAudio();
    audio.context.createOscillator = () => {
      throw new Error("context closed");
    };
    const { play } = await load();

    expect(() => play("ok")).not.toThrow();
  });

  it("goes on selling when asking the audio back throws instead of refusing", async () => {
    // What an older engine does with a context it considers dead.
    const audio = fakeAudio();
    audio.context.state = "suspended";
    audio.context.resume.mockImplementation(() => {
      throw new Error("InvalidStateError");
    });
    const { keepSoundReady, play } = await load();
    armed.push(keepSoundReady());

    expect(() => window.dispatchEvent(new Event("pointerup"))).not.toThrow();
    expect(() => play("refused")).not.toThrow();
    await settle();

    expect(audio.started).toHaveLength(0);
  });

  it("keeps the sound on when storage cannot even be read", async () => {
    // A door with no sound is the case this exists for.
    const getItem = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { soundEnabled } = await load();
    getItem.mockRestore();

    expect(soundEnabled()).toBe(true);
  });
});
