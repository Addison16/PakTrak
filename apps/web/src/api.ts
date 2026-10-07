import type { StoreLinks } from "./storeLinks";
export type PriceSource = "tcgplayer" | "cardkingdom" | "manapool";
export type Session = { store_links?: StoreLinks; scans_paused?: boolean; suspended?: boolean; scan_card_limit_override?: number | null; account_version?: number; membership_welcome?: boolean; approved_at?: string | null; tour_dismissed: boolean; preferred_price_source: PriceSource | null; owner_id: string; display_name: string; csrf_token: string; role: "admin" | "member" | "guest"; scan_cards_used: number; scan_card_limit: number | null; scan_cards_remaining: number | null };
export type Location = { id: string; name: string; kind: "binder" | "box" | "other"; notes: string; version: number; copies: number };
export type Lot = { id: string; printing: Printing; quantity: number; finish: string; condition: string; binder: string; binder_id: string; binder_kind: string; notes: string; version: number };
export type PricingIssues = { unknown_finish: number; custom_value: number; missing_price: number };
export type CollectionCard = { printing: Printing; quantity: number; location_count: number; locations: { id: string; name: string; kind: string; quantity: number }[]; value: string | null; priced_copies: number; price_min: string | null; price_max: string | null; pricing_issues?: PricingIssues; finish_counts?: Partial<Record<"nonfoil" | "foil" | "etched" | "unknown", number>> };
export type Printing = { id: string; name: string; display_name?: string; set_code: string; collector_number: string; language: string; finishes: string[]; set_name?: string; type_line?: string; mana_cost?: string; cmc?: number | null; rarity?: string; colors?: string[]; image_url?: string | null };
export type Finish = "nonfoil" | "foil" | "etched";
export type WantedFinish = Finish | "any";
export type WishlistItem = { id: string; printing: Printing; finish: WantedFinish; quantity: number; notes?: string; price_finish: Finish | null; unit_amount: string | null; owned: number };
export type Wishlist = { provider: PriceSource; items: WishlistItem[]; copies: number; priced_copies: number; amount: string | null };
export type OfferCard = { printing: Printing; finish: Finish; quantity: number; unit_amount: string | null };
export type TradeOffer = { id: string; direction: "incoming" | "outgoing"; friend: { id: string | null; name: string }; state: "pending" | "accepted" | "declined" | "cancelled"; message: string; created_at: string; responded_at: string | null; applied: boolean; attention: null | "respond" | "apply" | "declined" | "cancelled"; give: OfferCard[]; get: OfferCard[]; give_amount: string | null; get_amount: string | null; give_unpriced: number; get_unpriced: number; provider: PriceSource };
export type Friend = { id: string; user_id: string; name: string; since: string | null; shares_collection: boolean; shares_wishlist: boolean };
export type HistoryPoint = { day: string; amount: string };
export type HistoryChange = { amount: string; percent: number | null; since: string } | null;
export type WorkProgress = { phase: string; done: number; total: number | null; unit: string; eta_seconds: number | null; measured_at: string };
export type DataFeed = { name: string; state: string; progress: Partial<WorkProgress>; updated_at?: string; source_time?: string; next_at?: string; records?: number; error?: string; stale: boolean };
export const providers: Record<string, string> = { tcgplayer: "TCGplayer", cardkingdom: "Card Kingdom", manapool: "ManaPool" };
export const isPriceSource = (value: unknown): value is PriceSource => typeof value === "string" && Object.hasOwn(providers, value);
export const money = (value: string | number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));

export class ApiError extends Error {
  detail: Record<string, string>;
  status?: number;
  requestId?: string;
  code?: string;
  action: string;
  userMessage: string;
  occurredAt: string;
  constructor(message: string, detail: Record<string, string> = {}, status?: number, info: { requestId?: string; code?: string; action?: string } = {}) {
    const readable = info.action ? `${info.action}: ${message}` : message;
    super(readable + (info.requestId ? ` Reference: ${info.requestId}.` : ""));
    this.name = "ApiError"; this.detail = detail; this.status = status; this.requestId = info.requestId;
    this.code = info.code; this.action = info.action || "Request"; this.userMessage = readable; this.occurredAt = new Date().toISOString();
  }
}

