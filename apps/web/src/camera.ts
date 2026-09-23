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
    context.drawImage(video, 0, 0);
    const photo = await deadline(new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
      if (blob) resolve(blob); else reject(new Error("Photo capture failed. Try Phone camera."));
    }, "image/jpeg", .95)), 5000);
    return { file: photoFile(photo, "jpg"), source: "frame" };
  } finally { canvas.width = 0; canvas.height = 0; }
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
