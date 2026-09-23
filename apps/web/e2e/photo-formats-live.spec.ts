import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

test("HEIC, AVIF and TIFF uploads finish in Docker after closing the browser", async ({ browser, request }) => {
  const account = await createCollector(request);
  let context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    let page = await context.newPage();
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page);
    for (const [extension, mime] of [["heic", ""], ["avif", "image/avif"], ["tiff", "application/octet-stream"]]) {
      await navigate(page, "Upload photo");
      const name = `synthetic-photo-format.${extension}`;
      const acceptedResponse = page.waitForResponse((response) => response.url().endsWith("/finalize") && response.status() === 202);
      void acceptedResponse.catch(() => {});
      await page.getByTestId("photo-input").setInputFiles({ name, mimeType: mime, buffer: readFileSync(`../../tests/fixtures/photos/transport.${extension}`) });
      const accepted = await (await acceptedResponse).json();
      expect(accepted.safe_to_disconnect).toBe(true);
      const state = await context.storageState();
      await context.close();
      context = await browser.newContext({ baseURL: account.baseURL, storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      page = await context.newPage(); await page.goto("/"); await navigate(page, "Batches");
      await page.getByRole("button", { name: new RegExp(name.replaceAll(".", "\\.")) }).click();
      await expect.poll(async () => (await (await context.request.get("/api/v1/scans/" + accepted.scan_id)).json()).state, { timeout: 60000 }).toBe("PHOTO_READY");
      const scan = await (await context.request.get("/api/v1/scans/" + accepted.scan_id)).json();
      expect([scan.width, scan.height]).toEqual([300, 420]);
      expect(scan.job.result).toMatchObject({ recognition_available: true, cards_added: 0 });
      const thumbnail = await context.request.get(scan.thumbnail_url);
      expect(thumbnail.status()).toBe(200); expect(thumbnail.headers()["content-type"]).toContain("image/jpeg");
      await expect(page.getByText("300 × 420 pixels · Prepared on the server", { exact: true })).toBeVisible();
      await page.screenshot({ path: `../../artifacts/photo-formats/live-${extension}-${test.info().project.name}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
    }
  } finally { await context.close().catch(() => {}); await account.remove(); }
});
