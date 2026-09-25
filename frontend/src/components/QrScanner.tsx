import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

import { t } from "../i18n";

/**
 * Camera QR scanner.
 *
 * Decoding is done in JavaScript rather than through BarcodeDetector, which is
 * simply not an option here: on iOS the Shape Detection API sits behind a
 * Settings feature flag on 17 and has been broken since 18, so a till running
 * on an iPhone would silently never scan anything. jsQR costs ~45 kB and works
 * the same everywhere.
 */

/**
 * Pixels per pixel of the sensor, at most: the frame is scaled so its longest
 * edge is no more than this. Full sensor resolution buys nothing and costs
 * frames.
 */
const DECODE_EDGE = 640;
/** ~8 decodes/s: fast enough to feel instant, slow enough to leave the main thread alone. */
const DECODE_INTERVAL_MS = 120;

/** A rectangle of the video frame, in the frame's own pixels. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of a video frame that is actually on screen.
 *
 * The stage shows the video with `object-fit: cover`: scaled until it fills
 * the box, and the overflow cut off evenly on both sides. On a phone held
 * upright the sensor's frame is much wider than the stage, so a good part of
 * every frame — the strips left and right of what the operator sees — was
 * decoded for nothing: a code nobody can see on screen is not one anybody is
 * aiming. Decoding only the visible part keeps "what you see is what gets
 * read" and hands jsQR fewer pixels for the same result. Benchmarked on
 * synthetic frames, the time follows the pixels: a 16:9 frame on an upright
 * phone shows about a third of itself and decoded in about a third of the
 * time; a 4:3 frame, already close to the stage's shape, leaves little to cut
 * (5–15 % less), and an iPad held sideways sits in between (10–25 %).
 *
 * A box with no size — jsdom, or a layout that has not happened yet — gets the
 * whole frame, which is what was decoded before.
 */
export function visibleCrop(frameW: number, frameH: number, boxW: number, boxH: number): Crop {
  if (!frameW || !frameH || !boxW || !boxH) return { x: 0, y: 0, width: frameW, height: frameH };
  const cover = Math.max(boxW / frameW, boxH / frameH);
  const width = Math.min(frameW, boxW / cover);
  const height = Math.min(frameH, boxH / cover);
  return { x: (frameW - width) / 2, y: (frameH - height) / 2, width, height };
}

interface Props {
  onDecode: (text: string) => void;
  onClose: () => void;
  title: string;
  hint?: string;
  /** Freeze decoding without tearing the camera down (e.g. while showing a verdict). */
  paused?: boolean;
  /** Overlay rendered on top of the video, typically the last scan's verdict. */
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** What to suggest when the camera cannot be opened. */
  errorHint?: string;
  /**
   * A strip between the title bar and the picture — the new-version bar, at a
   * door that never leaves this screen.
   */
  banner?: React.ReactNode;
}

