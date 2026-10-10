import { expect, test } from "@playwright/test";
import { fixture, printings } from "./deck-fixture";

const legality = {
  format: "commander", archenemy: true, status: "legal", counts: { commander: 1, main: 4, sideboard: 0, schemes: 2 },
  issues: [{ code: "archenemy_setup", severity: "info", message: "Archenemy Commander: the archenemy starts at 60 life and goes first. The other players share one 60 life total.", printing_ids: [] }],
  catalog_updated_at: "2026-09-20T12:00:00Z", checked_at: "2026-09-20T12:00:00Z", rules_version: "fixture", checks: ["Deck and sideboard size", "Scheme deck"], limitations: [],
};

for (const width of [390, 1280]) test(`an Archenemy deck shows its scheme deck apart at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await fixture(page, true);
  mock.decks.unshift({ id: "villain", name: "Villain's lair", notes: "", format: "commander", match_mode: "any", version: 1, scheme_copies: 2, legality,
    cards: [{ printing_id: printings[1].id, quantity: 1, section: "commander" }, { printing_id: printings[0].id, quantity: 4, section: "main" }, { printing_id: printings[6].id, quantity: 2, section: "schemes" }] });
  await page.reload();
  const box = page.locator('.deck-box-button[data-deck-id="villain"]');
  await expect(box.locator(".deck-box-format")).toHaveText("commander · archenemy");
  await expect(box.locator(".deck-box-count")).toHaveText("5 cards");
  await box.click();
  await expect(page.locator(".batch-detail-meta")).toContainText("5 cards · 2 schemes");
  const schemes = page.locator('[data-card-board="schemes"]');
  await expect(schemes.locator("h3")).toHaveText("Scheme deck 2");
  await expect(page.getByText("✓ Passes Commander Archenemy checks")).toBeVisible();
  await expect(page.getByText("1 commander · 4 mainboard · 0 extras · 2 schemes")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await schemes.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("deck.png"), fullPage: true });

  await page.getByRole("button", { name: "Edit deck" }).click();
  await page.getByLabel("Add cards to").selectOption("schemes");
  await expect(page.getByText("Scheme deck for playing Archenemy.")).toBeVisible();
  await page.getByLabel("Add cards to").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("editing.png") });
});
