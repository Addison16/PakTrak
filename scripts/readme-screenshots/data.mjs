// Invented cards, sets, binders and decks for README screenshots.
const raw = [
  // name, type, set, number, color, rarity, cmc, mana, price, qty, location
  ["Emberclaw Wyrm", "Creature — Dragon", "eld2", 17, "R", "mythic", 6, "{4}{R}{R}", "48.50", 4, "red", ["R"]],
  ["Tidecaller Adept", "Creature — Merfolk Wizard", "skr", 28, "U", "rare", 3, "{1}{U}{U}", "12.25", 1, "trade", ["U"]],
  ["Grovewarden Elk", "Creature — Elk", "dsk2", 39, "G", "common", 4, "{3}{G}", "0.85", 7, "staples", ["G"]],
  ["Lantern of the Vale", "Artifact", "eld2", 50, "C", "rare", 2, "{2}", "22.40", 2, "red", []],
  ["Sunforged Paladin", "Creature — Human Knight", "skr", 61, "W", "uncommon", 3, "{2}{W}", "3.10", 3, "staples", ["W"]],
  ["Duskmire Revenant", "Creature — Zombie Knight", "dsk2", 72, "B", "rare", 4, "{2}{B}{B}", "9.75", 2, "red", ["B"]],
  ["Riftborn Archon", "Legendary Creature — Archon", "dsk2", 138, "M", "mythic", 5, "{2}{W}{U}{B}", "31.00", 1, "staples", ["W", "U", "B"]],
  ["Stormglass Sage", "Creature — Human Wizard", "skr", 33, "U", "uncommon", 2, "{1}{U}", "1.40", 5, "trade", ["U"]],
  ["Cinder Courier", "Instant", "eld2", 88, "R", "common", 1, "{R}", "0.35", 9, "bulk", ["R"]],
  ["Thornveil Druid", "Creature — Elf Druid", "dsk2", 44, "G", "uncommon", 2, "{1}{G}", "2.60", 3, "staples", ["G"]],
  ["Gilded Compass", "Artifact", "skr", 230, "C", "uncommon", 1, "{1}", "4.80", 2, "staples", []],
  ["Ashen Cartographer", "Creature — Human Scout", "eld2", 141, "M", "rare", 3, "{1}{B}{R}", "6.20", 1, "red", ["B", "R"]],
  ["Hushwood Ravine", "Land", "dsk2", 260, "L", "rare", 0, "", "14.90", 2, "staples", []],
  ["Pale Moon Vigil", "Enchantment", "skr", 19, "W", "rare", 2, "{1}{W}", "5.55", 1, "trade", ["W"]],
  ["Saltmarsh Pact", "Sorcery", "skr", 52, "B", "common", 3, "{2}{B}", "0.25", 6, "bulk", ["B"]],
  ["Glimmerfen Crossing", "Land", "eld2", 251, "L", "uncommon", 0, "", "0.60", 4, "bulk", []],
];
export const sets = { eld2: "Embers of Eldmoor", skr: "Skyreach", dsk2: "Duskhollow" };
export const locations = [
  { id: "red", name: "Red binder", kind: "binder", notes: "", version: 1, copies: 0 },
  { id: "staples", name: "Commander staples", kind: "binder", notes: "", version: 1, copies: 0 },
  { id: "trade", name: "Trade box", kind: "box", notes: "", version: 1, copies: 0 },
  { id: "bulk", name: "Bulk box", kind: "box", notes: "", version: 1, copies: 0 },
];
export const cards = raw.map(([name, type, set, number, color, rarity, cmc, mana, price, qty, loc, colors], index) => ({
  id: "demo-" + String(index + 1).padStart(2, "0"), name, type, set, number, color, rarity, cmc, mana, price, qty, loc, colors,
}));
export const byName = (name) => cards.find((card) => card.name === name);
export const printing = (card) => ({
  id: card.id, name: card.name, set_code: card.set, set_name: sets[card.set], collector_number: String(card.number), language: "en",
  finishes: ["nonfoil", "foil"], rarity: card.rarity, type_line: card.type, mana_cost: card.mana, cmc: card.cmc, colors: card.colors,
  produced_mana: card.color === "L" ? (card.name.startsWith("Hush") ? ["B", "G"] : ["W", "U", "B", "R"]) : [],
  image_url: `/api/v1/card-images/${card.id}/0/grid`,
});
for (const location of locations) location.copies = cards.filter((card) => card.loc === location.id).reduce((sum, card) => sum + card.qty, 0);
// Cards you don't own yet, for the wishlist and set pages.
export const extras = [
  ["Starfall Herald", "Creature — Angel", "skr", 7, "W", "mythic", 5, "{3}{W}{W}", "27.80"],
  ["Veilwalker Assassin", "Creature — Human Assassin", "dsk2", 81, "B", "rare", 3, "{1}{B}{B}", "8.40"],
  ["Mossback Colossus", "Creature — Plant Giant", "eld2", 166, "G", "rare", 7, "{5}{G}{G}", "3.95"],
  ["Tempest Archive", "Artifact", "skr", 240, "C", "mythic", 4, "{4}", "41.25"],
  ["Ironbark Sentinel", "Creature — Treefolk", "skr", 120, "G", "common", 4, "{3}{G}", "0.20"],
  ["Mirrorlake Seer", "Creature — Elf Wizard", "skr", 44, "U", "uncommon", 2, "{U}{U}", "0.75"],
].map(([name, type, set, number, color, rarity, cmc, mana, price], index) => ({
  id: "extra-" + String(index + 1).padStart(2, "0"), name, type, set, number, color, rarity, cmc, mana, price, qty: 0, loc: null, colors: color.length === 1 && "WUBRG".includes(color) ? [color] : [],
}));
export const anyCard = (id) => [...cards, ...extras].find((card) => card.id === id);
export const anyByName = (name) => [...cards, ...extras].find((card) => card.name === name);
