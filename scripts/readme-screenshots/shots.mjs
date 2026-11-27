import { scanHandlers, scanId } from "./scan.mjs";
import { anyByName, printing } from "./data.mjs";

const toTop = async (page, selector, offset = 12) => {
  await page.locator(selector).first().evaluate((el, offset) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - offset), offset);
};
const mover = (name, oldAmount, newAmount, extra = {}) => {
  const card = anyByName(name), change = (Number(newAmount) - Number(oldAmount)).toFixed(2);
  return { printing_id: card.id, name, set_code: card.set, collector_number: String(card.number), finish: "nonfoil", quantity: 1, image_url: printing(card).image_url, old_amount: oldAmount, new_amount: newAmount, change, percent: Math.round(Number(change) / Number(oldAmount) * 1000) / 10, since: "2026-11-19T12:00:00Z", ...extra };
};
const alerts = () => ({
  "/api/v1/price-alerts": ({ method }) => method !== "GET" ? undefined : {
    settings: { enabled: true, percent: 20, amount: "1.00" }, provider: "tcgplayer", currency: "USD", feed: null,
    rises: [mover("Emberclaw Wyrm", "36.10", "48.50", { quantity: 4 }), mover("Lantern of the Vale", "17.25", "22.40", { quantity: 2 }), mover("Hushwood Ravine", "11.80", "14.90", { quantity: 2 })],
    drops: [mover("Tidecaller Adept", "16.40", "12.25")], rise_count: 3, drop_count: 1, rise_total: "65.10", drop_total: "4.15",
    collection: { change: "58.20", percent: 17.6, since: "2026-11-19" } },
});
const trade = (page) => page.addInitScript((value) => { try { sessionStorage.setItem("paktrak:trade:demo-owner", JSON.stringify(value)); } catch {} }, {
  friend: null,
  give: [["Emberclaw Wyrm", "foil", 1], ["Stormglass Sage", "nonfoil", 2]].map(([n, finish, quantity]) => ({ key: n + finish, printing: printing(anyByName(n)), finish, quantity })),
  get: [["Tempest Archive", "nonfoil", 1], ["Starfall Herald", "nonfoil", 1], ["Veilwalker Assassin", "nonfoil", 1], ["Mossback Colossus", "nonfoil", 1], ["Mirrorlake Seer", "nonfoil", 4]].map(([n, finish, quantity]) => ({ key: n + finish, printing: printing(anyByName(n)), finish, quantity })),
});

export default [
  { name: "scan-photo", handlers: scanHandlers, run: async (page, base) => {
    await page.goto(base + "/#/batches/" + scanId);
    await page.getByText("View photo and card outlines").click();
    await page.locator(".region-photo img").waitFor();
    await toTop(page, ".scan-photo-details", 90);
  } },
  { name: "scan-review", handlers: scanHandlers, run: async (page, base) => {
    await page.goto(base + "/#/batches/" + scanId);
    await page.locator(".scan-gallery").waitFor();
    await toTop(page, ".scan-queue-tools", 24);
  } },
  { name: "collection", run: async (page, base) => { await page.goto(base + "/#/collection"); await page.locator(".gallery-card").first().waitFor(); await toTop(page, ".gallery-grid", 24); } },
  { name: "card-details", run: async (page, base) => {
    await page.goto(base + "/#/collection?card=demo-01");
    const dialog = page.getByRole("dialog", { name: "Emberclaw Wyrm", exact: true });
    await dialog.locator(".card-rules").waitFor();
    await page.waitForTimeout(600);
    await dialog.locator(".card-rules").evaluate((el) => { el.scrollIntoView({ block: "start" }); let p = el.parentElement; while (p && p.scrollTop === 0) p = p.parentElement; if (p) p.scrollTop -= 90; });
  } },
  { name: "price-history", run: async (page, base) => {
    await page.goto(base + "/#/collection?card=demo-01");
    const dialog = page.getByRole("dialog", { name: "Emberclaw Wyrm", exact: true });
    await dialog.locator(".price-section").waitFor();
    await page.waitForTimeout(600);
    await dialog.locator(".price-section").evaluate((el) => el.scrollIntoView({ block: "start" }));
  } },
  { name: "decks", run: async (page, base) => { await page.goto(base + "/#/decks"); await page.getByText("Archon of the Rift").first().waitFor(); await page.waitForTimeout(1500); } },
  { name: "deck", run: async (page, base) => { await page.goto(base + "/#/decks/archon"); await page.getByRole("region", { name: "Deck stats" }).waitFor(); await page.waitForTimeout(1500); } },
  { name: "deck-stats", run: async (page, base) => {
    await page.goto(base + "/#/decks/embers"); const stats = page.getByRole("region", { name: "Deck stats" }); await stats.waitFor(); await page.waitForTimeout(800);
    await toTop(page, "section[aria-label='Deck stats'], [aria-label='Deck stats']", 12);
  } },
  { name: "collection-breakdown", run: async (page, base) => {
    await page.goto(base + "/#/collection"); await page.getByText("Collection breakdown").click();
    await page.locator(".breakdown-table").waitFor(); await toTop(page, ".breakdown-table", 140);
  } },
  { name: "price-alerts", handlers: alerts, run: async (page, base) => {
    await page.goto(base + "/#/scan"); await page.locator(".price-alert-banner, [class*='price-alert']").first().click();
    await page.getByText("Whole collection").waitFor();
  } },
  { name: "wishlist", run: async (page, base) => { await page.goto(base + "/#/wishlist"); await page.locator(".wish-reached").first().waitFor(); await toTop(page, "main h1, main h2", 100); } },
  { name: "trade-value", run: async (page, base) => { await trade(page); await page.goto(base + "/#/trade"); await page.getByText("Starfall Herald").first().waitFor(); await page.waitForTimeout(800); } },
  { name: "desktop-decks", desktop: true, run: async (page, base) => { await page.goto(base + "/#/decks"); await page.getByText("Archon of the Rift").first().waitFor(); await page.waitForTimeout(1500); } },
  { name: "desktop-deck", desktop: true, run: async (page, base) => { await page.goto(base + "/#/decks/archon"); await page.getByRole("region", { name: "Deck stats" }).waitFor(); await page.waitForTimeout(1500); await toTop(page, ".deck-card-list-heading", 30); } },
];
