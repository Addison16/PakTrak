import type { DataFeed, PriceSource, Printing } from "./api";

export type Section = "main" | "sideboard" | "commander";
export type MatchMode = "any" | "exact";
export type DeckCard = { printing: Printing; section: Section; quantity: number; owned: number; needed_in_deck: number; available: number; missing: number; locations: { id: string; name: string; quantity: number }[] };
export type DeckCover = { id: string; name: string; image_url: string | null; art_url?: string | null; section?: Section };
export type DeckSummary = { id: string; name: string; format: string; match_mode: MatchMode; notes: string; version: number; updated_at?: string; copies: number; unique_printings?: number; preview_cards?: DeckCover[]; cover_cards?: DeckCover[]; colors?: string[]; colors_known?: boolean };
export type DeckLegality = { format: string; status: "legal" | "issues" | "incomplete" | "not_checked"; issues: { code: string; severity: "error" | "warning" | "info"; message: string; printing_ids: string[] }[]; counts: Record<Section, number>; catalog_updated_at: string | null; checked_at: string; rules_version: string; checks: string[]; limitations: string[] };
export type TokenFace = { name: string; type_line: string; colors: string[] | null; power: string | null; toughness: string | null; oracle_text: string; image_url: string | null; detail_image_url: string | null };
export type DeckToken = { id: string; name: string; kind: "token" | "emblem"; details_available: boolean; sideboard_only: boolean; faces: TokenFace[]; sources: { printing_id: string; name: string; sections: Section[] }[] };
export type DeckTokens = { items: DeckToken[]; missing_details: number };
export type DeckCollection = { copies: number; owned_copies: number; missing_copies: number; cards: DeckCard[]; missing_cards: { printing: Printing; quantity: number }[] };
export type Deck = DeckSummary & DeckCollection & { archived?: boolean; legality?: DeckLegality; tokens?: DeckTokens; valuation?: DeckValuation };
export type DeckWorkState = { dirty: boolean; busy: boolean };
export const formats = ["casual", "commander", "standard", "modern", "pioneer", "pauper", "legacy", "vintage", "limited", "other"];
export const sections: Record<Section, string> = { main: "Mainboard", sideboard: "Sideboard", commander: "Commander" };

export type FinishPreference = "nonfoil" | "foil" | "etched";
export type ValueTotal = { amount: string | null; copies: number; priced_copies: number; unpriced_copies: number };
export type DeckValueItem = { printing_id: string; name: string; set_code: string; collector_number: string; section: Section; quantity: number; finish: FinishPreference | null; finish_fallback: boolean; unit_amount: string | null; amount: string | null; unpriced_reason: "missing_price" | "unknown_finish" | null };
export type DeckValuation = ValueTotal & { provider: PriceSource; currency: "USD"; price_kind: string; finish_preference: FinishPreference; fallback_copies: number; sections: Record<Section, ValueTotal>; items: DeckValueItem[]; feed: DataFeed | null; checked_at: string };
