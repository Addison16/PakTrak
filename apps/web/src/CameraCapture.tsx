import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { cameraError, capturePhoto, stillCamera, type CameraAdjustments, type CameraCapabilities, type CameraSettings } from "./camera";
import "./camera.css";
import { useNavigationGuard } from "./navigation";

type Photo = { file: File; url: string; source: "still" | "frame" };
type CameraChoice = { id: string; label: string };
const cameraPreference = "paktrak.camera-device";
function preferredCamera() {
  try { return localStorage.getItem(cameraPreference) || ""; } catch { return ""; }
}
function rememberCamera(id: string) {
  try { if (id) localStorage.setItem(cameraPreference, id); else localStorage.removeItem(cameraPreference); } catch { /* Private browsing may disable storage. */ }
}
type Props = {
  progress: number | null; uploadError: string;
  onClose: () => void; onNativeCamera: () => void; onChoosePhoto: () => void;
  onUpload: (file: File, next?: boolean) => Promise<boolean>;
  onCapture?: (file: File) => Promise<void>; onDiscard?: () => Promise<void>;
};

export default function CameraCapture({ progress, uploadError, onClose, onNativeCamera, onChoosePhoto, onUpload, onCapture, onDiscard }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const cameraSelect = useRef<HTMLSelectElement>(null);
  const focusCameraChoice = useRef(false);
  const stream = useRef<MediaStream | null>(null);
  const stop = useRef<() => void>(() => {});
  const generation = useRef(0);
  const capturing = useRef(false);
  const captureSequence = useRef(0);
  const submitting = useRef(false);
  // Set while this component closes its own dialog, so the close event is not treated as a browser-initiated close.
  const closing = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"opening" | "live" | "paused" | "error">("opening");
  const [error, setError] = useState("");
  const [controlsError, setControlsError] = useState("");
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({});
  const [settings, setSettings] = useState<CameraSettings>({});
  const [deviceId, setDeviceId] = useState(preferredCamera);
  const [cameras, setCameras] = useState<CameraChoice[]>([]);
  const [cameraList, setCameraList] = useState<"loading" | "ready" | "unavailable">("loading");
  const [cameraNotice, setCameraNotice] = useState("");
  const [activeCameraLabel, setActiveCameraLabel] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [hasStillCamera, setHasStillCamera] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [guides, setGuides] = useState(false);
  const [taking, setTaking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attemptedUpload, setAttemptedUpload] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoSize, setPhotoSize] = useState({ width: 0, height: 0 });
  const [enlarged, setEnlarged] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  // After "take another", the saved photo shrinks away toward the bottom while the camera reopens.
  const [dropping, setDropping] = useState<string | null>(null);
  useEffect(() => { if (!dropping) return; const timer = window.setTimeout(() => setDropping(null), 700); return () => { clearTimeout(timer); URL.revokeObjectURL(dropping); }; }, [dropping]);

  useNavigationGuard((from, to) => {
    if (from.overlay !== "camera" || to.overlay === "camera") return true;
    if (submitting.current || capturing.current) return false;
    if (!photo) return true;
    if (!window.confirm("Discard this photo? It hasn't finished uploading to your batches.")) return false;
    void onDiscard?.();
    return true;
  });

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyOverflow = document.body.style.overflow, rootOverflow = document.documentElement.style.overflow, rootGutter = document.documentElement.style.scrollbarGutter;
    element.showModal(); heading.current?.focus();
    document.body.style.overflow = "hidden"; document.documentElement.style.overflow = "hidden";
    // The camera fills the screen, so give it the scrollbar space too.
    document.documentElement.style.scrollbarGutter = "auto";
    return () => {
      closing.current = true; element.close(); stop.current();
      document.body.style.overflow = bodyOverflow; document.documentElement.style.overflow = rootOverflow; document.documentElement.style.scrollbarGutter = rootGutter;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!photo) return;
    heading.current?.focus();
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => { URL.revokeObjectURL(photo.url); window.removeEventListener("beforeunload", warn); };
  }, [photo]);

  useEffect(() => {
    if (phase === "live" && focusCameraChoice.current) {
      cameraSelect.current?.focus({ preventScroll: true }); focusCameraChoice.current = false;
    }
  }, [phase]);

  useEffect(() => {
    if (photo) return;
    let cancelled = false;
    let owned: MediaStream | null = null;
    let timer: number | undefined;
    let listRequest = 0;
    const element = video.current!;
    const devices = navigator.mediaDevices;
    const teardown = () => {
      cancelled = true; generation.current += 1;
      window.clearTimeout(timer);
      element.pause();
      owned?.getTracks().forEach((track) => { track.onended = null; track.onmute = null; track.onunmute = null; track.stop(); });
      if (stream.current === owned) stream.current = null;
      element.srcObject = null;
    };
    stop.current = teardown;
    const pause = () => {
      teardown(); captureSequence.current += 1; setPhase("paused"); setTaking(false); capturing.current = false; setAdjusting(false);
    };
    const visibility = () => { if (document.hidden) pause(); };
    async function refreshCameras() {
      if (cancelled || !owned) return;
      const request = ++listRequest;
      try {
        const available = await devices.enumerateDevices();
        if (cancelled || request !== listRequest) return;
        const unique = [...new Map(available.filter((device) => device.kind === "videoinput" && device.deviceId).map((device) => [device.deviceId, device])).values()];
        const labels = unique.map((device, index) => device.label.trim() || `Camera ${index + 1}`);
        setCameras(unique.map((device, index) => ({ id: device.deviceId, label: labels.filter((label) => label === labels[index]).length > 1 ? `${labels[index]} (${index + 1})` : labels[index] })));
        setCameraList("ready");
      } catch { if (!cancelled && request === listRequest) setCameraList("unavailable"); }
    }
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pause);
    devices?.addEventListener("devicechange", refreshCameras);
    setPhase("opening"); setError(""); setControlsError(""); setCapabilities({}); setSettings({}); setHasStillCamera(false); setAdjusting(false); setDimensions({ width: 0, height: 0 }); setCameraList("loading");
    if (!focusCameraChoice.current) heading.current?.focus({ preventScroll: true });
    async function open() {
      if (document.hidden) { pause(); return; }
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError("The in-app camera needs a supported browser and an HTTPS connection. You can still use Phone camera or choose a saved photo.");
        setPhase("error"); return;
      }
      try {
        owned = await devices.getUserMedia({ audio: false, video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
          width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 24, max: 30 },
        } });
        if (cancelled) { owned.getTracks().forEach((track) => track.stop()); return; }
        stream.current = owned;
        const track = owned.getVideoTracks()[0];
        if (!track) throw new Error("No video track.");
        const actual = track.getSettings();
        if (deviceId && actual.deviceId && actual.deviceId !== deviceId) throw new DOMException("Selected camera was not opened.", "OverconstrainedError");
        setCapabilities(track.getCapabilities?.() || {}); setSettings(actual); setActiveCameraLabel(track.label);
        setHasStillCamera(!!stillCamera(track));
        void refreshCameras();
        track.onended = pause;
        track.onmute = () => { if (!capturing.current) pause(); };
        element.muted = true; element.playsInline = true;
        // Let a newly opened/unhidden video establish its rendering surface
        // before starting playback, including after a photo review on WebKit.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (cancelled) return;
        element.srcObject = owned;
        timer = window.setTimeout(() => {
          if (!cancelled && element.readyState < 2) {
            teardown(); setPhase("error"); setError("The camera opened without a picture. Try again, or use Phone camera.");
          }
        }, 12000);
        await element.play();
        if (!cancelled && element.readyState >= 2) { setPhase("live"); rememberCamera(deviceId); }
      } catch (reason) {
        if (cancelled) return;
        teardown();
        if (deviceId && (reason instanceof DOMException || reason instanceof Error) && ["NotFoundError", "OverconstrainedError", "NotReadableError", "AbortError"].includes(reason.name)) {
          rememberCamera(""); setDeviceId(""); setCameraNotice("That camera isn't available right now. Switched to Automatic; check the preview before taking your photo.");
        } else { setError(cameraError(reason)); setPhase("error"); }
      }
    }
    // Defer one microtask so React's development StrictMode does not request two cameras.
    void Promise.resolve().then(() => { if (!cancelled) return open(); });
    return () => { teardown(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pause); devices?.removeEventListener("devicechange", refreshCameras); };
  }, [attempt, photo, deviceId]);

  function chooseCamera(id: string) {
    if (photo || capturing.current || submitting.current || adjusting || phase === "opening" || id === deviceId) return;
    stop.current(); setPhase("opening"); setCameraNotice(""); focusCameraChoice.current = true; setDeviceId(id);
  }

  async function close(action = onClose) {
    if (submitting.current || capturing.current) return;
    if (photo && !window.confirm("Discard this photo? It hasn't finished uploading to your batches.")) return;
    if (photo) {
      capturing.current = true; setTaking(true);
      try { await onDiscard?.(); }
      catch { setError("This photo could not be discarded yet. Please try again."); return; }
      finally { capturing.current = false; setTaking(false); }
    }
    stop.current(); action();
  }

  async function retake() {
    if (submitting.current || capturing.current) return;
    capturing.current = true; setTaking(true);
    try { await onDiscard?.(); setPhoto(null); setError(""); setAttemptedUpload(false); }
    catch { setError("This photo could not be discarded yet. Please try again."); }
    finally { capturing.current = false; setTaking(false); }
  }

  function resize() {
    const element = video.current;
    if (element?.videoWidth && element.videoHeight) setDimensions({ width: element.videoWidth, height: element.videoHeight });
  }

  async function take() {
    const track = stream.current?.getVideoTracks()[0], element = video.current;
    if (phase !== "live" || !track || !element || capturing.current || adjusting) return;
    capturing.current = true; setTaking(true); setError("");
    const sequence = ++captureSequence.current;
    const token = generation.current;
    try {
      const result = await capturePhoto(element, track);
      if (token !== generation.current) return;
      stop.current(); setPhotoSize({ width: 0, height: 0 }); setEnlarged(false);
      setPhoto({ ...result, url: URL.createObjectURL(result.file) });
      await onCapture?.(result.file);
    } catch (reason) {
      if (token === generation.current) setError((reason as Error).message);
    } finally { if (sequence === captureSequence.current) { capturing.current = false; setTaking(false); } }
  }

  async function adjust(value: CameraAdjustments) {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || adjusting || taking) return;
    setAdjusting(true); setControlsError("");
    const token = generation.current;
    try {
      await track.applyConstraints({ advanced: [value] });
      if (token !== generation.current) return;
      const actual = track.getSettings() as CameraSettings;
      setSettings(actual);
      if ((value.torch !== undefined && actual.torch !== value.torch) || (value.zoom !== undefined && (actual.zoom === undefined || Math.abs(actual.zoom - value.zoom) > .15))) {
        setControlsError("This camera didn't apply that setting. Try Phone camera for more controls.");
      }
    } catch {
      if (token === generation.current) setControlsError("That setting isn't available right now. Try Phone camera for more controls.");
    } finally { if (token === generation.current) setAdjusting(false); }
  }

  async function upload(next = false) {
    if (!photo || submitting.current) return;
    submitting.current = true; setUploading(true); setAttemptedUpload(true);
    try {
      if (!await onUpload(photo.file, next)) return;
      if (!next) { onClose(); return; }
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setDropping(URL.createObjectURL(photo.file));
      setUploaded((count) => count + 1); setPhoto(null); setAttemptedUpload(false); setError("");
    }
    finally { submitting.current = false; setUploading(false); }
  }

  const ready = phase === "live" && dimensions.width > 0;
  const zoom = capabilities.zoom;
  const zoomStops = zoom && zoom.min > 0 && zoom.max > zoom.min ? [...new Set([zoom.min, 1, 2, 3].filter((value) => value >= zoom.min && value <= zoom.max).map((value) => Math.min(zoom.max, zoom.min + Math.round((value - zoom.min) / (zoom.step || .1)) * (zoom.step || .1))))] : [];
  const w = dimensions.width || 4, h = dimensions.height || 3;

  // Chromium's close watcher may close the dialog outright on a repeated Escape without a cancelable cancel event.
  // Keep the dialog open while a photo is pending or work is in progress; otherwise tear down like close().
  function closedByBrowser() {
    if (closing.current) return;
    const element = dialog.current;
    if (photo || capturing.current || submitting.current) { if (element && !element.open) element.showModal(); return; }
    stop.current(); onClose();
  }

  return <dialog ref={dialog} className="camera-dialog" aria-labelledby="camera-title" onCancel={(event) => { event.preventDefault(); void close(); }} onClose={closedByBrowser}>
    <header className="camera-heading">
      <div><span className="eyebrow">PAKTRAK CAMERA</span><h2 ref={heading} tabIndex={-1} id="camera-title">{photo ? "Check your photo" : "Make every card clear."}</h2></div>
      <button type="button" className="menu-close" aria-label="Close camera" disabled={uploading || taking} onClick={() => void close()}><Icon name="close" /></button>
    </header>
    <div className="camera-stage">
      {dropping && <img className="camera-drop" src={dropping} alt="" aria-hidden="true" />}
      <video ref={video} hidden={!!photo} autoPlay muted playsInline aria-label="Live camera preview" onResize={resize} onLoadedData={resize} onPlaying={() => {
        if (stream.current?.active) { resize(); setPhase("live"); }
      }} />
      {photo ? <div className="camera-photo-scroll" data-enlarged={enlarged || undefined} tabIndex={0} role="region" aria-label="Captured photo. Enlarge to check card text.">
        <img src={photo.url} alt="Your captured cards" onLoad={(event) => setPhotoSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError("This photo couldn't be previewed. Retake it or use Phone camera.")} />
      </div> : <>
        {ready && guides && <svg className="camera-guides" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <path className="camera-guide-thirds" d={`M${w / 3} 0V${h}M${2 * w / 3} 0V${h}M0 ${h / 3}H${w}M0 ${2 * h / 3}H${w}`} />
          <path d={`M${.12 * w} ${.035 * h}H${.035 * w}V${.12 * h}M${.88 * w} ${.035 * h}H${.965 * w}V${.12 * h}M${.035 * w} ${.88 * h}V${.965 * h}H${.12 * w}M${.88 * w} ${.965 * h}H${.965 * w}V${.88 * h}`} />
        </svg>}
        {phase !== "live" && <div className="camera-placeholder" role="status"><Icon name="camera" /><h3>{phase === "opening" ? "Opening your camera…" : phase === "paused" ? "Camera paused" : "Use another capture option"}</h3><p>{phase === "opening" ? "Allow camera access when your browser asks. Your microphone stays off." : phase === "paused" ? "Resume when you're ready to take a photo." : error}</p>
          {phase !== "opening" && <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>{phase === "paused" ? "Resume camera" : "Try again"}</button>}
        </div>}
      </>}
    </div>
    <div className="camera-controls">
      <div className="camera-copy">
        <strong>{photo ? "Check the edges, text and reflections." : uploaded ? `${uploaded} ${uploaded === 1 ? "photo" : "photos"} saved as batches. Ready for the next one.` : "Keep every edge in view. Leave space between cards."}</strong>
        <p>{photo ? `${photoSize.width ? `${photoSize.width} × ${photoSize.height} · ` : ""}${uploading ? "Uploading" : "Awaiting upload"}` : ready ? `${dimensions.width} × ${dimensions.height} live view · Hold steady` : "Your photo is uploaded only after you confirm it."}</p>
      </div>
      {error && phase !== "error" && <p className="camera-feedback" role="alert">{error}</p>}
      {controlsError && <p className="camera-feedback" role="status">{controlsError}</p>}
      {photo ? <>
        <button className="text-button camera-inspect" aria-pressed={enlarged} onClick={() => setEnlarged(!enlarged)}>{enlarged ? "Show whole photo" : "Enlarge to check details"}</button>
        {uploadError && attemptedUpload && !uploading && <p className="camera-feedback" role="alert">{uploadError} Your captured photo is kept here so you can retry.</p>}
        {photoSize.width * photoSize.height > 60_000_000 && <p className="camera-feedback" role="alert">This photo is larger than the 60-megapixel limit. Use Phone camera and select a smaller photo size.</p>}
        {uploading && <div className="camera-upload" role="status"><p>{progress === null ? "Waiting for server acceptance…" : `Uploading ${progress}%…`} Keep this page open.</p>{progress !== null && <progress value={progress} max={100} aria-label="Camera photo upload progress" />}</div>}
        <div className="camera-review-actions"><button className="button secondary" disabled={uploading || taking} onClick={() => void retake()}>Retake</button><button className="button primary" disabled={uploading || taking || !photoSize.width || photoSize.width * photoSize.height > 60_000_000} onClick={() => void upload()}>{uploading ? "Uploading…" : "Upload & scan"}<Icon name="arrow" /></button></div>
        <button className="text-button camera-next" disabled={uploading || taking || !photoSize.width || photoSize.width * photoSize.height > 60_000_000} onClick={() => void upload(true)}>Upload & take another photo</button>
      </> : <>
        {(cameras.length > 0 || deviceId) && <div className="camera-device">
          <label htmlFor="camera-device">Camera</label>
          <select ref={cameraSelect} id="camera-device" aria-describedby="camera-device-help" value={deviceId} disabled={phase === "opening" || taking || adjusting} onChange={(event) => chooseCamera(event.target.value)}>
            <option value="">Automatic · rear camera</option>
            {deviceId && !cameras.some((camera) => camera.id === deviceId) && <option value={deviceId}>{activeCameraLabel || "Saved camera"}</option>}
            {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}
          </select>
          <p id="camera-device-help">{cameraList !== "ready" ? "Your choice is remembered on this device." : cameras.length > 1 ? "Compare lenses for clearer card text. Your choice is remembered on this device." : "Only one camera is available here. Phone camera may offer more lenses."}</p>
          {ready && !deviceId && activeCameraLabel && <span className="camera-current">Using {activeCameraLabel}</span>}
        </div>}
        {cameraList === "unavailable" && <p className="camera-feedback" role="status">Camera choices couldn't be loaded. You can keep taking photos, or use Phone camera for more lens options.</p>}
        {cameraNotice && <p className="camera-feedback" role="status">{cameraNotice}</p>}
        {ready && (capabilities.torch || zoomStops.length > 1) && <div className="camera-adjustments">
          {capabilities.torch && <button className="camera-option" aria-pressed={settings.torch === true} disabled={taking || adjusting} onClick={() => void adjust({ torch: !settings.torch })}><Icon name="light" />Light {settings.torch ? "on" : "off"}</button>}
          {zoomStops.length > 1 && <div className="camera-zoom" role="group" aria-label="Camera zoom">{zoomStops.map((value) => <button key={value} className="camera-option" aria-label={`Zoom ${Number(value.toFixed(1))}×`} aria-pressed={Math.abs((settings.zoom ?? zoom!.min) - value) < .05} disabled={taking || adjusting} onClick={() => void adjust({ zoom: value })}>{Number(value.toFixed(1))}×</button>)}</div>}
        </div>}
        <div className="camera-shutter-row">
          <button className="camera-side-control" aria-pressed={guides} onClick={() => setGuides(!guides)}><Icon name="frame" />Guides</button>
          <button className="camera-shutter" aria-label="Capture photo" disabled={!ready || taking || adjusting} onClick={() => void take()}><span>{taking ? "…" : <Icon name="camera" />}</span></button>
          <button className="camera-side-control" disabled={taking} onClick={() => void close(onChoosePhoto)}><Icon name="image" />Library</button>
        </div>
      </>}
      <div className="camera-native"><button className="text-button" disabled={uploading || taking} onClick={() => void close(onNativeCamera)}><Icon name="camera" />Phone camera <Icon name="arrow" /></button><p>{photo?.source === "frame" ? "This is a live-view photo. Use Phone camera for more detail." : !photo && !hasStillCamera ? "For full-resolution photos and large batches." : "More camera options and full-resolution photos."}</p></div>
    </div>
  </dialog>;
}
