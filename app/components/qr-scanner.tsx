"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CircleAlert, Loader2, RotateCcw } from "lucide-react";
import { parseInvitation } from "@/lib/client/crypto";

type NativeQrDetector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type CameraWindow = Window & { BarcodeDetector?: new (options: { formats: string[] }) => NativeQrDetector };

function cameraError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Camera access was denied. Allow camera access for this website in your browser’s site settings, then try again. You can also paste the connection link.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera was found. Open this page on a phone with a camera, or paste the connection link instead.";
  if (name === "NotReadableError" || name === "TrackStartError") return "The camera is busy. Close other apps using it, then try again, or paste the connection link.";
  return "The camera could not start. Check this website’s camera permission and open it in your browser over HTTPS, or paste the connection link.";
}

/** Mounted only after the user presses Scan QR code. Never opens external URLs. */
export function QrScanner({ onResult, onPasteLink }: { onResult: (link: string) => void; onPasteLink: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const resultHandler = useRef(onResult);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [invalidCode, setInvalidCode] = useState(false);
  useEffect(() => { resultHandler.current = onResult; }, [onResult]);

  useEffect(() => {
    let canceled = false;
    let delivered = false;
    let stream: MediaStream | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    function stop() {
      canceled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
    }
    function acceptCode(link: string) {
      if (canceled || delivered) return;
      try { parseInvitation(link, window.location.origin); }
      catch { setInvalidCode(true); return; }
      delivered = true;
      stop();
      resultHandler.current(link);
    }
    function visibilityChanged() {
      if (!document.hidden) return;
      stop();
      setReady(false);
      setError("The camera paused when this tab was hidden. Tap Try again to continue scanning, or paste the link.");
    }
    async function start() {
      setReady(false);
      setError("");
      setInvalidCode(false);
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        setError("Camera scanning needs HTTPS and a browser with camera support. Open this site in Safari or Chrome, or paste the connection link.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (canceled || !video.current) { stream.getTracks().forEach((track) => track.stop()); return; }
        const { default: jsQR } = await import("jsqr");
        if (canceled || !video.current) { stream.getTracks().forEach((track) => track.stop()); return; }
        video.current.srcObject = stream;
        await video.current.play();
        if (canceled) stream.getTracks().forEach((track) => track.stop());
        else {
          setReady(true);
          let detector: NativeQrDetector | null = null;
          try { const NativeDetector = (window as CameraWindow).BarcodeDetector; if (NativeDetector) detector = new NativeDetector({ formats: ["qr_code"] }); } catch { /* jsQR works without the native API. */ }
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d", { willReadFrequently: true });
          const scales = [480, 300, 240, 640, 216, 360];
          let frame = 0;
          let nativeBusy = false;
          // Camera interpolation and large QR modules can defeat a decoder at one
          // resolution. Each timed scan processes one bounded, smaller frame.
          function scanAlternateFrame() {
            if (canceled || !video.current) return;
            if (detector && !nativeBusy) {
              nativeBusy = true;
              // Native camera detection must never block the portable decoders.
              void detector.detect(video.current).then((results) => {
                for (const result of results) acceptCode(result.rawValue.trim());
              }).catch(() => { /* A missing frame uses the portable decoders. */ }).finally(() => { nativeBusy = false; });
            }
            const preview = video.current;
            if (!canceled && preview && context && preview.readyState >= 2 && preview.videoWidth > 0 && preview.videoHeight > 0) {
              const scale = Math.min(1, scales[frame++ % scales.length] / Math.max(preview.videoWidth, preview.videoHeight));
              canvas.width = Math.max(1, Math.round(preview.videoWidth * scale));
              canvas.height = Math.max(1, Math.round(preview.videoHeight * scale));
              context.imageSmoothingEnabled = true;
              context.drawImage(preview, 0, 0, canvas.width, canvas.height);
              try {
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
                const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
                if (result) acceptCode(result.data.trim());
              } catch { /* No complete QR in this frame. Try the next size. */ }
            }
            if (!canceled) fallbackTimer = setTimeout(scanAlternateFrame, 350);
          }
          fallbackTimer = setTimeout(scanAlternateFrame, 150);
        }
      } catch (failure) {
        if (!canceled) { stop(); setError(cameraError(failure)); }
      }
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void start();
    return () => { document.removeEventListener("visibilitychange", visibilityChanged); stop(); };
  }, [attempt]);

  return <div className="qr-scanner">
    <p className="scanner-instructions">Point your camera at the QR code on your other device. Camera access is used only while this scanner is open.</p>
    <div className={`scanner-preview${error ? " has-error" : ""}`}>
      <video ref={video} data-testid="scanner-video" muted autoPlay playsInline aria-label="Live camera preview for scanning a connection QR code" />
      {!error && <><span className="scanner-frame" aria-hidden="true" /><span className="scanner-status">{ready ? <Camera size={16} /> : <Loader2 className="spinning" size={16} />}{ready ? "Looking for a connection QR code…" : "Starting camera…"}</span></>}
      {error && <div className="scanner-error" role="alert"><CircleAlert size={25} /><p>{error}</p></div>}
    </div>
    {invalidCode && !error && <p className="scanner-invalid" role="status">This is not a complete connection QR code from this website. Scan the code shown by your other device.</p>}
    <div className="scanner-actions">{error && <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={16} />Try again</button>}<button className="button primary" onClick={onPasteLink}>Paste a link instead</button></div>
  </div>;
}
