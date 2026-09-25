import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { jsQR } = vi.hoisted(() => ({ jsQR: vi.fn() }));
vi.mock("jsqr", () => ({ default: jsQR }));

import { t } from "../i18n";
import QrScanner, { visibleCrop } from "./QrScanner";

/**
 * The camera.
 *
 * jsdom has none, so the browser side is stood up by hand: a fake track whose
 * capabilities can be dictated, a canvas that hands back blank pixels, and an
 * animation frame the test drives itself. What is actually being tested is the
 * behaviour around the decode — that a camera which cannot be opened says which
 * of the three reasons it was, that the lamp button is only offered where there
 * is a lamp and stops being offered the moment it turns out not to work, and
 * that closing the scanner puts the camera out.
 */

let stop: ReturnType<typeof vi.fn>;
let applyConstraints: ReturnType<typeof vi.fn>;
let getSettings: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
/** The pending animation-frame callback, so a test can decide when a frame lands. */
let frame: FrameRequestCallback | null;

/**
 * A stand-in for MediaStreamTrack, listeners included.
 *
 * The listeners are not decoration: the scanner watches for the track ending,
 * because a camera the system takes away leaves a <video> showing its last
 * frame and nothing on screen to say so.
 */
function track(capabilities: Record<string, unknown> = {}) {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    stop,
    applyConstraints,
    getSettings,
    getCapabilities: () => capabilities,
    readyState: "live",
    muted: false,
    addEventListener(name: string, handler: () => void) {
      (listeners[name] ??= []).push(handler);
    },
    removeEventListener(name: string, handler: () => void) {
      listeners[name] = (listeners[name] ?? []).filter((h) => h !== handler);
    },
    /** Test-only: what the browser does when another app takes the camera. */
    end() {
      this.readyState = "ended";
      (listeners.ended ?? []).forEach((handler) => handler());
    },
  };
}

function cameraGives(capabilities: Record<string, unknown> = {}) {
  const video = track(capabilities);
  getUserMedia.mockResolvedValue({
    getVideoTracks: () => [video],
    getTracks: () => [video],
  });
  return video;
}

function show(props: Partial<Parameters<typeof QrScanner>[0]> = {}) {
  const onDecode = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <QrScanner title="Scan" onDecode={onDecode} onClose={onClose} {...props} />,
  );
  return { user: userEvent.setup(), onDecode, onClose, ...view };
}

/** Let one frame of video reach the decoder. */
async function decodeFrame(at = 1000) {
  await act(async () => {
    frame?.(at);
  });
}

beforeEach(() => {
  stop = vi.fn();
  applyConstraints = vi.fn().mockResolvedValue(undefined);
  getSettings = vi.fn().mockReturnValue({});
  getUserMedia = vi.fn();
  frame = null;
  cameraGives();
  jsQR.mockReturnValue(null);

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  // jsdom has no media pipeline at all: a video element that never reports a
  // frame, and a canvas with no 2d context.
  Object.defineProperty(HTMLVideoElement.prototype, "readyState", {
    value: 2, configurable: true,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    value: 1280, configurable: true,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    value: 720, configurable: true,
  });
  HTMLVideoElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
  }) as unknown as HTMLCanvasElement["getContext"];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

