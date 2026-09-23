import { expect, test } from "@playwright/test";
import { cameraPage, cameraStats, openCamera, takePhoto } from "./camera-fixture";

const cameras = [
  { id: "back-main", label: "Back Wide Camera", controls: true },
  { id: "back-ultra", label: "Back Ultra Wide Camera", controls: false, width: 1920, height: 1080 },
  { id: "back-tele", label: "Back Telephoto Camera", controls: false },
  { id: "front", label: "Front Camera", controls: false },
];

test("camera choice switches the actual source, refreshes controls and survives retake, reopening and reload", async ({ page }) => {
  const mock = await cameraPage(page, { cameras });
  expect((await cameraStats(page)).enumerations).toBe(0);
  await openCamera(page);
  const choice = page.getByRole("combobox", { name: "Camera", exact: true });
  await expect(choice.locator("option")).toHaveText(["Automatic · rear camera", ...cameras.map((camera) => camera.label)]);
  await expect(page.getByText("Using Back Wide Camera", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Light off", exact: true }).click();
  await page.getByRole("button", { name: "Zoom 2×", exact: true }).click();
  await choice.selectOption("back-ultra");
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await expect(choice).toBeFocused();
  await expect(page.getByRole("group", { name: "Camera zoom" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Light (off|on)/ })).toHaveCount(0);
  await expect(page.locator(".camera-copy")).toContainText("1920 × 1080 live view");
  expect((await cameraStats(page)).requests.at(-1)).toEqual({ audio: false, video: { deviceId: { exact: "back-ultra" }, width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 24, max: 30 } } });
  await takePhoto(page);
  await expect(choice).toHaveCount(0);
  await expect(page.locator(".camera-copy")).toContainText("1920 × 1080");
  expect((await cameraStats(page)).active).toBe(0);
  expect(mock.creates).toHaveLength(0);
  await page.getByRole("button", { name: "Retake", exact: true }).click();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await expect(choice).toHaveValue("back-ultra");
  await page.getByRole("button", { name: "Close camera", exact: true }).click();
  await openCamera(page);
  await expect(choice).toHaveValue("back-ultra");
  await page.reload();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await expect(choice).toHaveValue("back-ultra");
  await choice.selectOption("");
  await expect(page.getByText("Using Back Wide Camera", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Light off", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom 1×", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("paktrak.camera-device"))).toBeNull();
  expect((await cameraStats(page)).activeAtRequest.every((active: number) => active === 0)).toBe(true);
});

test("still capture uses the selected camera and keeps the selection locked until review", async ({ page }) => {
  const mock = await cameraPage(page, { cameras, still: "delayed" }); await openCamera(page);
  const choice = page.getByRole("combobox", { name: "Camera", exact: true });
  await choice.selectOption("back-tele");
  await page.getByRole("button", { name: "Capture photo", exact: true }).click();
  await expect.poll(async () => (await cameraStats(page)).stills).toBe(1);
  await expect(choice).toBeDisabled();
  await page.evaluate(() => (window as any).cameraFixture.pendingPhotos.shift()());
  await expect(page.getByRole("button", { name: "Upload & scan", exact: true })).toBeEnabled();
  await expect(choice).toHaveCount(0);
  expect((await cameraStats(page)).stillDevices).toEqual(["back-tele"]);
  expect((await cameraStats(page)).active).toBe(0);
  expect(mock.creates).toHaveLength(0);
});

test("an unavailable remembered camera falls back to Automatic with a clear notice", async ({ page }) => {
  await cameraPage(page, { cameras, savedCamera: "removed-camera" }); await openCamera(page);
  await expect(page.getByRole("combobox", { name: "Camera", exact: true })).toHaveValue("");
  await expect(page.getByText(/That camera isn't available right now/)).toBeVisible();
  await expect(page.getByText("Using Back Wide Camera", { exact: true })).toBeVisible();
  expect((await cameraStats(page)).requests.map((request: any) => request.video.deviceId?.exact || "auto")).toEqual(["removed-camera", "auto"]);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("paktrak.camera-device"))).toBeNull();
});

test("a busy selected camera falls back without blocking another choice or capture", async ({ page }) => {
  await cameraPage(page, { cameras, failCamera: "back-tele" }); await openCamera(page);
  const choice = page.getByRole("combobox", { name: "Camera", exact: true });
  await choice.selectOption("back-tele");
  await expect(choice).toHaveValue("");
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await expect(page.getByText(/That camera isn't available right now/)).toBeVisible();
  await choice.selectOption("back-ultra");
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await expect(page.getByText(/That camera isn't available right now/)).toHaveCount(0);
  expect((await cameraStats(page)).active).toBe(1);
  expect((await cameraStats(page)).activeAtRequest.every((active: number) => active === 0)).toBe(true);
  await takePhoto(page);
});

for (const enumeration of ["fails", "missing"] as const) test(`camera enumeration ${enumeration} still allows capture and native fallback`, async ({ page }) => {
  await cameraPage(page, { enumeration }); await openCamera(page);
  await expect(page.getByText(/Camera choices couldn't be loaded/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Camera", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Phone camera", exact: true })).toBeEnabled();
  await takePhoto(page);
});

test("camera changes refresh the list with useful unnamed choices and recover from a removed device", async ({ page }) => {
  await cameraPage(page); await openCamera(page);
  const choice = page.getByRole("combobox", { name: "Camera", exact: true });
  await expect(page.getByText(/Only one camera is available here/)).toBeVisible();
  await page.evaluate(() => {
    (window as any).cameraFixture.cameras.push({ id: "back-ultra", label: "" }, { id: "back-ultra", label: "" }, { id: "front", label: "" }, { id: "", label: "Unavailable" });
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await expect(choice.locator("option")).toHaveText(["Automatic · rear camera", "Back camera", "Camera 2", "Camera 3"]);
  await choice.selectOption("back-ultra");
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const control = (window as any).cameraFixture;
    control.cameras = control.cameras.filter((camera: any) => camera.id !== "back-ultra");
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    control.tracks.at(-1).dispatchEvent(new Event("ended"));
  });
  await page.getByRole("button", { name: "Resume camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  await expect(choice).toHaveValue("");
  await expect(page.getByText(/That camera isn't available right now/)).toBeVisible();
  expect((await cameraStats(page)).active).toBe(1);
});

test("closing during a lens switch stops late streams and leaves a newly opened camera alone", async ({ page }) => {
  await cameraPage(page, { cameras, delayedCamera: "back-tele" }); await openCamera(page);
  await page.getByRole("combobox", { name: "Camera", exact: true }).selectOption("back-tele");
  await expect.poll(async () => (await cameraStats(page)).requests.length).toBe(2);
  await expect(page.getByRole("combobox", { name: "Camera", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeDisabled();
  expect((await cameraStats(page)).active).toBe(0);
  await page.evaluate(() => history.back());
  await expect(page.locator(".camera-dialog")).toHaveCount(0);
  await openCamera(page);
  await page.evaluate(() => (window as any).cameraFixture.pending.shift()());
  await expect.poll(async () => (await cameraStats(page)).stopped).toBe(2);
  await expect(page.getByRole("combobox", { name: "Camera", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Capture photo", exact: true })).toBeEnabled();
  expect((await cameraStats(page)).active).toBe(1);
  await page.getByRole("button", { name: "Close camera", exact: true }).click();
  expect((await cameraStats(page)).active).toBe(0);
});

test("camera selection works when preference storage is blocked", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await cameraPage(page, { cameras, storageBlocked: true }); await openCamera(page);
  await page.getByRole("combobox", { name: "Camera", exact: true }).selectOption("front");
  await takePhoto(page);
  expect(errors).toEqual([]);
});

for (const mode of ["light", "dark"] as const) test(`${mode} camera choices fit phone portrait and landscape layouts`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: mode });
  await cameraPage(page, { cameras }); await openCamera(page);
  for (const size of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    const choice = page.getByRole("combobox", { name: "Camera", exact: true });
    await expect(choice).toBeVisible();
    expect(await page.locator(".camera-dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const choiceBox = await choice.boundingBox();
    expect(choiceBox!.height).toBeGreaterThanOrEqual(44);
    for (const name of ["Capture photo", "Close camera", "Phone camera"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
    }
    await page.screenshot({ path: `../../artifacts/camera-choice/${mode}-${size.width}-${info.project.name}.png` });
  }
});
