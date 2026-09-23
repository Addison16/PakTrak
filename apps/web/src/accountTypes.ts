import type { RefObject } from "react";
import type { Session } from "./api";

export type Account = {
  id: string; display_name: string; role: Session["role"]; created_at: string; approved_at: string | null;
  scan_cards_used: number; scan_card_limit: number | null; scan_card_limit_override: number | null;
  scan_cards_remaining: number | null; scans_paused: boolean; suspended: boolean; account_version: number;
  password_reset_pending?: boolean;
  collection_copies?: number; saved_decks?: number; saved_batches?: number; active_sessions?: number;
  activity?: { kind: string; created_at: string; detail: Record<string, unknown> }[];
};
export type AccountNavigation = RefObject<(() => boolean) | null>;
export const accountRole = (role: string) => role === "admin" ? "Administrator" : role === "guest" ? "Guest" : "Standard member";
