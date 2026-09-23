# Photo uploads

Choose a photo normally or take a new one. **Take photo** opens the [in-app camera](CAMERA.md), with review/retake and a **Phone camera** option for native photo capture. PakTrak accepts these still-image formats:

| Format | Extensions | Behavior |
| --- | --- | --- |
| JPEG | `.jpg`, `.jpeg`, `.jpe` | Includes normal phone camera uploads and browser-converted photos. JPEGs with MPF/MPO data use their primary photo; additional embedded images are not scanned separately. |
| PNG | `.png` | Screenshots and lossless exports; transparent areas become white. |
| WebP | `.webp` | Still images; animation is rejected. |
| HEIC / HEIF | `.heic`, `.heif`, `.hif` | HEVC decoding in Docker. Uses the container's primary image, even when it is not the first image. Other images, depth data, gain maps and embedded thumbnails are not scanned separately. |
| AVIF | `.avif` | Still images decoded through Pillow's bundled AVIF support. |
| TIFF | `.tif`, `.tiff` | Single-page photos, including supported compressed TIFFs and 16-bit grayscale. Multiple pages require separate photo exports. |
| BMP | `.bmp` | Windows bitmap exports. |
| GIF | `.gif` | Still images only. |

In-app capture uses an available still-photo API or encodes the actual video frame as an opaque sRGB JPEG for review. JPEG remains the default for frame capture. Phone JPEGs can include extra images, such as HDR gain maps; the server extracts the primary still instead of mistaking these containers for animations. File-picker and native-camera uploads keep the selected file bytes unchanged; they do not use that canvas capture path.

The file limit remains **100 MiB** and the decoded-image limit **60 million pixels**. A 48-megapixel photo fits the pixel limit, provided it also fits the file-size limit. Large photos use more server memory; one measured 48-megapixel HEIC normalization used approximately 624 MiB peak process memory on the development host. This is a sample measurement, not a maximum memory guarantee.

The browser sends the selected file's bytes without running an image converter. Common MIME aliases are normalized; an empty/generic file type from a file picker can use a recognized extension. The API checks the actual file signature, byte count and checksum. ISO BMFF signatures distinguish still HEIF/AVIF brands from video/sequence containers. Renaming an unsupported file is not conversion. A browser or operating system can independently convert a library/camera photo to JPEG; PakTrak honors that actual reported image type even if the filename still ends in `.heic`.

Wait for **Upload complete** / server acceptance before closing the page. The stored original, job and queue receipt are durable at that point. The Docker worker validates and decodes it, applies orientation, converts embedded ICC color profiles to sRGB, and creates the scan image and thumbnail. There is no external photo-conversion service, browser codec bundle or additional account requirement. Upload retries keep their receipt even when a picker changes between HEIC MIME aliases.

Prepared scan images retain the selected photo's pixel dimensions; thumbnails fit within 720 × 720 pixels. Both are JPEGs. The working image uses quality 93; this is a scanning workflow, not lossless photo archiving. High-bit-depth HEIF and 16-bit grayscale TIFF are normalized to 8-bit working pixels. HDR gain maps are not applied, and previews do not preserve an HDR display workflow. Embedded ICC profiles are applied before removal; untagged images use the decoder's RGB output. New pixel-only images strip source EXIF/GPS/XMP and ICC metadata from previews and crops. The original upload stays private under the existing photo-retention policy, normally seven days.

Animated GIF/PNG/WebP/AVIF, HEIF/AVIF sequences, multi-page TIFF, RAW/DNG, PDFs, SVGs and videos are not scan inputs. Export a still photo in a supported format. A damaged file or unsupported decoder variant can be accepted into durable storage and then fail with an actionable batch error; it does not manufacture recognized cards. Pixel limits are checked before and after decoding, libheif security limits stay enabled, and existing worker deadlines/retries still apply.

The Docker build verifies HEVC, AVIF, WebP, TIFF and LittleCMS availability. `pi-heif==1.4.0` adds decoding only; HEIF encoders are not required by the application. [The dependency register](DEPENDENCIES.md) records the package and native-library notices.

Tests use original synthetic fixtures for each codec, rotated primary-image selection, 10/12-bit tones, transparency, color management, corrupt/mislabeled files, pixel limits, immutable uploads and client closure. Additional upstream samples, pinned to a recorded source commit in ignored artifacts, exercise a 48-megapixel HEIC, a Display P3 spatial photo, an Android HEIC and rejection of a 200-megapixel image. These are decoder/browser-engine checks, not physical iPhone camera testing or recognition-accuracy evidence.
