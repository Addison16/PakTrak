import { expect, test } from "@playwright/test";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

test("mobile storage locations, saved decks and text transfers", async ({ browser, request }) => {
  const account = await createCollector(request);
  const card = (await (await request.get(account.baseURL + "/api/v1/catalog/search?q=Island")).json()).items.find((item: { language: string }) => item.language === "en");
  expect(card).toBeTruthy();
  const context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  context.setDefaultTimeout(15000);
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
    await navigate(page, "Upload photo");
    await expect(page.getByText("Guest account · 0 / 100 card scans used", { exact: true })).toBeVisible();
    await navigate(page, "Import / export");
    await page.getByTestId("csv-input").setInputFiles({ name: "library.csv", mimeType: "text/csv", buffer: Buffer.from(`Scryfall ID,Quantity,Location\n${card.id},3,Red binder\n`) });
    await expect(page.getByRole("heading", { name: "Ready to review", exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByLabel("These are cards I own. Add the reviewed quantities to my collection.").check();
    await page.getByRole("button", { name: "Add 3 copies", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Import complete", exact: true })).toBeVisible({ timeout: 30000 });
    await navigate(page, "Collection");
    await page.getByText("Manage storage locations", { exact: true }).click();
    await page.getByLabel("Location name", { exact: true }).first().fill("Box 4");
    await page.getByRole("combobox", { name: "Location type", exact: true }).first().selectOption("box");
    await page.getByRole("button", { name: "Create location", exact: true }).click();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await expect(page.getByRole("combobox", { name: "Storage location", exact: true }).getByRole("option", { name: "Box 4", exact: true })).toHaveCount(1);
    await page.getByLabel("Find a card", { exact: true }).fill(card.name);
    await page.getByRole("button", { name: "Search collection", exact: true }).click();
    await page.locator(".gallery-card").click();
    await expect(page.getByText("Find it: Red binder", { exact: true })).toBeVisible();
    await page.getByText("Manage copies", { exact: true }).click();
    await page.getByText("Move to another location", { exact: true }).click();
    await page.getByRole("combobox", { name: "Destination", exact: true }).selectOption({ label: "Box 4" });
    await page.getByRole("button", { name: "Move 3 copies", exact: true }).click();
    await expect(page.getByText("Find it: Box 4", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close card details" }).click();
    await navigate(page, "Decks");
    await page.getByRole("button", { name: "New deck", exact: true }).click();
    await page.getByLabel("New deck name", { exact: true }).fill("Friday night");
    await page.getByRole("button", { name: "Create deck", exact: true }).click();
    await page.getByLabel("Find cards you own", { exact: true }).fill(card.name);
    const add = page.getByRole("button", { name: "Add " + card.name, exact: false }).first();
    await add.click();
    await page.getByRole("combobox", { name: "Add cards to", exact: true }).selectOption("sideboard");
    await add.click();
    await page.getByRole("textbox", { name: "Deck notes", exact: true }).fill("Bring blue sleeves");
    await page.getByRole("button", { name: "Save deck", exact: true }).click();
    await expect(page.getByText("Deck saved.", { exact: true })).toBeVisible();
    await expect(page.locator(".card-location").filter({ hasText: "Box 4 (3)" })).toHaveCount(2);
    const saved = (await (await context.request.get("/api/v1/decks")).json()).items[0];
    await page.locator(".deck-export > summary").click();
    const textLink = page.getByRole("link", { name: "Export saved deck as text", exact: true });
    const deckText = await (await context.request.get((await textLink.getAttribute("href"))!)).text();
    expect(deckText).toContain("Mainboard"); expect(deckText).toContain("Sideboard");
    await page.reload();
    await navigate(page, "Decks");
    await page.getByRole("button", { name: /Friday night/ }).click();
    await page.getByRole("button", { name: "Edit deck", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Deck notes", exact: true })).toHaveValue("Bring blue sleeves");
    await expect(page.locator(".card-location").filter({ hasText: "Box 4 (3)" })).toHaveCount(2);
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(3);
    expect((await (await context.request.get("/api/v1/decks/" + saved.id)).json()).copies).toBe(2);
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll("body *")].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
      }).map((element) => ({ tag: element.tagName, class: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width })),
      scrolling: [...document.querySelectorAll("body, body *")].filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({ tag: element.tagName, class: element.className, scroll: element.scrollWidth, width: element.clientWidth, rect: element.getBoundingClientRect().toJSON() })),
    }));
    await test.info().attach("deck-editor-layout", { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
    await page.screenshot({ path: "../../artifacts/mobile-decks-" + browser.browserType().name() + ".png", fullPage: true });
    expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
    await navigate(page, "Import / export");
    await page.getByTestId("csv-input").setInputFiles({ name: "saved-deck.txt", mimeType: "text/plain", buffer: Buffer.from(deckText) });
    await expect(page.getByRole("heading", { name: "Ready to review", exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Add 2 copies", exact: true })).toBeDisabled();
    // Importing a text list requires ownership confirmation and does not change
    // saved decks or manufacture holdings just by uploading it.
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(3);
    expect(errors).toEqual([]);
  } finally { await context.close().catch(() => {}); await account.remove(); }
});
