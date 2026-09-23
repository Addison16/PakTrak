import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createCollector } from "./account";
import { cameraStats, installCamera, openCamera, takePhoto } from "./camera-fixture";
import { navigate, skipWelcomeTour } from "./navigation";

for (const mode of ["frame", "still", "mpf"] as const) test(`${mode} in-app capture passes the deployed CSP and finishes in Docker after browser closure`, async ({ browser, request }) => {
  const account = await createCollector(request);
  let context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    let page = await context.newPage();
    // Only the hardware is simulated; identity, API, upload, queue and workers are real.
    const size = mode === "frame" ? [960, 1280] : mode === "mpf" ? [300, 420] : [1920, 2560];
    await installCamera(page, mode === "frame" ? {} : {
      still: "works",
      ...(mode === "mpf" ? { stillPhoto: {
        base64: readFileSync(new URL("../../../tests/fixtures/photos/transport-mpf.jpg", import.meta.url)).toString("base64"),
        type: "image/jpeg", width: size[0], height: size[1],
      } } : {}),
    });
    await page.addInitScript(() => {
      (window as any).cameraCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => (window as any).cameraCspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
    });
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page); await navigate(page, "Upload photo");
    const previousViolations = await page.evaluate(() => (window as any).cameraCspViolations);
    await openCamera(page); await takePhoto(page);
    await expect(page.locator(".camera-copy")).toContainText(`${size[0]} × ${size[1]}`);
    // Capture must introduce no new violations beyond the page's baseline,
    // including its lazy script/style chunks and blob previews/media.
    expect(await page.evaluate(() => (window as any).cameraCspViolations)).toEqual(previousViolations);
    await page.screenshot({ path: `../../artifacts/camera/deployed-review-${mode}-${test.info().project.name}.png` });
    const acceptedResponse = page.waitForResponse((response) => response.url().endsWith("/finalize") && response.status() === 202);
    void acceptedResponse.catch(() => {});
    await page.getByRole("button", { name: "Upload & scan", exact: true }).click();
    const accepted = await (await acceptedResponse).json();
    expect(accepted.safe_to_disconnect).toBe(true);
    expect((await cameraStats(page)).sent[0].type).toBe("image/jpeg");
    const state = await context.storageState(); await context.close();
    context = await browser.newContext({ baseURL: account.baseURL, storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await context.newPage(); await page.goto("/"); await navigate(page, "Batches");
    await expect.poll(async () => (await (await context.request.get("/api/v1/scans/" + accepted.scan_id)).json()).state, { timeout: 60000 }).toBe("PHOTO_READY");
    const scan = await (await context.request.get("/api/v1/scans/" + accepted.scan_id)).json();
    expect([scan.width, scan.height]).toEqual(size);
    expect(scan.job.result).toMatchObject({ recognition_available: true, cards_added: 0 });
    const thumbnail = await context.request.get(scan.thumbnail_url);
    expect(thumbnail.status()).toBe(200); expect(thumbnail.headers()["content-type"]).toContain("image/jpeg");
    await page.getByRole("button", { name: new RegExp(scan.filename.replaceAll(".", "\\.")) }).click();
    await expect(page.getByText(`${size[0]} × ${size[1]} pixels · Prepared on the server`, { exact: true })).toBeVisible();
    await page.screenshot({ path: `../../artifacts/camera/deployed-batch-${mode}-${test.info().project.name}.png`, fullPage: true });
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
  } finally { await context.close().catch(() => {}); await account.remove(); }
});
