import { expect, test } from "@playwright/test";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

test("unsectioned Commander import saves 1+99 and extras, then rechecks an edited format", async ({ browser, request }) => {
  const account = await createCollector(request);
  const context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    // Let the identity page finish its initial autofocus before WebKit fills.
    await page.waitForURL(/\/identity\/realms\/scanner\//);
    await page.waitForLoadState("load");
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page); await navigate(page, "Decks");
    await page.getByRole("button", { name: "Import deck list", exact: true }).click();
    await page.getByRole("textbox", { name: "Import deck name", exact: true }).fill("Legality fixture");
    await page.getByRole("combobox", { name: "Import deck format", exact: true }).selectOption("commander");
    await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("1 Ghalta, Primal Hunger\n101 Forest\n2 Island");
    await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
    await expect(page.locator(".deck-import-preview")).toContainText("1 commander · 99 mainboard · 4 extras");
    await expect(page.getByRole("region", { name: "Deck legality", exact: true })).toContainText("Passes Commander checks");
    await page.getByRole("button", { name: "Import deck", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Legality fixture", exact: true })).toBeVisible();
    const id = (await (await context.request.get("/api/v1/decks")).json()).items[0].id;
    let saved = await (await context.request.get(`/api/v1/decks/${id}`)).json();
    expect(saved.legality.status).toBe("legal");
    expect(saved.legality.counts).toEqual({ commander: 1, main: 99, sideboard: 4 });
    expect(saved.cards.find((c: any) => c.section === "commander").printing.name).toBe("Ghalta, Primal Hunger");
    const panel = page.getByRole("region", { name: "Deck legality", exact: true });
    await panel.getByText("Legality details", { exact: true }).click();
    await expect(panel).toContainText("Commander has no playable sideboard");
    await panel.screenshot({ path: `../../artifacts/deck-legality/live-${test.info().project.name}.png` });
    await page.getByRole("button", { name: "Edit deck", exact: true }).click();
    await page.getByRole("combobox", { name: "Deck format", exact: true }).selectOption("modern");
    await expect(panel).toContainText("Modern does not use a commander section");
    const leader = page.locator(".deck-cards > li").filter({ hasText: "Ghalta, Primal Hunger" });
    await leader.getByRole("combobox", { name: "Deck section", exact: true }).selectOption("main");
    await expect(panel).toContainText("Passes Modern checks");
    await page.getByRole("button", { name: "Save & done", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Edit deck", exact: true })).toBeVisible();
    saved = await (await context.request.get(`/api/v1/decks/${id}`)).json();
    expect(saved).toMatchObject({ format: "modern", legality: { status: "legal", counts: { commander: 0, main: 100, sideboard: 4 } } });
    await page.reload(); await navigate(page, "Decks");
    await page.getByRole("button", { name: /Legality fixture/ }).click();
    await expect(page.getByRole("region", { name: "Deck legality", exact: true })).toContainText("Passes Modern checks");
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
    expect((await (await context.request.get("/api/auth/session")).json()).scan_cards_used).toBe(0);
  } finally { await context.close(); await account.remove(); }
});
