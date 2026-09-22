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

function fakeAudio() {
  const started: { freq: number; type: string; at: number }[] = [];
  const context = {
    state: "running" as string,
    currentTime: 0,
    resume: vi.fn(),
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
  // A real function, not an arrow: the module calls `new` on it.
  const ctor = vi.fn(function () {
    return context;
  });
  Object.defineProperty(window, "AudioContext", { value: ctor, configurable: true, writable: true });
  return { started, context, ctor };
}

async function load() {
  vi.resetModules();
  return await import("./sound");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(window, "AudioContext");
  Reflect.deleteProperty(navigator, "audioSession");
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
});
