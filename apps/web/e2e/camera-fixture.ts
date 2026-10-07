import { expect, type Page } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

type FixtureCamera = { id: string; label: string; controls?: boolean; width?: number; height?: number };
export async function installCamera(page: Page, options: { denied?: string; missing?: boolean; delayed?: boolean; controls?: boolean; still?: "works" | "fails" | "delayed"; stillPhoto?: { base64: string; type: string; width: number; height: number }; cameras?: FixtureCamera[]; savedCamera?: string; enumeration?: "fails" | "missing"; failCamera?: string; delayedCamera?: string; storageBlocked?: boolean } = {}) {
  await page.addInitScript((options) => {
    const stats = { requests: [] as any[], activeAtRequest: [] as number[], enumerations: 0, stopped: 0, active: 0, adjustments: [] as any[], stills: 0, stillDevices: [] as string[], stillsCompleted: 0, photoSettings: null as any, sent: [] as any[], revoked: 0 };
    const control: any = { stats, pending: [], pendingPhotos: [], tracks: [], rejectSettings: false, cameras: options.cameras || [{ id: "back-main", label: "Back camera" }] };
    (window as any).cameraFixture = control;
    if (options.savedCamera) localStorage.setItem("paktrak.camera-device", options.savedCamera);
    if (options.storageBlocked) {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
      Storage.prototype.getItem = function (key) { if (key === "paktrak.camera-device") throw new DOMException("Blocked", "SecurityError"); return get.call(this, key); };
      Storage.prototype.setItem = function (key, value) { if (key === "paktrak.camera-device") throw new DOMException("Blocked", "SecurityError"); set.call(this, key, value); };
      Storage.prototype.removeItem = function (key) { if (key === "paktrak.camera-device") throw new DOMException("Blocked", "SecurityError"); remove.call(this, key); };
    }
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { stats.revoked++; revoke.call(URL, url); };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      if (body instanceof Blob) {
        const record = { size: body.size, type: body.type, hash: null as string | null }; stats.sent.push(record);
        void body.arrayBuffer().then((data) => crypto.subtle.digest("SHA-256", data)).then((hash) => { record.hash = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join(""); });
      }
      return send.call(this, body);
    };
    function draw(canvas: HTMLCanvasElement) {
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#263f35"; context.fillRect(0, 0, canvas.width, canvas.height);
      // Original synthetic card-shaped tiles. No copyrighted card art or user holdings.
      const unit = canvas.width / 960;
      for (let i = 0; i < 15; i++) {
        const x = (70 + i % 3 * 280) * unit, y = (60 + Math.floor(i / 3) * 230) * unit;
        context.fillStyle = i % 2 ? "#e4c68c" : "#e7e0ce"; context.fillRect(x, y, 220 * unit, 205 * unit);
        context.fillStyle = "#264e43"; context.fillRect(x + 16 * unit, y + 40 * unit, 188 * unit, 95 * unit);
        context.font = `${18 * unit}px sans-serif`; context.fillText(`Sample card ${i + 1}`, x + 16 * unit, y + 27 * unit);
        context.fillStyle = "#897757"; context.fillRect(x + 16 * unit, y + 154 * unit, 170 * unit, 6 * unit);
        context.fillRect(x + 16 * unit, y + 171 * unit, 135 * unit, 6 * unit);
      }
    }
    const getUserMedia = async (constraints: any) => {
      stats.requests.push(constraints); stats.activeAtRequest.push(stats.active);
      if (options.denied) throw new DOMException("Synthetic camera failure", options.denied);
      const id = constraints.video.deviceId?.exact;
      const camera: FixtureCamera | undefined = id ? control.cameras.find((device: FixtureCamera) => device.id === id) : control.cameras[0];
      if (!camera) throw new DOMException("Camera no longer available", "OverconstrainedError");
      if (id && id === options.failCamera) throw new DOMException("Selected camera busy", "NotReadableError");
      if (options.delayed || id && id === options.delayedCamera) await new Promise<void>((resolve) => control.pending.push(resolve));
      const canvas = document.createElement("canvas"); canvas.width = camera.width || 960; canvas.height = camera.height || 1280; draw(canvas);
      // WebKit canvas-stream producers need a rendered source to deliver frames
      // reliably. The physical-camera implementation does not use captureStream.
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.position = "fixed"; canvas.style.top = "0"; canvas.style.left = "0";
      canvas.style.width = "1px"; canvas.style.height = "1px"; canvas.style.opacity = ".01"; canvas.style.pointerEvents = "none";
      (document.querySelector("dialog[open]") || document.body).append(canvas);
      const stream = canvas.captureStream(12), track = stream.getVideoTracks()[0];
      control.tracks.push(track); stats.active++;
      let frame = 0;
      const interval = setInterval(() => {
        draw(canvas);
        // A live camera is never an identical frame forever. Keep WebKit from
        // suppressing delivery of this otherwise perfectly static canvas.
        const context = canvas.getContext("2d")!;
        context.fillStyle = ++frame % 2 ? "#294238" : "#263f35";
        context.fillRect(canvas.width - 20, canvas.height - 20, 5, 5);
        context.getImageData(0, 0, 1, 1); // Flush the synthetic producer before requesting a frame.
        (track as CanvasCaptureMediaStreamTrack).requestFrame?.();
      }, 80);
      let stopped = false;
      const stop = track.stop.bind(track);
      track.stop = () => { if (!stopped) { stopped = true; stats.stopped++; stats.active--; clearInterval(interval); canvas.remove(); } stop(); };
      const hasControls = camera.controls ?? options.controls;
      const settings: any = { width: canvas.width, height: canvas.height, deviceId: camera.id, facingMode: "environment", ...(hasControls ? { torch: false, zoom: 1 } : {}) };
      Object.defineProperty(track, "label", { configurable: true, value: camera.label });
      track.getCapabilities = () => hasControls ? { torch: true, zoom: { min: 1, max: 3, step: .1 } } as any : {};
      track.getSettings = () => ({ ...settings });
      track.applyConstraints = async (constraints: any) => {
        stats.adjustments.push(constraints);
        if (control.rejectSettings) throw new DOMException("Unsupported", "OverconstrainedError");
        Object.assign(settings, constraints.advanced[0]);
      };
      return stream;
    };
    if (options.missing) Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    else {
      // WebKit may replace an otherwise unreferenced DOM wrapper. Keep this
      // instance alive so its test override never falls through to real hardware.
      const devices = navigator.mediaDevices;
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
      Object.defineProperty(devices, "getUserMedia", { configurable: true, value: getUserMedia });
      Object.defineProperty(devices, "enumerateDevices", { configurable: true, value: options.enumeration === "missing" ? undefined : async () => {
        stats.enumerations++;
        if (options.enumeration === "fails") throw new DOMException("Enumeration unavailable", "NotAllowedError");
        return [
          ...control.cameras.map((camera: FixtureCamera) => ({ deviceId: camera.id, label: stats.requests.length ? camera.label : "", kind: "videoinput" })),
          { deviceId: "microphone", label: "Microphone", kind: "audioinput" },
        ];
      } });
    }
    Object.defineProperty(window, "ImageCapture", { configurable: true, value: options.still ? class {
      constructor(private track: MediaStreamTrack) {}
      async getPhotoCapabilities() { return { imageWidth: { max: options.stillPhoto?.width ?? 1920 }, imageHeight: { max: options.stillPhoto?.height ?? 2560 } }; }
      async takePhoto(settings: any) {
        stats.stills++; stats.photoSettings = settings; stats.stillDevices.push(this.track.getSettings().deviceId || "");
        if (options.still === "fails") throw new DOMException("Not implemented", "NotSupportedError");
        if (options.still === "delayed") await new Promise<void>((resolve) => control.pendingPhotos.push(resolve));
        if (options.stillPhoto) {
          stats.stillsCompleted++;
          return new Blob([Uint8Array.from(atob(options.stillPhoto.base64), (value) => value.charCodeAt(0))], { type: options.stillPhoto.type });
        }
        const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 2560; draw(canvas);
        const photo = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg", .95));
        stats.stillsCompleted++; return photo;
      }
    } : undefined });
  }, options);
}