describe("opening the camera", () => {
  it("asks for the one on the back of the device", async () => {
    show();

    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ video: { facingMode: { ideal: "environment" } } }),
      ),
    );
  });

  it("says it is starting until the picture arrives", () => {
    show();

    expect(screen.getByText(t("scan.starting"))).toBeDefined();
  });

  it("stops saying so once it has", async () => {
    show();

    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
  });

  it("says when the browser has no camera API to offer", async () => {
    // http:// on a laptop, and every browser that does not do this at all.
    Reflect.deleteProperty(navigator, "mediaDevices");
    show();

    expect(await screen.findByText(t("scan.unsupported"))).toBeDefined();
  });

  it.each(["NotAllowedError", "SecurityError"])(
    "says the permission was refused on a %s",
    async (name) => {
      // Distinct from "no camera": one is fixed in the browser's settings and
      // the other is not fixable at all.
      getUserMedia.mockRejectedValue(new DOMException("no", name));
      show();

      expect(await screen.findByText(t("scan.denied"))).toBeDefined();
    },
  );

  it("says there is no camera for anything else", async () => {
    getUserMedia.mockRejectedValue(new DOMException("gone", "NotFoundError"));
    show();

    expect(await screen.findByText(t("scan.noCamera"))).toBeDefined();
  });

  it("offers the way round it that the caller named", async () => {
    getUserMedia.mockRejectedValue(new DOMException("gone", "NotFoundError"));
    show({ errorHint: "Type the code instead." });

    expect(await screen.findByText("Type the code instead.")).toBeDefined();
  });

  it("offers typing it in when the caller named none", async () => {
    getUserMedia.mockRejectedValue(new DOMException("gone", "NotFoundError"));
    show();

    expect(await screen.findByText(t("scan.manualFallback"))).toBeDefined();
  });

  it("puts the camera out when the scanner is closed", async () => {
    // The lamp goes out with the track; a tab holding a camera open is a tab
    // with a light on it that nobody can find.
    const { unmount } = show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    unmount();

    expect(stop).toHaveBeenCalled();
  });

  it("puts it out even when it arrives after the scanner has gone", async () => {
    // The permission sheet answered a second after the operator gave up.
    let release: (stream: unknown) => void = () => {};
    getUserMedia.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { unmount } = show();
    unmount();

    await act(async () => {
      release({ getVideoTracks: () => [track()], getTracks: () => [track()] });
    });

    expect(stop).toHaveBeenCalled();
  });
});

