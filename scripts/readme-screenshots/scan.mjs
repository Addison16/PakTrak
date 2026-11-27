// A finished scan of one binder page: seven cards added on their own, two waiting for a check.
import { binderPhoto, cardSvg } from "./art.mjs";
import { byName, printing } from "./data.mjs";

const names = ["Emberclaw Wyrm", "Tidecaller Adept", "Grovewarden Elk", "Sunforged Paladin", "Duskmire Revenant", "Lantern of the Vale", "Stormglass Sage", "Thornveil Druid", "Ashen Cartographer"];
const pageCards = names.map(byName);
const photo = binderPhoto(pageCards);
const id = "binder-page";
const base = "/api/v1/scans/" + id;
const review = new Set([3, 7]);
const scores = [0.97, 0.95, 0.96, 0.84, 0.93, 0.98, 0.94, 0.81, 0.92];

const rows = pageCards.map((card, i) => {
  const p = printing(card);
  const imported = !review.has(i);
  return { id: "region-" + i, region_index: i, polygon: photo.regions[i], version: 1, state: imported ? "COMMITTED" : "NEEDS_REVIEW",
    finish: i === 0 ? "foil" : "nonfoil", rotation: 0, crop_url: `${base}/observations/region-${i}/image`,
    recognition: { status: "MATCHED", reason: imported ? "" : "Two printings share this artwork. Check the collector number.", auto_imported: imported },
    candidates: [{ printing_id: p.id, printing: p, match_score: scores[i], evidence: ["Card name matches", "Set and collector number match", "Artwork features match"] },
      ...(imported ? [] : [{ printing_id: p.id + "-alt", printing: { ...p, id: p.id + "-alt", collector_number: String(Number(p.collector_number) + 300) }, match_score: scores[i] - 0.06, evidence: ["Card name matches", "Artwork features match"] }])],
    estimate: { min: card.price, max: card.price }, finish_prices: { nonfoil: card.price, foil: (Number(card.price) * 1.8).toFixed(2) },
    owned_elsewhere: i === 2 ? { name: card.name, copies: 7, locations: ["Commander staples"] } : null,
    lot: imported ? { id: "lot-" + i, version: 1, printing: p, finish: i === 0 ? "foil" : "nonfoil", condition: "near_mint", quantity: 1, binder: "Red binder" } : null };
});
const summary = { regions: 9, cards: 9, identified: 9, checked: 9, imported: 7, confirmed: 7, needs_review: 2, value_min: "105.20", value_max: "105.20", priced_cards: 9, unpriced_cards: 0, unknown_finish: 0,
  provider: "tcgplayer", prices_updated_at: "2026-11-26T06:10:00Z", auto_add_enabled: true, auto_add_threshold: 0.88 };
const scan = { id, filename: "Binder page 12.jpg", state: "PHOTO_READY", uploaded: true, accepted_at: "2026-11-26T19:02:00Z", created_at: "2026-11-26T19:01:00Z", expires_at: "2026-12-03T19:01:00Z",
  width: photo.width, height: photo.height, thumbnail_url: base + "/image", duplicate_scan_id: null, finishes_confirmed: true, add_to_collection: true, summary,
  preview_cards: rows.slice(0, 6).map((r) => ({ id: r.id, name: r.candidates[0].printing.name, image_url: r.crop_url })),
  job: { id: "job", state: "SUCCEEDED", stage: "Done", attempts: 1, error_message: null, progress: null } };

export const scanHandlers = () => ({
  "/api/v1/scans": () => ({ items: [scan], next_offset: null }),
  [base]: () => scan,
  [base + "/image"]: () => ({ status: 200, contentType: "image/svg+xml", body: photo.svg }),
  [base + "/observations"]: ({ method }) => method === "GET" ? { items: rows, summary, finishes: { foil_count: 1, foil_ids: ["region-0"], etched_ids: [], confirmed: true, token: "f".repeat(64) } } : undefined,
  [base + "/observations/*"]: ({ path }) => {
    const i = Number(path.match(/region-(\d+)/)?.[1]);
    if (path.endsWith("/image")) return { status: 200, contentType: "image/svg+xml", body: cardSvg(pageCards[i]) };
  },
  [base + "/reference/*"]: ({ path }) => {
    const pid = path.split("/")[6].replace("-alt", "");
    const card = pageCards.find((c) => printing(c).id === pid);
    return { status: 200, contentType: "image/svg+xml", body: cardSvg(card) };
  },
});
export { id as scanId };
