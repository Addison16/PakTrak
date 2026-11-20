import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./deck-fixture";

async function openSheet(page: Page) {
  await fixture(page);
  await page.getByRole("button", { name: /Friday night/ }).click();
  await page.locator(".deck-shopping > summary").click();
  await page.getByRole("region", { name: "Missing cards buy list", exact: true }).getByRole("button", { name: "Print proxies" }).click();
  return page.getByRole("dialog", { name: "Print proxies" });
}

for (const width of [390, 1280]) test(`missing cards lay out as real-size proxies to print at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const sheet = await openSheet(page);
  // Two copies of the first missing card and one each of the others.
  await expect(sheet.locator(".proxy-card")).toHaveCount(4);
  await expect(sheet.getByText(/4 cards on 1 page for Friday night/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // On paper only the sheet prints, and every card is 63 × 88 mm whatever the screen size.
  await page.emulateMedia({ media: "print" });
  const card = await sheet.locator(".proxy-card").first().evaluate((element) => { const box = element.getBoundingClientRect(); return { width: box.width / 96 * 25.4, height: box.height / 96 * 25.4 }; });
  expect(Math.abs(card.width - 63)).toBeLessThan(0.5);
  expect(Math.abs(card.height - 88)).toBeLessThan(0.5);
  await expect(sheet.locator(".proxy-sheet-bar")).toBeHidden();
  await expect(page.locator("#root")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("#root")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.printing)).toBeUndefined();
});

test("Print opens the browser's print dialog once the pictures are ready", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { printed: number }).printed = 0; window.print = () => { (window as unknown as { printed: number }).printed += 1; }; });
  const sheet = await openSheet(page);
  await sheet.getByRole("button", { name: "Print", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
});