describe("a camera the system takes away", () => {
  it("takes it back rather than showing a frozen frame", async () => {
    // The failure this exists for is silent: the <video> keeps its last
    // frame, `starting` is false and there is no error, so a door looks like
    // it is scanning and decodes nothing while a queue builds in front of it.
    const camera = cameraGives();
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
    getUserMedia.mockClear();

    await act(async () => {
      camera.end();
    });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  });

  it("checks the camera survived when the screen comes back", async () => {
    const camera = cameraGives();
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
    getUserMedia.mockClear();
    // Muted rather than ended: the state the system leaves behind when it
    // merely suspended the tab, which fires no event of its own.
    camera.muted = true;

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  });

  it("leaves a healthy camera alone when the screen comes back", async () => {
    cameraGives();
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
    getUserMedia.mockClear();

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe("a camera that comes back", () => {
  it("takes the error down and shows the viewfinder again", async () => {
    // Another app held the camera when the door opened; the volunteer locks
    // and unlocks the phone, and the camera is there. The "no camera" box
    // used to stay over the working picture until the scanner was reopened.
    getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    const { container } = show();
    await screen.findByText(t("scan.noCamera"));
    expect(container.querySelector(".scanner-reticle")).toBeNull();

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(screen.queryByText(t("scan.noCamera"))).toBeNull());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".scanner-reticle")).not.toBeNull();
    expect(screen.queryByText(t("scan.starting"))).toBeNull();
  });

  it("reads codes again once it is back", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    jsQR.mockReturnValue({ data: "ticket-secret" });
    const { onDecode } = show();
    await screen.findByText(t("scan.noCamera"));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.queryByText(t("scan.noCamera"))).toBeNull());
    await decodeFrame();

    expect(onDecode).toHaveBeenCalledWith("ticket-secret");
  });

  it("keeps the error up while it tries on its own, rather than flashing it away", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    show();
    await screen.findByText(t("scan.noCamera"));
    let release: (stream: unknown) => void = () => {};
    const camera = track();
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText(t("scan.noCamera"))).toBeDefined();

    await act(async () => {
      release({ getVideoTracks: () => [camera], getTracks: () => [camera] });
    });
    await waitFor(() => expect(screen.queryByText(t("scan.noCamera"))).toBeNull());
  });

  it("offers to try again, and says it is starting the moment that is tapped", async () => {
    // The operator who has just closed the app that held the camera should
    // not have to lock the phone to find out whether that was it.
    getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    let release: (stream: unknown) => void = () => {};
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { user, container } = show();

    await user.click(await screen.findByRole("button", { name: t("scan.retry") }));

    expect(screen.queryByText(t("scan.noCamera"))).toBeNull();
    expect(screen.getByText(t("scan.starting"))).toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    const camera = track();
    await act(async () => {
      release({ getVideoTracks: () => [camera], getTracks: () => [camera] });
    });
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
    expect(container.querySelector(".scanner-reticle")).not.toBeNull();
  });

  it("says so again when trying again did not help", async () => {
    getUserMedia.mockRejectedValue(new DOMException("gone", "NotFoundError"));
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("scan.retry") }));

    expect(await screen.findByText(t("scan.noCamera"))).toBeDefined();
    expect(screen.getByRole("button", { name: t("scan.retry") })).toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("offers it after a refused permission, which can be granted in the meantime", async () => {
    getUserMedia.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    show();

    await screen.findByText(t("scan.denied"));

    expect(screen.getByRole("button", { name: t("scan.retry") })).toBeDefined();
  });

  it("does not offer it to a browser with no camera API, which retrying cannot grow", async () => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    show();

    await screen.findByText(t("scan.unsupported"));

    expect(screen.queryByRole("button", { name: t("scan.retry") })).toBeNull();
  });

  it("does not ask for a second camera while the first is still being asked for", async () => {
    // The screen coming back while the permission sheet is up: the second
    // stream used to replace the first in the scanner's hands, and the first
    // stayed open with nothing left to switch it off.
    let release: (stream: unknown) => void = () => {};
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { unmount } = show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const camera = track();
    await act(async () => {
      release({ getVideoTracks: () => [camera], getTracks: () => [camera] });
    });
    unmount();

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("takes no notice of a track it has already replaced", async () => {
    const first = cameraGives();
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
    const second = cameraGives();
    await act(async () => {
      first.end();
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    // The first one ending again — as a stopped track can — is not the
    // camera going away: the second is the one in use.
    await act(async () => {
      first.end();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(second.readyState).toBe("live");
  });
});

describe("closing the scanner", () => {
  it("starts no frame loop when it was closed while the picture was starting", async () => {
    // The volunteer taps ✕ before the video has started: play() is aborted
    // when the element goes, and the loop it used to start then ran for as
    // long as the app did, decoding a <video> nobody would see again.
    let refuse: (error: unknown) => void = () => {};
    HTMLVideoElement.prototype.play = vi.fn(() => new Promise<void>((_, reject) => {
      refuse = reject;
    }));
    let scheduled = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      scheduled += 1;
      return scheduled;
    });
    const { unmount } = show();
    await waitFor(() => expect(HTMLVideoElement.prototype.play).toHaveBeenCalled());

    unmount();
    await act(async () => {
      refuse(new DOMException("aborted", "AbortError"));
    });

    expect(scheduled).toBe(0);
    expect(stop).toHaveBeenCalled();
  });

  it("lets a frame already on its way end the loop rather than go on", async () => {
    let scheduled = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      scheduled += 1;
      return scheduled;
    });
    // A browser may still deliver the frame it had queued when the loop is
    // cancelled; what matters is that it asks for no other.
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { unmount } = show();
    await waitFor(() => expect(scheduled).toBe(1));
    const queued = frame as FrameRequestCallback;

    unmount();
    queued(5000);

    expect(scheduled).toBe(1);
    expect(jsQR).not.toHaveBeenCalled();
  });
});