type RequestOptions = RequestInit & { action?: string; quiet?: boolean };
export function requestAction(path: string, method = "GET") {
  const endpoint = path.split("?")[0];
  if (endpoint === "/api/auth/session") return "Refresh sign-in";
  if (endpoint === "/api/auth/logout") return "Sign out";
  if (endpoint.endsWith("/reset-password")) return "Reset user password";
  if (endpoint.startsWith("/api/auth/")) return method === "GET" ? "Load account details" : "Save account changes";
  if (endpoint.startsWith("/api/v1/diagnostics/")) return "Load error logs";
  if (endpoint.endsWith("/finishes")) return "Save card finishes";
  if (endpoint.endsWith("/approve")) return "Import scanned cards";
  if (endpoint.endsWith("/finalize")) return "Start photo processing";
  if (endpoint.endsWith("/upload")) return "Upload photo";
  if (endpoint.endsWith("/identify")) return "Recheck photo";
  if (endpoint.startsWith("/api/v1/scans")) return method === "GET" ? endpoint === "/api/v1/scans" ? "Refresh batches" : "Refresh batch" : method === "DELETE" ? "Delete batch" : "Save photo batch";
  if (endpoint.startsWith("/api/v1/decks")) return endpoint.endsWith("/legality") ? "Check deck legality" : endpoint.endsWith("/import-preview") ? "Preview deck list" : method === "GET" ? "Load decks" : "Save deck";
  if (endpoint.startsWith("/api/v1/catalog")) return "Find cards";
  if (endpoint.startsWith("/api/v1/wishlist")) return method === "GET" ? "Load wishlist" : "Save wishlist";
  if (endpoint.startsWith("/api/v1/friends")) return method === "GET" ? "Load friends" : "Save friend settings";
  if (endpoint.startsWith("/api/v1/trade-offers")) return method === "GET" ? "Load trade offers" : "Save trade offer";
  if (endpoint.startsWith("/api/v1/collection/sets")) return "Load set completion";
  if (endpoint.endsWith("-history")) return "Load price history";
  if (endpoint.startsWith("/api/v1/collection")) return method === "GET" ? "Load collection" : "Save collection changes";
  if (endpoint.startsWith("/api/v1/imports")) return "Import collection";
  if (endpoint.startsWith("/api/v1/exports")) return "Export collection";
  if (endpoint.startsWith("/api/v1/binders")) return method === "GET" ? "Load storage locations" : "Save storage location";
  return method === "GET" ? "Load app data" : "Save changes";
}

function reportError(error: ApiError, quiet?: boolean) {
  if (!quiet) console.warn("PakTrak request error", { action: error.action, status: error.status, code: error.code, request_id: error.requestId, time: error.occurredAt });
  return error;
}

function fieldMessage(details: { loc?: (string | number)[]; msg?: string }[]) {
  return details.filter((item) => item && typeof item === "object").slice(0, 4).map((item) => {
    const field = (Array.isArray(item.loc) ? item.loc : []).filter((part) => (typeof part === "string" || typeof part === "number") && !["body", "query", "path", "header"].includes(String(part))).map((part) => typeof part === "number" ? String(part + 1) : part.replaceAll("_", " ")).join(" · ");
    return `${field ? field[0].toUpperCase() + field.slice(1) + ": " : ""}${typeof item.msg === "string" ? item.msg : "Check this value."}`;
  }).join(" ") || "Some request fields were invalid. Review your entries and try again.";
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { quiet, action = requestAction(path, options.method), ...init } = options;
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: "same-origin" }); }
  catch (e) {
    if (init.signal?.aborted || (e as Error).name === "AbortError") throw e;
    throw reportError(new ApiError(navigator.onLine ? "The server could not be reached. Check your connection and try again." : "You’re offline. Reconnect and try again.", {}, undefined, { action, code: "network_error" }), quiet);
  }
  const rawId = response.headers.get("X-Request-ID");
  const requestId = rawId && /^[a-f0-9-]{36}$/i.test(rawId) ? rawId : undefined;
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const data = payload && typeof payload === "object" ? payload : {};
    const fallback = response.status >= 500 ? "The server is temporarily unavailable. Try again shortly."
      : response.status === 429 ? "Too many requests or an account limit was reached. Wait a moment and try again."
      : response.status === 404 ? "This item is no longer available. Refresh the list and try again."
      : response.status === 403 ? "This action could not be verified or is not allowed for this account."
      : response.status === 422 ? "Some request fields were invalid. Review your entries and try again."
      : `The server returned error ${response.status}. Try the action again.`;
    const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? fieldMessage(data.detail) : typeof data.detail?.message === "string" ? data.detail.message : fallback;
    throw reportError(new ApiError(response.status === 401 ? "Your session ended. Sign in again to see your saved work." : detail, data.detail && typeof data.detail === "object" && !Array.isArray(data.detail) ? data.detail : {}, response.status, { action, requestId, code: typeof data.error_code === "string" ? data.error_code : undefined }), quiet);
  }
  try { return await response.json(); }
  catch (e) {
    if (init.signal?.aborted || (e as Error).name === "AbortError") throw e;
    throw reportError(new ApiError("The server returned an unreadable response. Try the action again.", {}, response.status, { action, requestId, code: "invalid_response" }), quiet);
  }
}

export function mutation(session: Session, data?: unknown, key: string = crypto.randomUUID()): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token, "Idempotency-Key": key },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) };
}

// A source change can outlive the Collection screen. Finish it before a remount
// reads the account, and serialize a later explicit choice behind that write.
const priceSourceSaves = new Map<string, Promise<{ preferred_price_source: PriceSource }>>();
export async function waitForPriceSourceSave(owner: string) {
  await priceSourceSaves.get(owner)?.catch(() => {});
}
export async function savePriceSource(session: Session, source: PriceSource, migration: boolean) {
  const previous = priceSourceSaves.get(session.owner_id);
  const pending = (async () => {
    await previous?.catch(() => {});
    return request<{ preferred_price_source: PriceSource }>("/api/auth/preferences", {
      ...mutation(session, { price_source: source, ...(migration ? { only_if_unset: true } : {}) }), method: "PATCH",
    });
  })();
  priceSourceSaves.set(session.owner_id, pending);
  try {
    const result = await pending;
    window.dispatchEvent(new CustomEvent("paktrak:price-source", { detail: { owner: session.owner_id } }));
    return result;
  }
  finally { if (priceSourceSaves.get(session.owner_id) === pending) priceSourceSaves.delete(session.owner_id); }
}
