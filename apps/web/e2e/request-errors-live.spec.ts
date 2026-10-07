import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

test("real sign-in renewal, invalid fields and failed callbacks produce safe request references", async ({ browser, request }, info) => {
  const account = await createCollector(request);
  const context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const references: { id: string; code: string }[] = [];
  let owner = "";
  try {
    const page = await context.newPage();
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/identity\/realms\/scanner\//); await page.waitForLoadState("load");
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page); await navigate(page, "Upload photo");
    const original = await (await context.request.get("/api/auth/session")).json(); owner = original.owner_id;
    const other = await context.newPage();
    await other.goto("/api/auth/login");
    await expect(other.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
    const renewed = await (await context.request.get("/api/auth/session")).json();
    expect(renewed.owner_id).toBe(owner); expect(renewed.csrf_token === original.csrf_token).toBe(false);
    await other.close(); await page.bringToFront();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/v1/scans?offset=") && response.ok()),
      page.evaluate(() => window.dispatchEvent(new Event("focus"))),
    ]);
    // Send invalid metadata to exercise the real validation handler without storing a photo.
    await page.route("**/api/v1/scans", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      expect(route.request().headers()["x-csrf-token"] === renewed.csrf_token).toBe(true);
      const response = await route.fetch({ postData: { ...route.request().postDataJSON(), foil_count: 33 } });
      expect(response.status()).toBe(422);
      references.push({ id: response.headers()["x-request-id"], code: "validation_failed" });
      await route.fulfill({ response });
    });
    await page.getByTestId("photo-input").setInputFiles({ name: "request-diagnostics-fixture.jpg", mimeType: "image/jpeg", buffer: Buffer.from([255, 216, 255, 217]) });
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Foil count: Use a value at most 32.");
    await alert.getByText("Error details", { exact: true }).click();
    await expect(alert.locator("pre")).toContainText(references[0].id);
    await alert.screenshot({ path: `../../artifacts/request-errors/live-validation-${info.project.name}.png` });
    await alert.getByRole("button", { name: "Dismiss error" }).click(); await expect(alert).toHaveCount(0);

    const rejected = await context.request.patch("/api/auth/preferences", {
      headers: { Origin: account.baseURL, "X-CSRF-Token": original.csrf_token }, data: { price_source: "manapool" },
    });
    expect(rejected.status()).toBe(403); expect((await rejected.json()).error_code).toBe("csrf_mismatch");
    references.push({ id: rejected.headers()["x-request-id"], code: "csrf_mismatch" });
    expect((await (await context.request.get("/api/auth/session")).json()).preferred_price_source).toBe(renewed.preferred_price_source);
    const forbidden = await context.request.get("/api/v1/diagnostics/errors"); expect(forbidden.status()).toBe(403);
    references.push({ id: forbidden.headers()["x-request-id"], code: "forbidden" });

    const cancelled = await context.request.get("/api/auth/callback?error=access_denied", { maxRedirects: 0 });
    expect(cancelled.status()).toBe(303);
    const destination = new URL(cancelled.headers().location, account.baseURL);
    expect(destination.searchParams.get("login_error")).toBe("login_cancelled");
    references.push({ id: destination.searchParams.get("error_ref")!, code: "login_cancelled" });
    await page.goto(destination.toString()); await expect(alert).toContainText("Sign-in was cancelled");
    await alert.getByText("Error details", { exact: true }).click();
    await expect(alert.locator("pre")).toContainText(references.at(-1)!.id);
    await expect(alert.getByRole("link", { name: "Sign in again" })).toBeVisible();
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
    expect((await (await context.request.get("/api/v1/scans")).json()).items).toHaveLength(0);
  } finally {
    mkdirSync("../../artifacts/request-errors", { recursive: true, mode: 0o700 });
    writeFileSync(`../../artifacts/request-errors/live-refs-${info.project.name}.json`, JSON.stringify({ owner, references }), { mode: 0o600 });
    await context.close(); await account.remove();
  }
});