describe("reading only what is on screen", () => {
  it("leaves out the sides a phone held upright never shows", () => {
    // A 1280×720 frame in a 390×560 stage: scaled to cover, only a 501-pixel
    // wide band of the middle is on screen.
    const crop = visibleCrop(1280, 720, 390, 560);

    expect(crop.height).toBe(720);
    expect(crop.y).toBe(0);
    expect(crop.width).toBeCloseTo(501.43, 1);
    expect(crop.x).toBeCloseTo((1280 - crop.width) / 2, 5);
  });

  it("leaves out the top and bottom a wide stage never shows", () => {
    const crop = visibleCrop(640, 480, 1180, 600);

    expect(crop.width).toBe(640);
    expect(crop.x).toBe(0);
    expect(crop.height).toBeCloseTo(325.42, 1);
    expect(crop.y).toBeCloseTo((480 - crop.height) / 2, 5);
  });

  it("keeps the whole frame when the stage has its shape", () => {
    expect(visibleCrop(640, 480, 320, 240)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });

  it("keeps the whole frame when the stage has not been laid out", () => {
    expect(visibleCrop(1280, 720, 0, 0)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("decodes the visible part only, at the resolution it always had", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { value: 390, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { value: 560, configurable: true });
    const drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      drawImage,
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    }) as unknown as HTMLCanvasElement["getContext"];
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    await decodeFrame();

    // Half scale, as the whole 1280×720 frame had: 251×360 instead of 640×360.
    expect(jsQR).toHaveBeenCalledWith(expect.anything(), 251, 360, expect.anything());
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = drawImage.mock.calls[0];
    expect(sx).toBeCloseTo(389.29, 1);
    expect(sy).toBe(0);
    expect(sw).toBeCloseTo(501.43, 1);
    expect(sh).toBe(720);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 251, 360]);
  });
});

describe("reading a code", () => {
  it("hands the decoded text to the caller", async () => {
    jsQR.mockReturnValue({ data: "ticket-secret" });
    const { onDecode } = show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    await decodeFrame();

    expect(onDecode).toHaveBeenCalledWith("ticket-secret");
  });

  it("says nothing about a frame with no code in it", async () => {
    const { onDecode } = show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    await decodeFrame();

    expect(onDecode).not.toHaveBeenCalled();
  });

  it("skips the inverted pass, which pretix' codes never need", async () => {
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    await decodeFrame();

    expect(jsQR).toHaveBeenCalledWith(
      expect.anything(), 640, 360, { inversionAttempts: "dontInvert" },
    );
  });

  it("decodes a few times a second rather than every frame", async () => {
    // Full rate buys nothing and takes the main thread away from the interface.
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    await decodeFrame(1000);
    await decodeFrame(1050);

    expect(jsQR).toHaveBeenCalledOnce();
  });

  it("decodes again once the interval has passed", async () => {
    show();
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    await decodeFrame(1000);
    await decodeFrame(1200);

    expect(jsQR).toHaveBeenCalledTimes(2);
  });

  it("stops decoding while the caller holds it", async () => {
    // A verdict on screen freezes the decode without tearing the camera down,
    // so the same ticket is not read again three times while it is being read.
    show({ paused: true });
    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());

    await decodeFrame();

    expect(jsQR).not.toHaveBeenCalled();
  });

  it("does not restart the camera when the caller re-renders", async () => {
    // Every parent passes an inline callback; restarting on each render would
    // make the picture flicker on every verdict.
    const { rerender } = show();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());

    rerender(<QrScanner title="Scan" onDecode={vi.fn()} onClose={vi.fn()} />);

    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});

