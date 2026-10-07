import type { Printing, PriceSource, WorkProgress } from "./api";

export type Scan = {
  id: string; filename: string; state: string; uploaded: boolean;
  accepted_at: string | null; created_at: string; expires_at: string | null;
  width: number | null; height: number | null; thumbnail_url: string | null;
  duplicate_scan_id: string | null; finishes_confirmed?: boolean;
  add_to_collection?: boolean; target_deck?: { id: string; name: string; archived: boolean } | null;
  summary?: Summary;
  preview_cards?: { id: string; name: string; image_url: string | null }[];
  job: { id: string; state: string; stage: string; attempts: number; error_message: string | null; progress?: WorkProgress | null } | null;
};
export type ReviewState = { dirty: boolean; busy: boolean };

export type Candidate = { printing_id: string; printing: Printing; match_score: number; evidence: string[] };
export type Region = { id: string; region_index: number; polygon: number[][]; state: string; version: number; crop_url: string | null;
  rotation: 0 | 180;
  finish: string; candidates: Candidate[]; confirmed_printing?: Printing | null; recognition: { status?: string; reason?: string; auto_imported?: boolean; auto_confirmed?: boolean };
  estimate: { min: string; max: string } | null;
  owned_elsewhere?: { name: string; copies: number; locations: string[] } | null;
  lot: { id: string; version: number; printing: Printing; finish: string; condition: string; quantity: number; binder: string } | null };
export type FinishPlan = { foil_count: number | null; foil_ids: string[]; etched_ids: string[]; confirmed: boolean; token: string };
export type Summary = { regions: number; cards: number; identified: number; checked: number; imported: number; confirmed?: number; needs_review: number;
  value_min: string | null; value_max: string | null; priced_cards: number; unpriced_cards: number; unknown_finish: number;
  provider: PriceSource; prices_updated_at: string | null; auto_add_enabled: boolean; auto_add_threshold: number };
export type Batch = { items: Region[]; summary: Summary; finishes: FinishPlan; add_to_collection?: boolean };
