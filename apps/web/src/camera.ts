// These Image Capture extensions are not included in every TypeScript DOM library.
export type CameraCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  zoom?: { min: number; max: number; step: number };
};
export type CameraSettings = MediaTrackSettings & { torch?: boolean; zoom?: number };
export type CameraAdjustments = MediaTrackConstraintSet & { torch?: boolean; zoom?: number };
type StillCamera = {
  takePhoto: (settings?: { imageWidth: number; imageHeight: number }) => Promise<Blob>;
  getPhotoCapabilities?: () => Promise<{ imageWidth: { max: number }; imageHeight: { max: number } }>;
};

export function stillCamera(track: MediaStreamTrack): StillCamera | null {
  const Constructor = (window as Window & { ImageCapture?: new (track: MediaStreamTrack) => StillCamera }).ImageCapture;
  try { return Constructor ? new Constructor(track) : null; }
  catch { return null; }
}

function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Camera timed out.")), milliseconds);
    work.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

export async function capturePhoto(video: HTMLVideoElement, track: MediaStreamTrack): Promise<{ file: File; source: "still" | "frame" }> {
  const camera = stillCamera(track);
  if (camera) {
    try {
      let settings;
      try {
        const capabilities = await deadline(camera.getPhotoCapabilities!(), 1200);
        const width = capabilities.imageWidth.max, height = capabilities.imageHeight.max;
        if (width > 0 && height > 0) {
          const scale = Math.min(1, Math.sqrt(60_000_000 / (width * height)));
          settings = { imageWidth: Math.floor(width * scale), imageHeight: Math.floor(height * scale) };
        }
      } catch { /* Some cameras support takePhoto but not photo settings. */ }
      const photo = await deadline(camera.takePhoto(settings), 5000);
      // Keep the full-resolution still. The server extracts the primary photo
      // from JPEGs with auxiliary images as well as ordinary single-image files.
      const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[photo.type];
      if (photo.size && extension) return { file: photoFile(photo, extension), source: "still" };
    } catch { /* Fall back to the video's actual resolution; the UI labels it. */ }
  }
  if (track.readyState !== "live" || track.muted || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error("The camera paused. Resume it before taking a photo.");
  }
  const canvas = document.createElement("canvas");
  // Use the source frame, never the smaller CSS preview or its guides.
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  try {
    const context = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
    if (!context) throw new Error("Photo capture is unavailable. Try Phone camera.");
    await keepSharpestFrame(video, context);
    const photo = await deadline(new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
      if (blob) resolve(blob); else reject(new Error("Photo capture failed. Try Phone camera."));
    }, "image/jpeg", .95)), 5000);
    return { file: photoFile(photo, "jpg"), source: "frame" };
  } finally { canvas.width = 0; canvas.height = 0; }
}

// Browsers without still capture (iPhone Safari) give us video frames, and a
// web page can't trigger the camera's focus. Look at a few frames over about
// half a second and keep the sharpest, so a frame caught mid-refocus or during
// a small hand movement doesn't become the photo.
const FRAMES = 5;
async function keepSharpestFrame(video: HTMLVideoElement, target: CanvasRenderingContext2D) {
  const probe = document.createElement("canvas");
  probe.width = 320; probe.height = Math.max(1, Math.round(320 * video.videoHeight / video.videoWidth));
  const small = probe.getContext("2d", { alpha: false, willReadFrequently: true });
  let best = -1;
  try {
    for (let frame = 0; frame < FRAMES && small; frame++) {
      if (frame) await nextFrame(video);
      if (video.readyState < 2) break;
      const score = sharpness(small, video, probe.width, probe.height);
      if (score > best) { best = score; target.drawImage(video, 0, 0); }
    }
  } finally { probe.width = 0; probe.height = 0; }
  if (best < 0) target.drawImage(video, 0, 0);
}

function nextFrame(video: HTMLVideoElement) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 150);
    const withFrames = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    // Space samples out so the camera has time to settle between them.
    if (withFrames.requestVideoFrameCallback) window.setTimeout(() => withFrames.requestVideoFrameCallback!(() => { window.clearTimeout(timer); resolve(); }), 80);
  });
}

// Average squared brightness change between neighbouring pixels in the middle
// of the picture: crisp card text scores high, a soft frame scores low.
function sharpness(context: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number) {
  context.drawImage(video, 0, 0, width, height);
  const x0 = Math.floor(width * .1), y0 = Math.floor(height * .1), w = width - 2 * x0, h = height - 2 * y0;
  const { data } = context.getImageData(x0, y0, w, h);
  const light = new Float32Array(w * h);
  for (let i = 0; i < light.length; i++) light[i] = data[i * 4] * .299 + data[i * 4 + 1] * .587 + data[i * 4 + 2] * .114;
  let total = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const here = light[y * w + x], across = light[y * w + x + 1] - here, down = light[(y + 1) * w + x] - here;
    total += across * across + down * down;
  }
  return total / ((w - 1) * (h - 1));
}

function photoFile(photo: Blob, extension: string): File {
  return new File([photo], `PakTrak-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: photo.type });
}

export function cameraError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access wasn't allowed. Enable it in this site's browser settings, or use Phone camera.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No available camera was found. You can use Phone camera or choose a saved photo.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is busy or unavailable. Close other camera apps and try again, or use Phone camera.";
  return "The camera couldn't start. Try again, or use Phone camera.";
}