describe("the lamp", () => {
  it("is offered where the camera has one", async () => {
    cameraGives({ torch: true });
    show();

    expect(await screen.findByRole("button", { name: t("scan.torch") })).toBeDefined();
  });

  it("is not offered where it has none", async () => {
    show();

    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
    expect(screen.queryByRole("button", { name: t("scan.torch") })).toBeNull();
  });

  it("is not offered by a browser too old to say", async () => {
    getUserMedia.mockResolvedValue({
      getVideoTracks: () => [{ stop }],
      getTracks: () => [{ stop }],
    });
    show();

    await waitFor(() => expect(screen.queryByText(t("scan.starting"))).toBeNull());
    expect(screen.queryByRole("button", { name: t("scan.torch") })).toBeNull();
  });

  it("switches on", async () => {
    cameraGives({ torch: true });
    getSettings.mockReturnValue({ torch: true });
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("scan.torch") }));

    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    expect(screen.getByRole("button", { name: t("scan.torch") }).getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("switches off again", async () => {
    cameraGives({ torch: true });
    getSettings.mockReturnValueOnce({ torch: true }).mockReturnValueOnce({ torch: false });
    const { user } = show();
    const button = await screen.findByRole("button", { name: t("scan.torch") });

    await user.click(button);
    await user.click(button);

    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("stops being offered when the camera refuses outright", async () => {
    cameraGives({ torch: true });
    applyConstraints.mockRejectedValue(new DOMException("no", "OverconstrainedError"));
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("scan.torch") }));

    expect(screen.queryByRole("button", { name: t("scan.torch") })).toBeNull();
  });

  it("stops being offered when it says yes and does nothing", async () => {
    // An `advanced` constraint set is best-effort by spec, so the promise
    // resolving proves nothing. A button that does not light anything is worse
    // than no button at all.
    cameraGives({ torch: true });
    getSettings.mockReturnValue({ torch: false });
    const { user } = show();

    await user.click(await screen.findByRole("button", { name: t("scan.torch") }));

    expect(screen.queryByRole("button", { name: t("scan.torch") })).toBeNull();
  });

  it("keeps the button when the lamp will not go out", async () => {
    // A lamp stuck on still needs the button that tries to switch it off.
    cameraGives({ torch: true });
    getSettings.mockReturnValueOnce({ torch: true }).mockReturnValue({ torch: true });
    const { user } = show();
    const button = await screen.findByRole("button", { name: t("scan.torch") });

    await user.click(button);
    await user.click(button);

    expect(screen.getByRole("button", { name: t("scan.torch") })).toBeDefined();
  });
});

describe("what is on screen", () => {
  it("shows the title it was given", () => {
    show({ title: "Scanner un billet" });

    expect(screen.getByText("Scanner un billet")).toBeDefined();
  });

  it("shows the hint under the picture", async () => {
    show({ hint: "Visez le QR code" });

    expect(screen.getByText("Visez le QR code")).toBeDefined();
  });

  it("keeps the hint out of the way when the camera failed", async () => {
    // The error already says what to do; a hint about aiming does not.
    getUserMedia.mockRejectedValue(new DOMException("gone", "NotFoundError"));
    show({ hint: "Visez le QR code" });

    await screen.findByText(t("scan.noCamera"));
    expect(screen.queryByText("Visez le QR code")).toBeNull();
  });

  it("renders the verdict the caller lays over the picture", () => {
    show({ children: <div>Entrée autorisée</div> });

    expect(screen.getByText("Entrée autorisée")).toBeDefined();
  });

  it("puts the caller's banner between the title bar and the picture", () => {
    const { container } = show({ banner: <button className="update-bar">New version</button> });

    const bar = container.querySelector(".scanner-bar");
    const banner = screen.getByRole("button", { name: "New version" });
    expect(bar?.nextElementSibling).toBe(banner);
    expect(banner.nextElementSibling?.classList.contains("scanner-stage")).toBe(true);
  });

  it("renders the caller's footer", () => {
    show({ footer: <button>Saisir le code</button> });

    expect(screen.getByRole("button", { name: "Saisir le code" })).toBeDefined();
  });

  it("closes on the cross", async () => {
    const { user, onClose } = show();

    await user.click(screen.getByRole("button", { name: t("scan.close") }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
