import { expect, test, type Page } from "@playwright/test";
import { cameraPage, cameraStats, openCamera, takePhoto } from "./camera-fixture";
import { cancelBrowserBack, navigate } from "./navigation";

async function hasRecoveryPhoto(page: Page): Promise<boolean> {
  return page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("paktrak-pending-photos", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction("photos").objectStore("photos").get("camera-fixture");
      read.onsuccess = () => { db.close(); resolve(!!read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }));
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const state = await page.evaluate(() => {
    const video = document.querySelector("video");
    return { stats: (window as any).cameraFixture?.stats, text: document.querySelector(".camera-dialog")?.textContent, video: video && { width: video.videoWidth, height: video.videoHeight, ready: video.readyState, paused: video.paused, source: !!video.srcObject, tracks: (video.srcObject as MediaStream | null)?.getTracks().map((track) => ({ muted: track.muted, ready: track.readyState })), rect: video.getBoundingClientRect().toJSON() }, hidden: document.hidden };
  });
  console.log("Synthetic camera diagnostics:", JSON.stringify(state));
  await info.attach("camera-state", { body: JSON.stringify(state), contentType: "application/json" });
});

test("captures the whole source frame without guides and uploads only on confirmation", async ({ page }) => {
  const mock = await cameraPage(page);
  const foils = page.getByLabel("How many cards are foil?");
  await foils.click(); await foils.press("Backspace");
  await expect(foils).toHaveValue("");
  await foils.press("Tab"); await expect(foils).toHaveValue("0");
  await foils.click(); await foils.pressSequentially("3");
  await expect(foils).toHaveValue("3");
  await openCamera(page);
  await expect(page.getByRole("button", { name: "Light off", exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Camera zoom" })).toHaveCount(0);
  await expect(page.locator(".camera-guides")).toBeVisible();
  expect((await cameraStats(page)).requests).toEqual([{ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 24, max: 30 } } }]);
  await takePhoto(page);
  expect(mock.creates).toHaveLength(0);
  expect((await cameraStats(page)).active).toBe(0);
  await expect(page.locator(".camera-copy")).toContainText("960 × 1280 · 3 foils");
  await expect(page.locator(".camera-native")).toContainText("live-view photo");
  const pixels = await page.locator(".camera-photo-scroll img").evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement("canvas"); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(element, 0, 0);
    return { size: [canvas.width, canvas.height], samples: [[5, 5], [955, 1275], [320, 40]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]) };
  });
  expect(pixels.size).toEqual([960, 1280]);
  for (const pixel of pixels.samples) { expect(Math.abs(pixel[0] - 38)).toBeLessThan(5); expect(Math.abs(pixel[1] - 63)).toBeLessThan(5); expect(Math.abs(pixel[2] - 53)).toBeLessThan(5); }
  await page.getByRole("button", { name: "Enlarge to check details" }).click();
  expect(await page.locator(".camera-photo-scroll").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Show whole photo" }).click();
  await page.getByRole("button", { name: "Upload & scan", exact: true }).click();
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  expect(mock.creates).toHaveLength(1);
  expect(mock.creates[0].body).toMatchObject({ content_type: "image/jpeg", foil_count: 3 });
  expect((await cameraStats(page)).revoked).toBeGreaterThan(0);
  await navigate(page, "Upload photo");
  await expect(page.getByRole("spinbutton", { name: "How many cards are foil?", exact: true })).toHaveValue("0");
  await expect(page.getByText(/0 means every card is nonfoil/)).toBeVisible();
});

test("uses the still-photo API when available and displays actual photo dimensions", async ({ page }) => {
  await cameraPage(page, { still: "works" }); await openCamera(page); await takePhoto(page);
  await expect(page.locator(".camera-copy")).toContainText("1920 × 2560");
  expect((await cameraStats(page)).stills).toBe(1);
  expect((await cameraStats(page)).photoSettings).toEqual({ imageWidth: 1920, imageHeight: 2560 });
  await expect(page.locator(".camera-native")).not.toContainText("live-view photo");
  expect((await cameraStats(page)).active).toBe(0);
});

