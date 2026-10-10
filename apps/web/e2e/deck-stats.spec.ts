import { expect, test } from "@playwright/test";
import { fixture, printings } from "./deck-fixture";

const original = printings.slice(0, 6).map((printing) => ({ ...printing }));
// The fixture printings are shared with other deck tests, so put them back afterwards.
test.afterEach(() => { original.forEach((printing, index) => { Object.keys(printings[index]).forEach((key) => delete (printings[index] as any)[key]); Object.assign(printings[index], printing); }); });

test("a saved deck shows its mana curve and offers Arena and MTGO exports", async ({ page }) => {
  Object.assign(printings[0], { cmc: 3, type_line: "Creature — Dragon" });
  Object.assign(printings[1], { cmc: 5, type_line: "Legendary Creature — Elf" });
  Object.assign(printings[2], { cmc: 1, type_line: "Instant" });
  await fixture(page);
  await page.getByRole("button", { name: /Friday night/ }).click();
  const stats = page.getByRole("region", { name: "Deck stats" });
  // Four copies at 3 and the commander at 5; the sideboard card is left out.
  await expect(stats.getByRole("img", { name: /^Mana curve:/ })).toHaveAttribute("aria-label", "Mana curve: 0 at 0, 0 at 1, 0 at 2, 4 at 3, 0 at 4, 1 at 5, 0 at 6, 0 at 7+");
  await expect(stats).toContainText("0 lands · average 3.40");
  await page.getByText("Export deck list", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Export for MTG Arena", exact: true })).toHaveAttribute("href", "/api/v1/decks/saved-deck/download?format=arena");
  await expect(page.getByRole("link", { name: "Export for MTGO", exact: true })).toHaveAttribute("href", "/api/v1/decks/saved-deck/download?format=mtgo");
});

test("a deck shows land drop odds, color balance and card types", async ({ page }) => {
  Object.assign(printings[3], { cmc: 0, type_line: "Basic Land — Forest", mana_cost: "", produced_mana: ["G"] });
  Object.assign(printings[4], { cmc: 3, type_line: "Artifact Creature — Golem", mana_cost: "{1}{G}{G}" });
  Object.assign(printings[5], { cmc: 1, type_line: "Instant", mana_cost: "{U/P}" });
  const { saved } = await fixture(page);
  saved.cards = [{ printing_id: printings[3].id, quantity: 24, section: "main" }, { printing_id: printings[4].id, quantity: 20, section: "main" }, { printing_id: printings[5].id, quantity: 16, section: "main" }];
  await page.getByRole("button", { name: /Friday night/ }).click();
  const stats = page.getByRole("region", { name: "Deck stats" });
  await expect(stats).toContainText("24 of 60 cards are lands. An opening hand of 7 averages 2.8 lands and has 2 to 4 of them 77% of the time.");
  // 24 lands in 60 cards: the well-known odds of hitting the first three land drops on the play.
  await expect(stats.getByRole("row", { name: /^1 / })).toHaveText("11.098%99%");
  await expect(stats.getByRole("row", { name: /^3 / })).toContainText("2.779%");
  await expect(stats.getByRole("group", { name: /^Green:/ })).toHaveAttribute("aria-label", "Green: 40 mana symbols, 71% of all symbols. 24 cards make green mana.");
  await expect(stats.getByRole("group", { name: /^Blue:/ })).toContainText("16 · 29%");
  await expect(stats).toContainText("Blue is 29% of your symbols but only 0% of your mana cards make it.");
  await expect(stats.getByRole("definition")).toHaveText(["20", "16", "20", "24"]);
  await expect(stats.getByRole("term")).toHaveText(["Creatures", "Instants", "Artifacts", "Lands"]);
});