export async function cameraPage(page: Page, options: Parameters<typeof installCamera>[1] = {}) {
  await installCamera(page, options);
  const creates: any[] = [];
  let scan: any;
  let failUpload = false;
  let acceptance: Promise<void> = Promise.resolve();
  let release = () => {};
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    let json: any = {};
    if (path === "/api/auth/session") json = { owner_id: "camera-fixture", display_name: "Camera collector", csrf_token: "camera-csrf", role: "member", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans" && request.method() === "GET") json = { items: scan ? [scan] : [], next_offset: null };
    else if (path === "/api/v1/scans" && request.method() === "POST") {
      creates.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      scan ||= { id: "camera-scan", filename: request.postDataJSON().filename, state: "UPLOADING", uploaded: false, accepted_at: null, created_at: "2026-09-20T00:00:00Z", expires_at: null, width: null, height: null, thumbnail_url: null, duplicate_scan_id: null, job: null };
      json = scan;
    } else if (path.endsWith("/upload")) {
      expect(request.headers()["x-csrf-token"]).toBe("camera-csrf");
      if (failUpload) { failUpload = false; return route.fulfill({ status: 503, json: { detail: "Upload interrupted. Try again." } }); }
      scan.uploaded = true; json = { uploaded: true };
    } else if (path.endsWith("/finalize")) {
      await acceptance;
      scan.accepted_at = "2026-09-20T00:01:00Z"; scan.state = "QUEUED";
      scan.job = { id: "camera-job", state: "QUEUED", stage: "Preparing your photo", attempts: 0, error_message: null };
      return route.fulfill({ status: 202, json: { scan_id: scan.id, safe_to_disconnect: true } });
    } else if (path === "/api/v1/scans/camera-scan") json = scan;
    else throw new Error("Unexpected camera fixture request: " + path);
    await route.fulfill({ json });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  return { creates, failNextUpload: () => { failUpload = true; }, holdAcceptance: () => { acceptance = new Promise((resolve) => { release = resolve; }); }, release: () => release() };
}

export async function openCamera(page: Page) {
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
}

export async function takePhoto(page: Page) {
  await page.getByRole("button", { name: "Capture photo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Upload & scan", exact: true })).toBeEnabled();
}

export const cameraStats = (page: Page) => page.evaluate(() => (window as any).cameraFixture.stats);
