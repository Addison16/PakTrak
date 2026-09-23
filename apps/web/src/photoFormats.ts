const formats: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg", "jpe"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/heif": ["heic", "heif", "hif"],
  "image/avif": ["avif"],
  "image/tiff": ["tif", "tiff"],
  "image/bmp": ["bmp"],
  "image/gif": ["gif"],
};
const aliases: Record<string, string> = {
  "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png",
  "image/heic": "image/heif", "image/x-heic": "image/heif", "image/x-heif": "image/heif",
  "image/x-tiff": "image/tiff", "image/x-bmp": "image/bmp", "image/x-ms-bmp": "image/bmp",
};
export const photoAccept = [...Object.keys(formats), ...Object.keys(aliases), ...Object.values(formats).flat().map((extension) => "." + extension)].join(",");
export const photoFormatLabel = "JPEG, PNG, WebP, HEIC/HEIF, AVIF, TIFF, BMP or still GIF";

export function photoMime(file: Pick<File, "type" | "name">): string | null {
  const mime = file.type.split(";", 1)[0].trim().toLowerCase();
  const normalized = aliases[mime] || mime;
  if (Object.hasOwn(formats, normalized)) return normalized;
  // Files picked from iCloud/Files can have an empty or generic MIME type. The
  // extension supplies only the upload label; the server verifies the bytes.
  if (mime && mime !== "application/octet-stream") return null;
  const extension = file.name.toLowerCase().split(".").at(-1)!;
  return Object.entries(formats).find(([, extensions]) => extensions.includes(extension))?.[0] || null;
}
