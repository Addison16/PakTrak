import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const bytes = (name: string) => readFileSync("../../tests/fixtures/" + name);

async function fixture(page: Page, holdAcceptance = false) {
  const creates: { body: any; key: string }[] = [];
  const uploads: { type: string }[] = [];
  // WebKit's interception API omits binary File request bodies. Observe the
  // actual Blob passed to XHR, leaving the send operation and payload untouched.
  await page.addInitScript(() => {
    const sent: { size: number; sha256: string | null }[] = [];
    (window as any).sentPhotoFiles = sent;
    const original = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      if (body instanceof Blob) {
        const item = { size: body.size, sha256: null as string | null }; sent.push(item);
        void body.arrayBuffer().then((data) => crypto.subtle.digest("SHA-256", data)).then((hash) => {
          item.sha256 = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        });
      }
      return original.call(this, body);
    };
  });
  let scan: any;
  let release = () => {};
  const acceptance = holdAcceptance ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  let failUpload = false;
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    let json: any = {};
    if (path === "/api/auth/session") json = { owner_id: "photo-fixture", display_name: "Photo collector", csrf_token: "photo-csrf", role: "member", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans" && req.method() === "GET") json = { items: scan ? [scan] : [], next_offset: null };
    else if (path === "/api/v1/scans" && req.method() === "POST") {
      creates.push({ body: req.postDataJSON(), key: req.headers()["idempotency-key"] });
      scan = { id: "photo-scan", filename: req.postDataJSON().filename, state: "UPLOADING", uploaded: false, accepted_at: null, created_at: "2026-09-20T00:00:00Z", expires_at: null, width: null, height: null, thumbnail_url: null, duplicate_scan_id: null, job: null };
      json = scan;
    } else if (path.endsWith("/upload")) {
      expect(req.headers()["x-csrf-token"]).toBe("photo-csrf");
      uploads.push({ type: req.headers()["content-type"] });
      if (failUpload) { failUpload = false; return route.abort("failed"); }
      scan.uploaded = true; json = { uploaded: true };
    } else if (path.endsWith("/finalize")) {
      await acceptance;
      scan.accepted_at = "2026-09-20T00:01:00Z"; scan.state = "QUEUED";
      scan.job = { id: "photo-job", state: "QUEUED", stage: "Preparing your photo", attempts: 0, error_message: null };
      return route.fulfill({ status: 202, json: { scan_id: scan.id, safe_to_disconnect: true } });
    } else if (path === "/api/v1/scans/photo-scan") json = scan;
    else throw new Error("Unexpected fixture request: " + path);
    await route.fulfill({ json });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Choose photo", exact: true })).toBeVisible();
  return { creates, uploads, release, failNextUpload: () => { failUpload = true; } };
}