export default function QrScanner({
  onDecode, onClose, title, hint, paused = false, children, footer, errorHint, banner,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  /**
   * Whether trying again could help. Not for a browser that has no camera API
   * at all: no amount of retrying grows one.
   */
  const [retryable, setRetryable] = useState(false);
  /** Set by the camera effect: try to open the camera again, now. */
  const retryRef = useRef<(() => void) | null>(null);
  // Offered only where the camera actually has a lamp to switch on. The track's
  // capabilities are the one honest source for that, and the only one worth
  // asking: whether a torch is there depends on the device and on the browser
  // version, not on the platform — recent iOS Safari reports one where older
  // versions reported nothing at all.
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Read through a ref so the camera is not torn down and restarted every time
  // the parent re-renders with a new closure.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let lastDecode = 0;
    let stopped = false;
    /**
     * A camera is being asked for. One at a time: a second getUserMedia while
     * the first is pending — the screen coming back while the permission sheet
     * is up, a retry tapped twice — used to leave the first stream open behind
     * the second, with nothing left holding it to switch it off.
     */
    let opening = false;

    const fail = (message: string, canRetry: boolean) => {
      setError(message);
      setRetryable(canRetry);
      setStarting(false);
    };

    async function open() {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail(t("scan.unsupported"), false);
        return;
      }
      let next: MediaStream;
      try {
        next = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : "";
        fail(
          name === "NotAllowedError" || name === "SecurityError"
            ? t("scan.denied")
            : t("scan.noCamera"),
          true,
        );
        return;
      }
      if (stopped) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = next;

      const [track] = next.getVideoTracks();
      trackRef.current = track ?? null;
      // A track that ends is the failure this screen cannot afford to hide:
      // the <video> keeps its last frame, `starting` is false and `error` is
      // null, so the door looks like it is scanning and decodes nothing while
      // a queue builds in front of it. The OS ends a track for reasons that
      // have nothing to do with this app — another app taking the camera, a
      // call, a tab suspended long enough.
      // Optional-chained on the method for the same reason getCapabilities is
      // below: this file already meets browsers that do not carry every part
      // of the API, and a scanner that throws on one is worse than a scanner
      // that cannot recover on it. Only for the track still in use: one this
      // screen stopped itself has been replaced already.
      track?.addEventListener?.("ended", () => {
        if (trackRef.current === track) restart(false);
      });
      const capabilities = track?.getCapabilities?.() as
        | (MediaTrackCapabilities & { torch?: boolean })
        | undefined;
      setTorchAvailable(Boolean(capabilities?.torch));

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = next;
      // Required on iOS, where a <video> without it takes over the whole screen.
      video.setAttribute("playsinline", "true");
      try {
        await video.play();
      } catch {
        // Autoplay refusal: the frames still arrive once the element is visible.
        // Or the element was taken away mid-start — hence the check below.
      }
      // Closed while the picture was starting: the teardown has already put
      // the camera out, and a frame loop started now would run for as long as
      // the app does, decoding a <video> nobody will ever see again.
      if (stopped) return;
      // A stream in hand is the camera back, whatever went wrong before: the
      // message that said there was none has to go with it and the viewfinder
      // come back. It used to stay up over a working picture — reticle gone,
      // "no camera" in the middle — until the scanner was closed and reopened.
      setError(null);
      setStarting(false);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    }

    async function start() {
      opening = true;
      try {
        await open();
      } finally {
        opening = false;
      }
    }

    function tick(now: number) {
      if (stopped) return;
      frame = requestAnimationFrame(tick);
      if (pausedRef.current) return;
      if (now - lastDecode < DECODE_INTERVAL_MS) return;
      lastDecode = now;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) return;

      const crop = visibleCrop(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight);
      // Scaled as the whole frame would be, so a code is as many pixels across
      // as it always was and only the part nobody can see is left out.
      const scale = Math.min(1, DECODE_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(crop.width * scale);
      const height = Math.round(crop.height * scale);
      if (!width || !height) return;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

      const result = jsQR(context.getImageData(0, 0, width, height).data, width, height, {
        // pretix prints dark-on-light codes; skipping the inverted pass halves the work.
        inversionAttempts: "dontInvert",
      });
      if (result?.data) onDecodeRef.current(result.data);
    }

    /**
     * Take the camera again — after the system has taken it away, or because
     * the operator asked.
     *
     * Everything is torn down first, including the stream: asking for a second
     * one while the first is still held is how a device ends up with two live
     * tracks and a lamp nobody can put out. `clear` puts "starting" on screen
     * at once in place of the error, for a retry somebody tapped; a restart
     * nobody asked for keeps the error up until there is something better to
     * show, rather than flashing it away and back.
     */
    function restart(clear: boolean) {
      if (stopped || opening) return;
      cancelAnimationFrame(frame);
      frame = 0;
      trackRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setTorchAvailable(false);
      setTorchOn(false);
      setStarting(true);
      if (clear) setError(null);
      void start();
    }

    /**
     * Coming back to the screen is the moment to check the camera survived.
     *
     * `ended` covers the track the system closed outright; this covers the one
     * it merely muted, and it costs nothing when the camera is fine — the
     * check is a flag on a track, not a new stream. A camera that could not
     * be opened is tried again too: the app that was holding it has most
     * likely let go by the time this screen is back in front.
     */
    function onVisible() {
      if (document.visibilityState !== "visible" || stopped) return;
      const track = trackRef.current;
      if (!track || track.readyState === "ended" || track.muted) restart(false);
    }

    retryRef.current = () => restart(true);
    document.addEventListener("visibilitychange", onVisible);
    void start();
    return () => {
      stopped = true;
      retryRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      cancelAnimationFrame(frame);
      trackRef.current = null;
      // Stopping the track puts the lamp out with it; no separate switch-off is
      // needed, and trying would race the teardown.
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };
  }, []);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet & { torch: boolean }],
      });
    } catch {
      // The capability was advertised and then refused. Stop offering a button
      // that does nothing rather than leave the operator pressing it.
      setTorchAvailable(false);
      setTorchOn(false);
      return;
    }

    // An `advanced` constraint set is best-effort by spec: a browser that
    // cannot work the lamp resolves the promise and changes nothing. Read the
    // setting back rather than take the call at its word — and only treat a
    // refusal to light up as a dead button, since a lamp that will not switch
    // off still needs the button that switches it off.
    const applied = (track.getSettings() as MediaTrackSettings & { torch?: boolean }).torch;
    if (next && applied === false) {
      setTorchAvailable(false);
      setTorchOn(false);
      return;
    }
    setTorchOn(applied ?? next);
  }

  return (
    <div className="scanner">
      <div className="scanner-bar">
        <span className="scanner-title">{title}</span>
        <span style={{ flex: 1 }} />
        {torchAvailable && (
          <button
            className={`icon-button${torchOn ? " is-on" : ""}`}
            onClick={() => void toggleTorch()}
            aria-pressed={torchOn}
            aria-label={t("scan.torch")}
            title={t("scan.torch")}
          >
            🔦
          </button>
        )}
        <button className="icon-button" onClick={onClose} aria-label={t("scan.close")}>
          ✕
        </button>
      </div>

      {banner}

      <div className="scanner-stage">
        <video ref={videoRef} className="scanner-video" muted playsInline />
        <canvas ref={canvasRef} style={{ display: "none" }} />

        {!error && <div className="scanner-reticle" aria-hidden="true" />}
        {starting && !error && <div className="scanner-status">{t("scan.starting")}</div>}
        {error && (
          <div className="scanner-status error">
            {error}
            <div className="scanner-status-hint">{errorHint ?? t("scan.manualFallback")}</div>
            {/* The camera comes back on its own when the screen does; this is
                for the operator who has just closed the app that held it and
                should not have to lock the phone to find out. */}
            {retryable && (
              <button className="btn scanner-retry" onClick={() => retryRef.current?.()}>
                {t("scan.retry")}
              </button>
            )}
          </div>
        )}
        {children}
      </div>

      {hint && !error && <div className="scanner-hint">{hint}</div>}
      {footer}
    </div>
  );
}
