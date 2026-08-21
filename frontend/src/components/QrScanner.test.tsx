import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { jsQR } = vi.hoisted(() => ({ jsQR: vi.fn() }));
vi.mock("jsqr", () => ({ default: jsQR }));

import { t } from "../i18n";
import QrScanner from "./QrScanner";

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

function track(capabilities: Record<string, unknown> = {}) {
  return {
    stop,
    applyConstraints,
    getSettings,
    getCapabilities: () => capabilities,
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