for (const mode of ["light", "dark"] as const) test(`${mode} photo choices fit a narrow phone`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await page.emulateMedia({ colorScheme: mode });
  await fixture(page);
  const accept = (await page.getByTestId("photo-input").getAttribute("accept"))!.split(",");
  for (const extension of [".jpg", ".png", ".webp", ".heic", ".heif", ".hif", ".avif", ".tiff", ".tif", ".bmp", ".gif"]) expect(accept).toContain(extension);
  await page.getByText("Supported photo formats", { exact: true }).click();
  await expect(page.locator(".photo-format-help")).toContainText("main photo");
  await expect(page.locator(".photo-format-help")).toContainText("multi-page TIFFs");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../artifacts/photo-formats/upload-${mode}-${test.info().project.name}.png`, fullPage: true });
});

test("all still-photo formats upload their original bytes with the correct type", async ({ page }) => {
  const mock = await fixture(page);
  const cases = [
    ["transport.png", "image/png", "image/png"], ["photos/transport.jpg", "image/pjpeg", "image/jpeg"],
    ["photos/transport.webp", "image/webp", "image/webp"], ["photos/transport.heic", "image/heic", "image/heif"],
    ["photos/transport.avif", "image/avif", "image/avif"], ["photos/transport.tiff", "image/x-tiff", "image/tiff"],
    ["photos/transport.bmp", "image/x-ms-bmp", "image/bmp"], ["photos/transport.gif", "image/gif", "image/gif"],
  ];
  for (const [path, type, canonical] of cases) await test.step(path, async () => {
    await navigate(page, "Upload photo");
    const data = bytes(path), name = path.split("/").at(-1)!;
    await page.getByTestId("photo-input").setInputFiles({ name, mimeType: type, buffer: data });
    await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
    expect(mock.creates.at(-1)!.body).toMatchObject({ content_type: canonical, size: data.length, filename: name });
    expect(mock.uploads.at(-1)!.type).toBe(canonical);
    await expect.poll(() => page.evaluate(() => (window as any).sentPhotoFiles.at(-1))).toEqual({ size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  });
});

test("Files and iCloud uploads can omit a MIME type, including uppercase extensions", async ({ page }) => {
  const mock = await fixture(page);
  for (const [name, type, path, canonical] of [
    ["PHONE.HEIC", "", "photos/transport.heic", "image/heif"],
    ["photo.heif", "application/octet-stream", "photos/transport.heic", "image/heif"],
    ["scan.TIF", "application/octet-stream", "photos/transport.tiff", "image/tiff"],
  ]) {
    await navigate(page, "Upload photo");
    await page.getByTestId("photo-input").setInputFiles({ name, mimeType: type, buffer: bytes(path) });
    await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
    expect(mock.creates.at(-1)!.body.content_type).toBe(canonical);
    expect(mock.uploads.at(-1)!.type).toBe(canonical);
  }
});

test("browser-provided JPEG conversion wins over the original HEIC filename", async ({ page }) => {
  const mock = await fixture(page);
  await page.getByTestId("photo-input").setInputFiles({ name: "phone.heic", mimeType: "image/jpeg", buffer: bytes("photos/transport.jpg") });
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
  expect(mock.creates[0].body.content_type).toBe("image/jpeg");
  await expect.poll(() => page.evaluate(() => (window as any).sentPhotoFiles[0].sha256)).toBe(createHash("sha256").update(bytes("photos/transport.jpg")).digest("hex"));
});

test("unsupported documents, RAW files, animations by MIME and video never start an upload", async ({ page }) => {
  const mock = await fixture(page);
  for (const [name, type] of [["photo.svg", "image/svg+xml"], ["photo.pdf", "application/pdf"], ["photo.dng", ""], ["photo.mov", "video/quicktime"], ["photo.heics", "image/heic-sequence"], ["renamed.heic", "text/plain"]]) {
    await page.getByTestId("photo-input").setInputFiles({ name, mimeType: type, buffer: Buffer.from("unsupported fixture") });
    await expect(page.getByRole("alert")).toContainText("Choose a JPEG");
  }
  expect(mock.creates).toHaveLength(0); expect(mock.uploads).toHaveLength(0);
});

test("safe-to-disconnect messaging waits for durable acceptance", async ({ page }) => {
  const mock = await fixture(page, true);
  await page.getByTestId("photo-input").setInputFiles({ name: "phone.heic", mimeType: "image/heic", buffer: bytes("photos/transport.heic") });
  await expect.poll(() => mock.uploads.length).toBe(1);
  await expect(page.getByText(/Keep this page open until acceptance is confirmed/)).toBeVisible();
  await expect(page.getByText(/Upload complete\. You can close this page/)).toHaveCount(0);
  mock.release();
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
});

test("upload retry keeps its receipt when a file's HEIC MIME alias changes", async ({ page }) => {
  const mock = await fixture(page); mock.failNextUpload();
  const data = bytes("photos/transport.heic");
  await page.getByTestId("photo-input").setInputFiles({ name: "photo.HEIC", mimeType: "image/heic", buffer: data });
  await expect(page.getByRole("alert")).toContainText("Connection interrupted");
  await page.getByTestId("photo-input").setInputFiles({ name: "photo.HEIC", mimeType: "", buffer: data });
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
  expect(mock.creates).toHaveLength(2);
  expect(mock.creates[0]).toEqual(mock.creates[1]);
  expect(mock.uploads[0]).toEqual(mock.uploads[1]);
  await expect.poll(() => page.evaluate(() => (window as any).sentPhotoFiles.map((item: any) => item.sha256))).toEqual(Array(2).fill(createHash("sha256").update(data).digest("hex")));
});
