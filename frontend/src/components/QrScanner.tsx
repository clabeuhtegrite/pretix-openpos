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

/** Longest edge fed to the decoder. Full sensor resolution buys nothing and costs frames. */
const DECODE_EDGE = 640;
/** ~8 decodes/s: fast enough to feel instant, slow enough to leave the main thread alone. */
const DECODE_INTERVAL_MS = 120;

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
}

export default function QrScanner({
  onDecode, onClose, title, hint, paused = false, children, footer, errorHint,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
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
    let restarting = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(t("scan.unsupported"));
        setStarting(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        setError(
          name === "NotAllowedError" || name === "SecurityError"
            ? t("scan.denied")
            : t("scan.noCamera"),
        );
        setStarting(false);
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const [track] = stream.getVideoTracks();
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
      // that cannot recover on it.
      track?.addEventListener?.("ended", () => void restart());
      const capabilities = track?.getCapabilities?.() as
        | (MediaTrackCapabilities & { torch?: boolean })
        | undefined;
      setTorchAvailable(Boolean(capabilities?.torch));

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      // Required on iOS, where a <video> without it takes over the whole screen.
      video.setAttribute("playsinline", "true");
      try {
        await video.play();
      } catch {
        // Autoplay refusal: the frames still arrive once the element is visible.
      }
      setStarting(false);
      frame = requestAnimationFrame(tick);
    }

    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      if (pausedRef.current) return;
      if (now - lastDecode < DECODE_INTERVAL_MS) return;
      lastDecode = now;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) return;

      const scale = Math.min(1, DECODE_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (!width || !height) return;

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);

      const result = jsQR(context.getImageData(0, 0, width, height).data, width, height, {
        // pretix prints dark-on-light codes; skipping the inverted pass halves the work.
        inversionAttempts: "dontInvert",
      });
      if (result?.data) onDecodeRef.current(result.data);
    }

    /**
     * Take the camera again after the system has taken it away.
     *
     * Everything is torn down first, including the stream: asking for a second
     * one while the first is still held is how a device ends up with two live
     * tracks and a lamp nobody can put out.
     */
    async function restart() {
      if (stopped || restarting) return;
      restarting = true;
      cancelAnimationFrame(frame);
      trackRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      setStarting(true);
      try {
        await start();
      } finally {
        restarting = false;
      }
    }

    /**
     * Coming back to the screen is the moment to check the camera survived.
     *
     * `ended` covers the track the system closed outright; this covers the one
     * it merely muted, and it costs nothing when the camera is fine — the
     * check is a flag on a track, not a new stream.
     */
    function onVisible() {
      if (document.visibilityState !== "visible" || stopped) return;
      const track = trackRef.current;
      if (!track || track.readyState === "ended" || track.muted) void restart();
    }

    document.addEventListener("visibilitychange", onVisible);
    void start();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      cancelAnimationFrame(frame);
      trackRef.current = null;
      // Stopping the track puts the lamp out with it; no separate switch-off is
      // needed, and trying would race the teardown.
      stream?.getTracks().forEach((track) => track.stop());
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

      <div className="scanner-stage">
        <video ref={videoRef} className="scanner-video" muted playsInline />
        <canvas ref={canvasRef} style={{ display: "none" }} />

        {!error && <div className="scanner-reticle" aria-hidden="true" />}
        {starting && !error && <div className="scanner-status">{t("scan.starting")}</div>}
        {error && (
          <div className="scanner-status error">
            {error}
            <div className="scanner-status-hint">{errorHint ?? t("scan.manualFallback")}</div>
          </div>
        )}
        {children}
      </div>

      {hint && !error && <div className="scanner-hint">{hint}</div>}
      {footer}
    </div>
  );
}