test("labels the frame fallback when a browser exposes a broken still-photo API", async ({ page }) => {
  await cameraPage(page, { still: "fails" }); await openCamera(page); await takePhoto(page);
  await expect(page.locator(".camera-copy")).toContainText("960 × 1280");
  await expect(page.locator(".camera-native")).toContainText("live-view photo");
});

test("supports available camera controls and reports a rejected setting without faking success", async ({ page }) => {
  await cameraPage(page, { controls: true }); await openCamera(page);
  await page.getByRole("button", { name: "Light off", exact: true }).click();
  await expect(page.getByRole("button", { name: "Light on", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Zoom 2×", exact: true }).click();
  await expect(page.getByRole("button", { name: "Zoom 2×", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => { (window as any).cameraFixture.rejectSettings = true; });
  await page.getByRole("button", { name: "Zoom 3×", exact: true }).click();
  await expect(page.locator(".camera-feedback")).toContainText("isn't available");
  await expect(page.getByRole("button", { name: "Zoom 2×", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Zoom 3×", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Guides", exact: true }).click();
  await expect(page.locator(".camera-guides")).toHaveCount(0);
  await page.getByRole("button", { name: "Close camera", exact: true }).click();
  expect((await cameraStats(page)).active).toBe(0);
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

for (const [name, options, message] of [
  ["permission denied", { denied: "NotAllowedError" }, "Camera access wasn't allowed"],
  ["camera busy", { denied: "NotReadableError" }, "camera is busy"],
  ["camera missing", { denied: "NotFoundError" }, "No available camera"],
  ["API unavailable", { missing: true }, "supported browser and an HTTPS connection"],
] as const) test(`${name} keeps the native camera and library available`, async ({ page }) => {
  await cameraPage(page, options);
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await expect(page.locator(".camera-placeholder")).toContainText(message);
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeDisabled();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Phone camera", exact: true }).click();
  expect(await (await chooser).element().getAttribute("capture")).toBe("environment");
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  expect((await cameraStats(page)).active).toBe(0);
});

test("retake releases the previous preview and closing a photo protects it from accidental dismissal", async ({ page }) => {
  await cameraPage(page); await openCamera(page); await takePhoto(page);
  await page.getByRole("button", { name: "Retake", exact: true }).click();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  expect((await cameraStats(page)).stopped).toBe(1);
  expect((await cameraStats(page)).active).toBe(1);
  // Retaking releases the camera preview and the separate recovery preview.
  await expect.poll(async () => (await cameraStats(page)).revoked).toBe(2);
  await expect.poll(() => hasRecoveryPhoto(page)).toBe(false);
  await takePhoto(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Upload & scan", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close camera", exact: true }).click();
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  expect((await cameraStats(page)).active).toBe(0);
});

test("failed uploads retain the same photo and receipt, and only server acceptance closes review", async ({ page }) => {
  const mock = await cameraPage(page); mock.failNextUpload(); mock.holdAcceptance();
  await openCamera(page); await takePhoto(page);
  const preview = await page.locator(".camera-photo-scroll img").getAttribute("src");
  await page.getByRole("button", { name: "Upload & scan", exact: true }).click();
  await expect(page.locator(".camera-dialog .camera-feedback")).toContainText("kept here so you can retry");
  await expect(page.locator(".camera-photo-scroll img")).toHaveAttribute("src", preview!);
  await page.getByRole("button", { name: "Upload & scan", exact: true }).click();
  await expect(page.locator(".camera-upload")).toContainText("Waiting for server acceptance");
  await expect(page.getByRole("button", { name: "Close camera", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retake", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".camera-dialog")).toBeVisible();
  await expect(page.getByText(/Upload complete\. You can close this page/)).toHaveCount(0);
  await expect.poll(() => mock.creates.length).toBe(2); expect(mock.creates[1]).toEqual(mock.creates[0]);
  await expect.poll(async () => { const sent = (await cameraStats(page)).sent; return sent.length === 2 && sent.every((item: any) => item.hash !== null); }).toBe(true);
  const sent = (await cameraStats(page)).sent; expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1]);
  mock.release();
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
});

test("backgrounding and camera interruption stop capture until explicitly resumed", async ({ page }) => {
  await cameraPage(page); await openCamera(page);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByRole("button", { name: "Resume camera", exact: true })).toBeVisible();
  expect((await cameraStats(page)).active).toBe(0);
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeDisabled();
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  expect((await cameraStats(page)).requests).toHaveLength(1);
  await page.getByRole("button", { name: "Resume camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).cameraFixture.tracks.at(-1).dispatchEvent(new Event("ended")));
  await expect(page.getByRole("button", { name: "Resume camera", exact: true })).toBeVisible();
  expect((await cameraStats(page)).active).toBe(0);
});

test("late camera permission after closing does not leave the camera running", async ({ page }) => {
  await cameraPage(page, { delayed: true });
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await expect.poll(async () => (await cameraStats(page)).requests.length).toBe(1);
  await page.getByRole("button", { name: "Close camera", exact: true }).click();
  await page.evaluate(() => (window as any).cameraFixture.pending.shift()());
  await expect.poll(async () => (await cameraStats(page)).stopped).toBe(1);
  expect((await cameraStats(page)).active).toBe(0);
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
});

test("a photo finishing after interruption cannot replace a new capture or unlock its shutter", async ({ page }) => {
  const mock = await cameraPage(page, { still: "delayed" }); await openCamera(page);
  await page.getByRole("button", { name: "Capture photo", exact: true }).click();
  await expect.poll(async () => (await cameraStats(page)).stills).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByRole("button", { name: "Resume camera", exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.getByRole("button", { name: "Resume camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Capture photo", exact: true }).click();
  await expect.poll(async () => (await cameraStats(page)).stills).toBe(2);
  await page.evaluate(() => (window as any).cameraFixture.pendingPhotos.shift()());
  await expect.poll(async () => (await cameraStats(page)).stillsCompleted).toBe(1);
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Upload & scan", exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).cameraFixture.pendingPhotos.shift()());
  await expect(page.getByRole("button", { name: "Upload & scan", exact: true })).toBeEnabled();
  expect(mock.creates).toHaveLength(0); expect((await cameraStats(page)).active).toBe(0);
});

for (const mode of ["light", "dark"] as const) test(`${mode} camera fits small portrait and landscape screens with reachable controls`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 }); await page.emulateMedia({ colorScheme: mode });
  await cameraPage(page, { controls: true }); await openCamera(page);
  for (const size of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    expect(await page.locator(".camera-dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const name of ["Capture photo", "Close camera", "Phone camera"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
    }
    await page.screenshot({ path: `../../artifacts/camera/live-${mode}-${size.width}-${test.info().project.name}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 }); await takePhoto(page);
  await page.screenshot({ path: `../../artifacts/camera/review-${mode}-${test.info().project.name}.png` });
});


test("browser history closes the camera and protects an unuploaded photo", async ({ page }) => {
  const mock = await cameraPage(page);
  await openCamera(page);
  await page.evaluate(() => history.back());
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  expect((await cameraStats(page)).active).toBe(0);
  await openCamera(page); await takePhoto(page);
  await expect.poll(() => hasRecoveryPhoto(page)).toBe(true);
  await cancelBrowserBack(page);
  await expect(page).toHaveURL(/overlay=camera$/);
  await expect(page.getByRole("button", { name: "Upload & scan", exact: true })).toBeVisible();
  await expect.poll(() => hasRecoveryPhoto(page)).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  expect((await cameraStats(page)).active).toBe(0);
  expect(mock.creates).toHaveLength(0);
  await expect.poll(() => hasRecoveryPhoto(page)).toBe(false);
  await expect(page.getByLabel("Unfinished photo", { exact: true })).toHaveCount(0);
});

test("qol recovery resumes a captured photo after reload with its original foil count", async ({ page }) => {
  const mock = await cameraPage(page);
  await page.getByLabel("How many cards are foil?", { exact: true }).fill("4");
  await openCamera(page); await takePhoto(page);
  const original = await page.locator(".camera-photo-scroll img").evaluate(async (image: HTMLImageElement) => {
    const photo = await fetch(image.src).then(response => response.blob());
    const hash = await crypto.subtle.digest("SHA-256", await photo.arrayBuffer());
    return { size: photo.size, type: photo.type, hash: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("") };
  });
  await expect.poll(() => hasRecoveryPhoto(page)).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole("button", { name: "Close camera", exact: true }).click();
  const recovery = page.getByLabel("Unfinished photo", { exact: true });
  await expect(recovery).toContainText("4 foils");
  expect(mock.creates).toHaveLength(0);
  await recovery.getByRole("button", { name: "Resume upload", exact: true }).click();
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
  expect(mock.creates).toHaveLength(1);
  expect(mock.creates[0].body.foil_count).toBe(4);
  await expect.poll(async () => (await cameraStats(page)).sent[0]).toEqual(original);
  await expect.poll(() => hasRecoveryPhoto(page)).toBe(false);
});

test("qol recovery accepting a photo preserves a newer pending photo from another tab", async ({ page }) => {
  const mock = await cameraPage(page);
  await openCamera(page); await takePhoto(page);
  mock.holdAcceptance();
  await page.getByRole("button", { name: "Upload & scan", exact: true }).click();
  await expect(page.locator(".camera-upload")).toContainText("Waiting for server acceptance…");
  await expect.poll(() => mock.creates.length).toBe(1);
  const newerSavedAt = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("paktrak-pending-photos", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, transaction = db.transaction("photos", "readwrite"), photos = transaction.objectStore("photos");
      let savedAt = 0;
      const read = photos.get("camera-fixture");
      read.onsuccess = () => {
        savedAt = read.result.savedAt + 60_000;
        photos.put({ ...read.result, filename: "other-tab-photo.jpg", savedAt, foilCount: 1 });
      };
      transaction.oncomplete = () => { db.close(); resolve(savedAt); };
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }));
  mock.release();
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  const remaining = await page.evaluate(() => new Promise<{ savedAt: number; filename: string; foilCount: number } | null>((resolve, reject) => {
    const open = indexedDB.open("paktrak-pending-photos", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, read = db.transaction("photos").objectStore("photos").get("camera-fixture");
      read.onsuccess = () => { db.close(); resolve(read.result ? { savedAt: read.result.savedAt, filename: read.result.filename, foilCount: read.result.foilCount } : null); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }));
  expect(remaining).toEqual({ savedAt: newerSavedAt, filename: "other-tab-photo.jpg", foilCount: 1 });
  expect(mock.creates).toHaveLength(1);
});


test("browser history waits for server acceptance and never reuploads a saved photo", async ({ page }) => {
  const mock = await cameraPage(page);
  await openCamera(page); await takePhoto(page);
  expect(await page.locator(".camera-dialog").evaluate((element) => getComputedStyle(element).overscrollBehaviorX)).toBe("auto");
  mock.holdAcceptance();
  await page.getByRole("button", { name: "Upload & scan", exact: true }).click();
  await expect(page.locator(".camera-upload")).toContainText("Waiting for server acceptance…");
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/overlay=camera$/);
  await expect(page.locator(".camera-dialog")).toBeVisible();
  mock.release();
  await expect(page.getByText(/Upload complete\. You can close this page/)).toBeVisible();
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  await page.evaluate(() => history.back());
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("region", { name: "Selected batch", exact: true })).toBeVisible();
  expect(mock.creates).toHaveLength(1);
});
