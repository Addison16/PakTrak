import { expect, test } from "@playwright/test";
import { fixture, printings } from "./deck-fixture";

const original = printings.slice(0, 3).map((printing) => ({ ...printing }));
// The fixture printings are shared with other deck tests, so put them back afterwards.
test.afterEach(() => { original.forEach((printing, index) => { Object.keys(printings[index]).forEach((key) => delete (printings[index] as any)[key]); Object.assign(printings[index], printing); }); });

test("a saved deck shows its mana curve and offers Arena and MTGO exports", async ({ page }) => {
  Object.assign(printings[0], { cmc: 3, type_line: "Creature — Dragon" });
  Object.assign(printings[1], { cmc: 5, type_line: "Legendary Creature — Elf" });
  Object.assign(printings[2], { cmc: 1, type_line: "Instant" });
  await fixture(page);
  await page.getByRole("button", { name: /Friday night/ }).click();
  const stats = page.getByRole("region", { name: "Mana curve and sample hand" });
  // Four copies at 3 and the commander at 5; the sideboard card is left out.
  await expect(stats.getByRole("img", { name: /^Mana curve:/ })).toHaveAttribute("aria-label", "Mana curve: 0 at 0, 0 at 1, 0 at 2, 4 at 3, 0 at 4, 1 at 5, 0 at 6, 0 at 7+");
  await expect(stats).toContainText("0 lands · average 3.40");
  await page.getByText("Export deck list", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Export for MTG Arena", exact: true })).toHaveAttribute("href", "/api/v1/decks/saved-deck/download?format=arena");
  await expect(page.getByRole("link", { name: "Export for MTGO", exact: true })).toHaveAttribute("href", "/api/v1/decks/saved-deck/download?format=mtgo");
});
