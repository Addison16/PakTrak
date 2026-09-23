import { expect, test } from "@playwright/test";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

test("duplicate copies accumulate across imports and retain per-location quantities", async ({ browser, request }) => {
  const account = await createCollector(request);
  const card = (await (await request.get(account.baseURL + "/api/v1/catalog/search?q=Island")).json()).items.find((item: { language: string }) => item.language === "en");
  expect(card).toBeTruthy();
  const context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(account.username);
    await page.locator("#password").fill(account.password);
    await page.locator("#kc-login").click();
    await skipWelcomeTour(page);

    async function addCopies(name: string, rows: string, quantity: number) {
      await navigate(page, "Import / export");
      await page.getByTestId("csv-input").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from("Scryfall ID,Quantity,Location,Notes\n" + rows) });
      await expect(page.getByRole("heading", { name: "Ready to review", exact: true })).toBeVisible({ timeout: 30000 });
      await page.getByLabel("These are cards I own. Add the reviewed quantities to my collection.").check();
      await page.getByRole("button", { name: `Add ${quantity} copies`, exact: true }).click();
      await expect(page.getByRole("heading", { name: "Import complete", exact: true })).toBeVisible({ timeout: 30000 });
      await navigate(page, "Collection");
      await expect(page.locator(".collection-card")).toHaveCount(1);
    }
    await addCopies("first-copies.csv", `${card.id},2,Red binder,First copies\n${card.id},1,Box 4,Box copy\n`, 3);
    await expect(page.getByText("×3", { exact: true })).toBeVisible();
    await addCopies("more-copies.csv", `${card.id},2,Red binder,Additional copies\n`, 2);
    await expect(page.getByText("×5", { exact: true })).toBeVisible();
    await page.locator(".gallery-card").click();
    await expect(page.locator(".card-locations .card-location").filter({ hasText: "Red binder" })).toContainText("4 copies");
    await expect(page.locator(".card-locations .card-location").filter({ hasText: "Box 4" })).toContainText("1 copy");
    await page.reload();
    await navigate(page, "Collection");
    await expect(page.getByText("×5", { exact: true })).toBeVisible();

    await page.locator(".gallery-card").click();
    await page.getByText("Manage copies", { exact: true }).click();
    const original = page.locator(".copy-groups > li").filter({ hasText: "First copies" });
    await original.getByText("Remove copies", { exact: true }).click();
    await original.getByLabel("Copies to keep", { exact: true }).fill("1");
    await original.getByRole("button", { name: "Save remaining quantity", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("×4", { exact: true })).toBeVisible();
    await expect(page.locator(".card-locations .card-location").filter({ hasText: "Red binder" })).toContainText("3 copies");
    await page.getByRole("button", { name: "Close card details" }).click();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByRole("combobox", { name: "Storage location", exact: true }).selectOption({ label: "Box 4" });
    await expect(page.getByText("×1", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Storage location", exact: true }).selectOption("");
    await expect(page.getByText("×4", { exact: true })).toBeVisible();
    expect((await (await context.request.get("/api/v1/collection/cards")).json()).copies).toBe(4);
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: "../../artifacts/mobile-duplicates-" + browser.browserType().name() + ".png", fullPage: true });
  } finally {
    await context.close().catch(() => {});
    await account.remove();
  }
});
