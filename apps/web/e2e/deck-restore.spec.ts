import { expect, test } from "@playwright/test";
import { fixture } from "./deck-fixture";
import { navigate } from "./navigation";

for (const width of [390, 1280]) {
  test(`all decks download and restore from the deck list at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const sent: any[] = [];
    await fixture(page);
    await page.route("**/api/v1/decks/restore", async (route) => {
      sent.push(JSON.parse(route.request().postData()!));
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      await route.fulfill({ json: { restored: [{ id: "a", name: "Friday night", copies: 6 }, { id: "b", name: "Burn", copies: 60 }], skipped: ["Next idea"], problems: [{ deck: "Burn", line: 9, card: "Lost Card", error: "Card not found." }, { deck: "Extra", line: 12, error: "Deck limit reached." }], problem_count: 2 } });
    });
    await page.locator(".deck-list .deck-export > summary").click();
    await expect(page.getByRole("link", { name: "Download all decks", exact: true })).toHaveAttribute("href", "/api/v1/decks/download-all");
    await page.getByTestId("deck-restore-input").setInputFiles({ name: "paktrak-decks.csv", mimeType: "text/csv", buffer: Buffer.from("Deck,Section,Quantity,Name\nBurn,main,4,Lost Card\n") });
    await expect(page.getByText("Restored 2 decks. Skipped 1 already saved here. 2 rows couldn't be added: Burn, Lost Card: Card not found; Extra: Deck limit reached.", { exact: true })).toBeVisible();
    expect(sent).toEqual([{ content: "Deck,Section,Quantity,Name\nBurn,main,4,Lost Card\n" }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".deck-list .deck-export").screenshot({ path: `../../artifacts/deck-restore/move-decks-${width}.png` });
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  test(`import and export offers every deck as text or CSV at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await fixture(page);
    await page.route(/\/api\/v1\/(binders|catalog\/status|imports|exports)(\?.*)?$/, (route) => route.fulfill({ json: route.request().url().includes("catalog") ? { printings: 7 } : { items: [], next_offset: null } }));
    await navigate(page, "Import / export");
    await page.getByRole("combobox", { name: "Export format", exact: true }).selectOption("decks");
    await expect(page.getByRole("link", { name: "Download decks as text", exact: true })).toHaveAttribute("href", "/api/v1/decks/download-all?format=text");
    await expect(page.getByRole("link", { name: "Download decks as CSV", exact: true })).toHaveAttribute("href", "/api/v1/decks/download-all");
    await expect(page.getByRole("button", { name: "Prepare export", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Storage location", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("link", { name: "Download decks as text", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `../../artifacts/deck-restore/export-decks-${width}.png` });
    expect(errors).toEqual([]);
  });
}
