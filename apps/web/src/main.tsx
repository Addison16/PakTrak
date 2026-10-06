import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, mutation, request, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";
import { Icon } from "./Icon";
import Onboarding from "./Onboarding";
import MembershipWelcome from "./MembershipWelcome";
import { useOnboarding } from "./useOnboarding";
import BatchList, { batchNeedsReview, batchStatus } from "./BatchList";
import type { ReviewState, Scan } from "./scanTypes";
import type { Deck } from "./deckTypes";
import { photoAccept, photoFormatLabel, photoMime } from "./photoFormats";
import "./style.css";
import "./qol.css";
import { readPendingPhoto, savePendingPhoto, removePendingPhoto, type PendingPhoto } from "./pendingPhoto";
import { navigation, restoreScroll, sameScreen, useNavigationGuard, useRoute, type Page } from "./navigation";

const Collections = lazy(() => import("./Collections"));
const Review = lazy(() => import("./Review"));
const Decks = lazy(() => import("./Decks"));
const MyAccount = lazy(() => import("./MyAccount"));
const Admin = lazy(() => import("./Admin"));
const CameraCapture = lazy(() => import("./CameraCapture"));
type AccountStatus = { setup_required: boolean; guest_signup_enabled: boolean };
type Draft = { id?: string; key: string; filename: string; size: number; content_type: string; foil_count?: number; target_deck_id?: string; add_to_collection?: boolean; photo_saved_at?: number };

function Navigation({ session, page, onNavigate, onLogout, onReplayTour }: {
  session: Session; page: Page; onNavigate: (page: Page) => void; onLogout: () => void; onReplayTour: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const route = useRoute();
  const open = route.overlay === "menu";
  const [pointerFocus, setPointerFocus] = useState(false);
  const afterClose = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (open) drawer.current?.showModal();
    else if (drawer.current?.open) drawer.current.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
    };
  }, [open]);

  function close() { navigation.close({ ...navigation.route, overlay: undefined }); }
  function navigate(destination: Page) { onNavigate(destination); }

  return <>
    <button ref={trigger} className="menu-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="main-menu"
      onPointerDown={() => setPointerFocus(true)} onKeyDown={() => setPointerFocus(false)}
      onClick={() => navigation.go({ ...route, overlay: "menu" })}>
      <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      Menu
    </button>
    <dialog ref={drawer} id="main-menu" className="navigation-drawer" aria-labelledby="menu-title" data-pointer-focus={pointerFocus || undefined}
      onClose={() => {
        if (navigation.route.overlay === "menu") close();
        if (document.activeElement === document.body || drawer.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
        const next = afterClose.current; afterClose.current = null; next?.();
      }}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => {
        setPointerFocus(false);
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
      }}>
      <div className="menu-heading">
        <div><div className="eyebrow">YOUR PAKTRAK</div><h2 id="menu-title">Menu</h2></div>
        <button type="button" className="menu-close" aria-label="Close menu" autoFocus onClick={close}>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <nav className="menu-links" aria-label="Main navigation">
        <button type="button" aria-current={page === "scan" ? "page" : undefined} onClick={() => navigate("scan")}><Icon name="camera" />Upload photo</button>
        <button type="button" aria-current={page === "batches" ? "page" : undefined} onClick={() => navigate("batches")}><Icon name="batches" />Batches</button>
        <button type="button" aria-current={page === "collection" ? "page" : undefined} onClick={() => navigate("collection")}><Icon name="collection" />Collection</button>
        <button type="button" aria-current={page === "decks" ? "page" : undefined} onClick={() => navigate("decks")}><Icon name="decks" />Decks</button>
        <button type="button" aria-current={page === "transfers" ? "page" : undefined} onClick={() => navigate("transfers")}><Icon name="transfer" />Import / export</button>
        <button type="button" aria-current={page === "account" ? "page" : undefined} onClick={() => navigate("account")}><Icon name="user" />My account</button>
        {session.role === "admin" && <button type="button" aria-current={page === "admin" ? "page" : undefined} onClick={() => navigate("admin")}><Icon name="settings" />Administration</button>}
      </nav>
      <div className="menu-account">
        <button type="button" className="menu-tour" onClick={() => { afterClose.current = onReplayTour; close(); }}><Icon name="spark" />Quick tour</button>
        <p><strong>{session.display_name}</strong><span>{session.role === "admin" ? "Administrator" : session.role === "guest" ? "Guest account" : "Member"}</span></p>
        <button type="button" className="menu-sign-out" onClick={() => { afterClose.current = onLogout; close(); }}>Sign out <Icon name="arrow" /></button>
      </div>
    </dialog>
  </>;
}

function App() {
  const route = useRoute();
  const page = route.page;
  const [session, setSession] = useState<Session | null | undefined>();
  const onboarding = useOnboarding(session);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null | undefined>();
  const [scans, setScans] = useState<Scan[]>([]);
  const [selected, setSelected] = useState<Scan | null>(null);
  const [scanDeck, setScanDeck] = useState<Deck | null>(null);
  const [reviewState, setReviewState] = useState<ReviewState>({ dirty: false, busy: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const dismissedRefresh = useRef("");
  const refreshNow = useRef<((force?: boolean) => Promise<void>) | null>(null);
  const [notice, setNotice] = useState("");
  const [openedDecks, setOpenedDecks] = useState(page === "decks");
  const [openedCollection, setOpenedCollection] = useState(page === "collection");
  const accountNavigation = useRef<(() => boolean) | null>(null);
  const deckNavigation = useRef<(() => boolean) | null>(null);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [maxBytes, setMaxBytes] = useState(100 * 1024 * 1024);
  const [foilCountDraft, setFoilCountDraft] = useState<number | "">(0);
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null);
  const pendingPhotoRef = useRef<PendingPhoto | null>(null);
  const [photoRecoveryError, setPhotoRecoveryError] = useState("");
  const [pendingPreview, setPendingPreview] = useState("");
  const foilCount = foilCountDraft === "" ? 0 : foilCountDraft;
  const cameraOpen = route.overlay === "camera";
  const setCameraOpen = (open: boolean) => open ? navigation.go({ ...route, overlay: "camera" }) : navigation.route.overlay === "camera" && navigation.close({ ...navigation.route, overlay: undefined }, true);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const selectedId = useRef<string | null>(null);
  const returnToBatch = useRef<{ id: string; y: number } | null>(null);
  const busyRef = useRef(false);
  const storageKey = session ? "scanner-upload:" + session.owner_id : "";

  useEffect(() => {
    let stopped = false; setPendingPhoto(null); pendingPhotoRef.current = null;
    if (session) void readPendingPhoto(session.owner_id).then((photo) => { if (!stopped) { pendingPhotoRef.current = photo; setPendingPhoto(photo); } });
    return () => { stopped = true; };
  }, [session?.owner_id]);
  useEffect(() => {
    if (!pendingPhoto) { setPendingPreview(""); return; }
    const url = URL.createObjectURL(pendingPhoto.file); setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingPhoto]);

  async function keepPhoto(file: File) {
    if (!session) return;
    const value: PendingPhoto = { owner: session.owner_id, file, filename: file.name, savedAt: Date.now(), foilCount, targetDeck: route.targetDeck, collect: route.collect };
    const saved = await savePendingPhoto(value);
    pendingPhotoRef.current = value; setPendingPhoto(value);
    setPhotoRecoveryError(saved ? "" : "This browser couldn’t save a recovery copy. Keep the photo or upload page open until server acceptance.");
    return value;
  }
  async function discardPhoto(expectedSavedAt = pendingPhotoRef.current?.savedAt) {
    if (!session) return;
    if (expectedSavedAt !== undefined) await removePendingPhoto(session.owner_id, expectedSavedAt);
    if (pendingPhotoRef.current?.savedAt === expectedSavedAt) { pendingPhotoRef.current = null; setPendingPhoto(null); }
    setPhotoRecoveryError("");
  }
  async function resumePhoto() {
    if (!pendingPhoto || busyRef.current) return;
    const photo = pendingPhoto;
    if (!navigation.go({ page: "scan", targetDeck: photo.targetDeck, collect: photo.collect })) return;
    setFoilCountDraft(photo.foilCount);
    await chooseFile(new File([photo.file], photo.filename, { type: photo.file.type }), photo);
  }

  useEffect(() => {
    setScanDeck(null);
    if (page !== "scan" || !route.targetDeck || !session) return;
    const controller = new AbortController();
    void request<Deck>("/api/v1/decks/" + route.targetDeck, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setScanDeck(value);
    }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason); });
    return () => controller.abort();
  }, [page, route.targetDeck, session?.owner_id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("account")) navigation.cleanQuery();
    if (params.has("account_suspended")) { setError("Your account is suspended. Contact your administrator to restore access."); navigation.cleanQuery(); }
    if (params.has("login_error")) {
      const code = params.get("login_error") || "login_verification_failed";
      const messages: Record<string, string> = {
        password_reset_pending: "A password reset is in progress. Contact your administrator if it does not finish.",
        login_account_changed: "Sign in with the same account to change its password.",
        login_address_changed: "The server’s address update is not finished. Ask the administrator to restart PakTrak, then sign in again.",
        login_expired: "That sign-in attempt expired or was already used. Start sign-in again in this tab.",
        login_cancelled: "Sign-in was cancelled. You can try again when you’re ready.",
        identity_unavailable: "The sign-in service could not be reached. Try again shortly.",
      };
      const ref = params.get("error_ref") || "";
      setError(new ApiError(messages[code] || "Sign-in could not be verified. Please start sign-in again.", {}, undefined, {
        code: Object.hasOwn(messages, code) ? code : "login_verification_failed", action: "Sign in",
        requestId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ref) ? ref : undefined,
      }));
      navigation.cleanQuery();
    }
    if (params.has("registration_closed")) {
      setError("New account signup is currently closed. Existing members can still sign in.");
      navigation.cleanQuery();
    }
    request<AccountStatus>("/api/auth/status").then(setAccountStatus).catch((e: Error) => { setError(e); setAccountStatus(null); });
    request<Session>("/api/auth/session", { quiet: true }).then(setSession).catch((e: Error) => {
      if (!(e instanceof ApiError && e.status === 401)) setError(e);
      setSession(null);
    });
    request<{ max_upload_bytes: number }>("/api/v1/capabilities")
      .then((data) => setMaxBytes(data.max_upload_bytes)).catch(() => {});
  }, []);

  function select(scan: Scan) {
    if (selectedId.current !== scan.id) setReviewState({ dirty: false, busy: false });
    selectedId.current = scan.id; setSelected(scan);
  }
  function openBatch(scan: Scan, force = false) {
    if (!selectedId.current && page === "batches") returnToBatch.current = { id: scan.id, y: window.scrollY };
    if (!navigation.go({ page: "batches", batch: scan.id }, { force, replace: navigation.route.overlay === "camera" })) return;
    select(scan);
    window.setTimeout(() => { document.getElementById("batch-title")?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, 0);
  }
  useNavigationGuard((from, to) => {
    if (sameScreen(from, to)) return true;
    if (busyRef.current || busy || reviewState.busy || deleting) { setNotice("Please wait for the current save or upload to finish."); return false; }
    if (reviewState.dirty && !window.confirm("Discard unfinished edits?\n\nApprovals and corrections already saved will stay in your collection. Unapproved cards can be reviewed later.")) return false;
    if (from.page === "decks" && deckNavigation.current && !deckNavigation.current()) return false;
    if ((from.page === "account" || from.page === "admin") && accountNavigation.current && !accountNavigation.current()) return false;
    return true;
  });
  useEffect(() => {
    setReviewState({ dirty: false, busy: false });
    if (page === "decks") setOpenedDecks(true);
    if (page === "collection") setOpenedCollection(true);
    if (!session) return;
    if (page !== "batches" || !route.batch) {
      selectedId.current = null; setSelected(null);
      if (page === "scan" && draft?.id) {
        const id = draft.id; selectedId.current = id;
        void request<Scan>("/api/v1/scans/" + id).then((scan) => { if (selectedId.current === id) select(scan); }).catch((e: Error) => setError(e));
      }
      return;
    }
    const id = route.batch;
    selectedId.current = id;
    if (selected?.id === id) return;
    setSelected(null);
    const controller = new AbortController();
    void request<Scan>("/api/v1/scans/" + id, { signal: controller.signal }).then((scan) => {
      if (!controller.signal.aborted && selectedId.current === id) { select(scan); requestAnimationFrame(restoreScroll); }
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e); });
    return () => controller.abort();
  }, [page, route.batch, session?.owner_id]);
  useEffect(() => {
    if (session && session.role !== "admin" && page === "admin") navigation.go({ page: "account" }, { replace: true, force: true });
  }, [session?.role, page]);
  useEffect(() => {
    const titles: Record<Page, string> = { scan: "Upload photo", batches: "Batches", collection: "Collection", transfers: "Import / export", decks: "Decks", admin: "Administration", account: "My account" };
    document.title = titles[page] + " · PakTrak";
  }, [page]);
  function leaveReview(next: () => void) {
    if (busy || reviewState.busy || deleting) { setNotice("Please wait for the current save or upload to finish."); return; }
    if (reviewState.dirty && !window.confirm("Discard unfinished edits?\n\nApprovals and corrections already saved will stay in your collection. Unapproved cards can be reviewed later.")) return;
    if (page === "decks" && deckNavigation.current && !deckNavigation.current()) return;
    if ((page === "account" || page === "admin") && accountNavigation.current && !accountNavigation.current()) return;
    next();
  }
  function closeBatch() {
    navigation.close({ page: "batches" });
  }
  function navigate(destination: Page) {
    const from = navigation.route;
    if (sameScreen(from, { page: destination }) && from.overlay === "menu") navigation.close({ ...from, overlay: undefined });
    else if (navigation.go({ page: destination }, { replace: from.overlay === "menu" })) { setNotice(""); setError(""); }
    else if (from.overlay === "menu") navigation.close({ ...from, overlay: undefined }, true);
  }
  useEffect(() => {
    if (page !== "batches" || selected) return;
    const saved = returnToBatch.current;
    const row = saved && document.querySelector<HTMLButtonElement>(`[data-batch-id="${CSS.escape(saved.id)}"]`);
    if (row) { row.focus({ preventScroll: true }); window.scrollTo(0, saved.y); }
    else document.getElementById("batches-title")?.focus({ preventScroll: true });
    returnToBatch.current = null;
  }, [page, selected?.id]);
  useEffect(() => {
    if (!reviewState.dirty && !reviewState.busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [reviewState.dirty, reviewState.busy]);

  async function deleteSelected() {
    if (!selected || !session || deleting) return;
    const id = selected.id;
    setDeleting(true); setError("");
    try {
      const preview = await request<{ copies: number; token: string; warning: string }>("/api/v1/scans/" + id + "/deletion-preview");
      if (!window.confirm(`Delete this batch and remove ${preview.copies} collection ${preview.copies === 1 ? "copy" : "copies"}?\n\n${preview.warning}\n\nThis cannot be undone.`)) return;
      const result = await request<{ copies_removed: number }>("/api/v1/scans/" + id, {
        ...mutation(session, { confirmed: true, token: preview.token }), method: "DELETE",
      });
      if (selectedId.current === id) { selectedId.current = null; setSelected(null); setReviewState({ dirty: false, busy: false }); navigation.go({ page: "batches" }, { replace: true, force: true }); }
      setScans((current) => current.filter((scan) => scan.id !== id));
      if (draft?.id === id) clearDraft();
      setError("");
      setNotice(`Batch deleted. ${result.copies_removed} collection ${result.copies_removed === 1 ? "copy" : "copies"} removed.`);
    } catch (e) { setError(e as Error); }
    finally { setDeleting(false); }
  }

  function refreshSelected() {
    const id = selectedId.current;
    if (id) void request<Scan>("/api/v1/scans/" + id).then((scan) => {
      if (selectedId.current === id) setSelected(scan);
      setScans((current) => current.map((item) => item.id === id ? scan : item));
    }).catch((e: Error) => setError(e));
  }

  useEffect(() => {
    if (!session) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const value = JSON.parse(saved) as Draft;
        setDraft(value);
        if (value.id && navigation.route.page === "scan") {
          const id = value.id;
          selectedId.current = id;
          request<Scan>("/api/v1/scans/" + id).then((scan) => { if (selectedId.current === id) select(scan); }).catch(() => {});
        }
      }
    } catch { try { localStorage.removeItem(storageKey); } catch { /* Storage can be blocked. */ } }
  }, [storageKey]);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let loading = false;
    let failures = 0;
    let nextAttempt = 0;
    const owner = session.owner_id;
    const controller = new AbortController();
    async function refresh(force = false) {
      if (stopped || loading || document.hidden || !navigator.onLine || (!force && Date.now() < nextAttempt)) return;
      loading = true;
      let readingSelected: string | null = null;
      try {
        // Refresh the token even if reading a batch fails. Another tab may have signed in again.
        const account = await request<Session>("/api/auth/session", { signal: controller.signal });
        if (stopped) return;
        if (account.owner_id !== owner) throw new ApiError("Another account signed in in a different tab. Reload PakTrak before making changes.", {}, undefined, { code: "account_changed", action: "Refresh sign-in" });
        setSession((current) => current && (Object.keys(account) as (keyof Session)[]).every((key) => current[key] === account[key]) ? current : account);
        const data = await request<{ items: Scan[]; next_offset: number | null }>(
          "/api/v1/scans?offset=" + offset, { signal: controller.signal },
        );
        if (stopped) return;
        setScans(data.items);
        setNextOffset(data.next_offset);
        if (selectedId.current) {
          readingSelected = selectedId.current;
          const updated = await request<Scan>("/api/v1/scans/" + readingSelected, { signal: controller.signal });
          if (!stopped && updated.id === selectedId.current) setSelected(updated);
        }
        if (!stopped) { setRefreshError(null); dismissedRefresh.current = ""; failures = 0; nextAttempt = 0; }
      } catch (e) {
        if (stopped || (readingSelected && readingSelected !== selectedId.current)) return;
        const problem = e as Error;
        failures += 1;
        // Stop repeated unauthorized requests; try again when the user returns or asks us to.
        nextAttempt = problem instanceof ApiError && (problem.status === 401 || problem.code === "account_changed" || problem.code === "account_suspended") ? Infinity : Date.now() + Math.min(60000, 2500 * 2 ** Math.min(failures, 5));
        if (dismissedRefresh.current !== refreshFingerprint(problem)) setRefreshError(problem);
      }
      finally { loading = false; }
    }
    refreshNow.current = refresh;
    const resume = () => void refresh(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => {
      stopped = true; controller.abort(); refreshNow.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
    };
  }, [session?.owner_id, offset]);

  function refreshFingerprint(problem: Error) {
    return problem instanceof ApiError ? `${problem.action}:${problem.status}:${problem.code}` : problem.message;
  }
  async function refreshSignIn() {
    try {
      const account = await request<Session>("/api/auth/session");
      if (account.owner_id !== session?.owner_id) { setError("Another account signed in in a different tab. Reload PakTrak before making changes."); return; }
      setSession(account); setError("");
      setNotice("Sign-in refreshed. Try your action again.");
      void refreshNow.current?.(true);
    } catch (e) { setError(e as Error); }
  }
  useEffect(() => {
    const retry = () => void refreshSignIn();
    window.addEventListener("paktrak:refresh-sign-in", retry);
    return () => window.removeEventListener("paktrak:refresh-sign-in", retry);
  }, [session?.owner_id]);

  function saveDraft(value: Draft) { setDraft(value); try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* The photo can still upload when browser storage is disabled. */ } }
  function clearDraft() { setDraft(null); try { localStorage.removeItem(storageKey); } catch { /* Server acceptance remains authoritative. */ } }
  function headers(key?: string) {
    return { "Content-Type": "application/json", "X-CSRF-Token": session!.csrf_token,
      ...(key ? { "Idempotency-Key": key } : {}) };
  }

  async function accept(id: string, key: string, photoSavedAt?: number) {
    await request("/api/v1/scans/" + id + "/finalize", { method: "POST", headers: headers(key) });
    // This message is shown only after the durable acceptance response, never at 100% bytes.
    setNotice("Upload complete. You can close this page or disconnect your phone. Results will be saved in Batches.");
    clearDraft();
    if (photoSavedAt !== undefined) await discardPhoto(photoSavedAt);
    setFoilCountDraft(0);
    openBatch(await request<Scan>("/api/v1/scans/" + id), true);
  }

  async function chooseFile(file: File | undefined, recovered?: PendingPhoto): Promise<boolean> {
    if (!file || !session || busyRef.current) return false;
    setError(""); setNotice(""); setProgress(null);
    if (session.scans_paused || session.scan_cards_remaining === 0) { setError(session.scans_paused ? "New scans are paused. Contact your administrator to resume scanning." : "Your lifetime scan allowance is used. Contact your administrator to raise the limit."); return false; }
    const contentType = photoMime(file);
    if (!contentType) {
      setError(`Choose a ${photoFormatLabel} photo.`); return false;
    }
    if (file.size > maxBytes) { setError("Choose a photo smaller than " + Math.floor(maxBytes / 1024 / 1024) + " MB."); return false; }
    busyRef.current = true; setBusy(true);
    try {
      const targetDeck = recovered ? recovered.targetDeck : route.targetDeck;
      const collect = recovered ? recovered.collect : route.collect;
      const plannedFoils = recovered ? recovered.foilCount : foilCount;
      const photo = recovered || await keepPhoto(file);
      const same = draft && !selected?.accepted_at && draft.filename === file.name &&
        draft.size === file.size && draft.content_type === contentType && draft.target_deck_id === targetDeck
        && (!targetDeck || draft.add_to_collection === !!collect);
      const pending: Draft = same ? { ...draft } : {
        key: crypto.randomUUID(), filename: file.name, size: file.size, content_type: contentType, foil_count: plannedFoils,
        ...(targetDeck ? { target_deck_id: targetDeck, add_to_collection: !!collect } : {}),
      };
      pending.photo_saved_at = photo?.savedAt;
      saveDraft(pending);
      const scan = await request<Scan>("/api/v1/scans", {
        method: "POST", headers: headers(pending.key),
        body: JSON.stringify({ filename: pending.filename, size: pending.size, content_type: pending.content_type, foil_count: pending.foil_count, target_deck_id: pending.target_deck_id, add_to_collection: pending.add_to_collection }),
      });
      pending.id = scan.id; saveDraft(pending); select(scan);
      if (!scan.uploaded && !scan.accepted_at) {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", "/api/v1/scans/" + scan.id + "/upload");
          xhr.setRequestHeader("Content-Type", contentType);
          xhr.setRequestHeader("X-CSRF-Token", session.csrf_token);
          xhr.timeout = 600000;
          xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round(100 * e.loaded / e.total)); };
          xhr.onerror = () => reject(new Error("Connection interrupted. Select the same photo to retry."));
          xhr.ontimeout = () => reject(new Error("Upload timed out. Select the same photo to retry."));
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else {
              let detail = xhr.status === 401 ? "Your session ended. Sign in again, then select the same photo to retry." : "Upload failed. Select the same photo to retry.";
              let code: string | undefined;
              try { const data = JSON.parse(xhr.responseText); if (typeof data.detail === "string") detail = data.detail; if (typeof data.error_code === "string") code = data.error_code; } catch { /* Keep useful fallback. */ }
              const ref = xhr.getResponseHeader("X-Request-ID") || "";
              reject(new ApiError(detail, {}, xhr.status, { action: "Upload photo", code, requestId: /^[a-f0-9-]{36}$/i.test(ref) ? ref : undefined }));
            }
          };
          xhr.send(file);
        });
      }
      setProgress(null);
      const uploaded = await request<Scan>("/api/v1/scans/" + scan.id);
      select(uploaded);
      if (uploaded.duplicate_scan_id && !uploaded.accepted_at) {
        setNotice("This photo matches an earlier batch. Check that batch before submitting it again.");
      } else await accept(scan.id, pending.key, pending.photo_saved_at);
      setOffset(0);
      return true;
    } catch (e) { setError(e as Error); return false; }
    finally {
      busyRef.current = false; setBusy(false); setProgress(null);
      if (camera.current) camera.current.value = "";
      if (picker.current) picker.current.value = "";
    }
  }

  async function finishUpload() {
    if (!selected || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await accept(selected.id, draft?.key || crypto.randomUUID(), draft?.photo_saved_at); }
    catch (e) { setError(e as Error); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function logout() {
    try {
      const result = await request<{ logout_url: string }>("/api/auth/logout", { method: "POST", headers: headers() });
      clearDraft();
      window.location.assign(result.logout_url);
    } catch (e) { setError(e as Error); }
  }

  const scanBlocked = !!session?.scans_paused || session?.scan_cards_remaining === 0 || !!route.targetDeck && (!scanDeck || !!scanDeck.archived);
  const terminal = selected && ["PHOTO_READY", "FAILED", "EXPIRED"].includes(selected.state);
  return <div className="app">
    <header className="topbar">
      <a className="brand" href="/" aria-label="PakTrak home" onClick={(event) => { if (session && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate("scan"); } }}><img src="/brand/paktrak-mark.svg" width="42" height="42" alt="" /><span className="brand-wordmark"><strong>Pak<span>Trak</span></strong><small>Every card. In reach.</small></span></a>
      {session && <Navigation session={session} page={page} onNavigate={navigate} onLogout={() => leaveReview(() => void logout())} onReplayTour={() => leaveReview(onboarding.replay)} />}
    </header>
    <main className={session ? "signed-in" + (page === "collection" ? " collection-view" : page === "batches" ? " batches-view" : page === "decks" ? " decks-view" : page === "account" || page === "admin" ? " account-view" : "") : undefined}>
      <div className="hero">
        <div className="hero-copy">
          <div className="edition">YOUR COLLECTION, WITH PAKTRAK</div>
          <h1>Every card.<br /><span>In reach.</span></h1>
          {!session && <p className="intro">Photograph your cards, find their place and build your next deck.</p>}
        </div>
        <div className="hero-art" aria-hidden="true"><img src="/brand/paktrak-trail.svg" width="360" height="300" alt="" /></div>
      </div>
      {error && <ErrorNotice error={error} onDismiss={() => setError("")} onRetry={error instanceof ApiError && error.code === "csrf_mismatch" ? () => void refreshSignIn() : undefined} retryLabel="Refresh sign-in" />}
      {refreshError && <ErrorNotice error={refreshError} onDismiss={() => { dismissedRefresh.current = refreshFingerprint(refreshError); setRefreshError(null); }} onRetry={() => void refreshNow.current?.(true)} retryLabel="Retry refresh" />}
      {onboarding.error && <div className="message error" role="alert">{onboarding.error} <button type="button" className="text-button" disabled={onboarding.saving} onClick={onboarding.retry}>Retry saving tour</button></div>}
      {session === undefined || (!session && accountStatus === undefined) ? <p role="status">Connecting…</p> : !session ? <section className="panel login">
        {accountStatus?.setup_required ? <>
          <div className="eyebrow">WELCOME TO PAKTRAK</div>
          <h2>Create your administrator account</h2>
          <p>Set up your PakTrak space to organize cards, approve members and manage guest signup.</p>
          <a className="button primary" href="/api/auth/setup">Create administrator account <Icon name="arrow" /></a>
          <p className="fine">Choose a username and a password of at least 8 characters on the next screen.</p>
          <a className="text-button" href="/api/auth/login">Sign in</a>
        </> : <>
          <div className="eyebrow">WELCOME TO PAKTRAK</div>
          <h2>Your next favorite is already here.</h2>
          <p>Sign in to find your cards, saved batches and decks.</p>
          <div className="actions"><a className="button primary" href="/api/auth/login">Sign in</a>
          {accountStatus?.guest_signup_enabled && <a className="button secondary" href="/api/auth/register">Create an account</a>}</div>
          {accountStatus?.guest_signup_enabled && <p className="fine">Start as a guest with 100 card scans. An administrator can approve you as a standard member.</p>}
          {accountStatus && !accountStatus.guest_signup_enabled && <p className="fine">New account signup is currently closed.</p>}
        </>}
      </section> : <>
        {(session.role === "guest" || session.scans_paused || session.scan_card_limit !== null) && <div className="message account-allowance"><strong>{session.role === "guest" ? "Guest account" : "Card scan allowance"} · {session.scan_cards_used.toLocaleString()}{session.scan_card_limit !== null ? ` / ${session.scan_card_limit.toLocaleString()}` : ""} card scans used</strong><p>{session.scans_paused ? "New scans are paused. Your collection and decks are still available. Contact your administrator to resume scanning." : session.scan_cards_remaining === null ? "Unlimited card scans." : session.scan_cards_remaining > 0 ? `${session.scan_cards_remaining.toLocaleString()} card scans left in your lifetime allowance.` : "Your lifetime scan allowance is used. An administrator can raise the limit or restore unlimited scanning."}</p><button className="text-button" onClick={() => navigate("account")}>View my account</button></div>}
        {notice && <div className="message success" role="status">{notice}</div>}
        {page === "scan" && <section className="panel capture">
          {route.targetDeck && <div className="scan-deck-target" aria-label="Deck scan destination">
            <div className="eyebrow">SCANNING A DECK</div><h3>{scanDeck ? scanDeck.name : "Opening your deck…"}</h3>
            <p>These photos stay linked to this deck. Review their matches, then add the cards to your saved deck list.</p>
            <label className="checkbox"><input type="checkbox" checked={!!route.collect} disabled={busy} onChange={(event) => navigation.go({ ...route, collect: event.target.checked || undefined }, { replace: true })} />Also add scanned copies to my collection</label>
            <p className="fine">{route.collect ? "Approved matches will add new collection copies. Leave this off for cards already entered in your collection." : "Your collection quantities stay unchanged. These card scans still count toward your account’s scan allowance."}</p>
            <button className="text-button" disabled={busy} onClick={() => navigation.go({ page: "decks", deck: route.targetDeck, view: "scan" })}>Return to deck photos</button>
          </div>}
          <div className="section-heading"><span className="step">01</span><h2>Start with a clear photo.</h2></div>
          <p>Lay cards face-up with space between them. Keep every edge in the picture and avoid reflections.</p>
          <div className="capture-guide" aria-hidden="true"><div className="layout-guide">{Array.from({ length: 6 }, (_, i) => <i key={i}><Icon name="spark" /></i>)}</div></div>
          <div className="capture-finishes"><label className="foil-count">How many cards are foil?<input type="number" inputMode="numeric" min={0} max={32} value={String(foilCountDraft)} disabled={busy}
            onFocus={(e) => e.currentTarget.select()} onBlur={() => setFoilCountDraft(foilCount)}
            onChange={(e) => setFoilCountDraft(e.target.value === "" ? "" : Math.max(0, Math.min(32, Math.trunc(Number(e.target.value) || 0))))} /></label>
            <p className="fine">{foilCount === 0 ? "0 means every card is nonfoil. Include etched foils in your count." : `After scanning, tap the ${foilCount} foil ${foilCount === 1 ? "card" : "cards"}. The rest will be nonfoil.`} You can correct this in the batch later.</p></div>
          <input ref={camera} data-testid="native-camera-input" hidden type="file" accept={photoAccept} capture="environment" onChange={(e) => void chooseFile(e.target.files?.[0])} />
          <input ref={picker} data-testid="photo-input" hidden type="file" accept={photoAccept} onChange={(e) => void chooseFile(e.target.files?.[0])} />
          <div className="actions">
            <button className="button primary" disabled={busy || scanBlocked} onClick={() => { setError(""); setCameraOpen(true); }}><Icon name="camera" />Take photo</button>
            <button className="button secondary" disabled={busy || scanBlocked} onClick={() => picker.current?.click()}><Icon name="image" />Choose photo</button>
          </div>
          <p className="fine">HEIC/HEIF, JPEG, PNG, WebP + more · Up to {Math.floor(maxBytes / 1024 / 1024)} MB · Photos expire after 7 days</p>
          <details className="photo-format-help"><summary>Supported photo formats</summary><p>{photoFormatLabel}.</p><p>HEIC/HEIF files use the main photo. Save animated images and multi-page TIFFs as separate still photos before uploading.</p></details>
          {busy && <div className="upload-progress" role="status">
            <p>{progress === null ? "Waiting for server acceptance…" : "Uploading " + progress + "%"} Keep this page open until acceptance is confirmed.</p>
            {progress !== null && <progress value={progress} max={100} aria-label="Photo upload progress" />}
          </div>}
          {pendingPhoto && !busy && !cameraOpen && <aside className="photo-recovery" aria-label="Unfinished photo">
            <div className="photo-recovery-art">{pendingPreview && <img src={pendingPreview} alt="Your unfinished photo" />}</div>
            <div className="photo-recovery-copy"><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h3>Your photo is still here.</h3><p>{pendingPhoto.filename} · {pendingPhoto.foilCount} foils{pendingPhoto.targetDeck ? " · Deck scan" : " · Collection scan"}</p><p className="fine">A recovery copy stays on this device until the server accepts it. Photos expire after 7 days.</p>
              <div className="actions"><button className="button primary" disabled={!!session.scans_paused || session.scan_cards_remaining === 0} onClick={() => void resumePhoto()}>Resume upload <Icon name="arrow" /></button><button className="text-button" onClick={() => { if (window.confirm("Discard this unfinished photo from this device? Saved batches will be kept.")) { clearDraft(); void discardPhoto(); } }}>Discard photo</button></div>
            </div>
          </aside>}
          {photoRecoveryError && <p className="message" role="status">{photoRecoveryError}</p>}
          {draft && !pendingPhoto && !busy && !selected?.uploaded && <p className="fine">Unfinished upload: {draft.filename}. Choose the same file to retry.</p>}
          {scans.length > 0 && <div className="capture-batches-link"><span className="capture-batches-icon" aria-hidden="true"><Icon name="batches" /></span>
            <div><strong>{scans.some(batchNeedsReview) ? "Your scans are ready to review" : "Looking for an earlier scan?"}</strong><p>Check matches and choose foil cards in your saved batches.</p></div>
            <button className="button secondary" disabled={busy} onClick={() => navigate("batches")}>Review saved batches <Icon name="arrow" /></button></div>}
        </section>}
        {selected && ["scan", "batches"].includes(page) && <section className="panel result" aria-label="Selected batch">
          <div className="batch-toolbar"><button className="button secondary" disabled={busy || reviewState.busy || deleting} onClick={closeBatch}>← Back to batches</button></div>
          <div className="eyebrow">SAVED BATCH</div>
          <h2 id="batch-title" className="filename" tabIndex={-1}>{selected.filename}</h2>
          <div className="batch-detail-meta"><span className={"badge " + selected.state.toLowerCase()}>{batchStatus(selected)}</span><time dateTime={selected.created_at}>{new Date(selected.created_at).toLocaleString()}</time></div>
          {selected.accepted_at && <p className="batch-save-status" role="status">{reviewState.busy ? "Saving changes…" : reviewState.dirty ? "Unsaved edits · approve or save your changes before leaving." : "✓ Saved on server"}</p>}
          {selected.accepted_at && <p className="fine">Use the next steps below to choose foils and review matches. Each approval saves immediately, so you can return anytime.</p>}
          {selected.accepted_at && <div className="scan-deck-target" aria-label="Save batch to a deck">
            <strong>{selected.target_deck ? `Deck: ${selected.target_deck.name}` : "Organize these cards as a deck"}</strong>
            <p className="fine">{selected.add_to_collection === false ? "Deck scan · matched cards are saved without adding collection copies." : "Building a deck from this batch uses its reviewed cards without adding collection copies again."}</p>
            <div className="actions"><button className="button secondary" disabled={reviewState.busy || reviewState.dirty || busy || deleting} onClick={() => navigation.go({ page: "decks", deck: selected.target_deck?.id, view: "scan", fromBatch: selected.id })}>{selected.target_deck ? "Continue building deck" : "Build a deck from this batch"}</button>
              {selected.target_deck && !selected.target_deck.archived && <button className="text-button" disabled={reviewState.busy || reviewState.dirty || busy || deleting} onClick={() => navigation.go({ page: "scan", targetDeck: selected.target_deck!.id, collect: selected.add_to_collection || undefined })}>Scan next deck photo</button>}</div>
          </div>}
          {selected.accepted_at && !terminal && <p className="saved"><span aria-hidden="true">✓ </span>Saved on your server. You can disconnect.</p>}
          {selected.job && !terminal && <p role="status">{selected.job.stage}</p>}
          {selected.job?.error_message && <p className="message error">{selected.job.error_message}</p>}
          {!!selected.width && <Suspense fallback={<p>Opening saved card regions…</p>}><Review key={selected.id} scanId={selected.id} photo={selected.thumbnail_url} session={session} onStateChange={setReviewState} processing={!!selected.job && ["QUEUED", "RUNNING"].includes(selected.job.state)} progress={selected.job?.progress} onChange={refreshSelected} /></Suspense>}
          {selected.state === "EXPIRED" && <p>The photo expired under the retention policy. This batch record is still available.</p>}
          {selected.width && <p className="fine">{selected.width} × {selected.height} pixels · Prepared on the server</p>}
          {selected.duplicate_scan_id && <p className="message">An earlier batch contains the same photo. <button className="text-button" onClick={() => leaveReview(() => { request<Scan>("/api/v1/scans/" + selected.duplicate_scan_id).then(openBatch).catch((e: Error) => setError(e)); })}>View earlier batch</button></p>}
          {selected.uploaded && !selected.accepted_at && <button className="button primary" disabled={busy || scanBlocked} onClick={() => void finishUpload()}>Confirm server processing</button>}
          <div className="batch-exit actions"><button className="button secondary" disabled={busy || reviewState.busy || deleting} onClick={closeBatch}>Close batch</button></div>
          <div className="scan-delete"><button className="button danger" disabled={busy || deleting || reviewState.busy} onClick={() => void deleteSelected()}>{deleting ? "Reviewing deletion…" : "Delete batch"}</button><p className="fine">Also removes the remaining collection copies added by this scan.</p></div>
        </section>}
        {openedCollection && <div hidden={page !== "collection"}><Suspense fallback={<p role="status">Opening your collection…</p>}><Collections session={session} mode="collection" /></Suspense></div>}
        {page === "transfers" && <Suspense fallback={<p role="status">Opening your transfers…</p>}><Collections session={session} mode="transfers" /></Suspense>}
        {openedDecks && <div hidden={page !== "decks"}><Suspense fallback={<p role="status">Opening your decks…</p>}><Decks session={session} active={page === "decks"} navigationRef={deckNavigation} /></Suspense></div>}
        {page === "account" && <Suspense fallback={<p role="status">Opening your account…</p>}><MyAccount session={session} navigationRef={accountNavigation} onChange={(account) => setSession((current) => current ? { ...current, display_name: account.display_name, role: account.role, scan_cards_used: account.scan_cards_used, scan_card_limit: account.scan_card_limit, scan_cards_remaining: account.scan_cards_remaining, scans_paused: account.scans_paused, account_version: account.account_version } : current)} /></Suspense>}
        {page === "admin" && session.role === "admin" && <Suspense fallback={<p role="status">Opening account settings…</p>}><Admin session={session} navigationRef={accountNavigation} /></Suspense>}
        {page === "batches" && !selected && (route.batch ? <section className="panel"><button className="button secondary" onClick={closeBatch}>← Back to batches</button>{!error && <p role="status">Opening batch…</p>}</section> : <BatchList scans={scans} offset={offset} nextOffset={nextOffset} onPage={setOffset} onOpen={openBatch} onUpload={() => navigate("scan")} />)}
      </>}
      <footer><img src="/brand/paktrak-mark.svg" alt="" width="24" height="24" /><span><strong>PakTrak</strong> · Every card. In reach.</span></footer>
    </main>
    {session && cameraOpen && <Suspense fallback={<p role="status">Opening the camera…</p>}><CameraCapture foilCount={foilCount} progress={progress} uploadError={typeof error === "string" ? error : error instanceof ApiError ? error.userMessage : error.message}
      onClose={() => setCameraOpen(false)} onUpload={(file) => chooseFile(file)} onCapture={async (file) => { await keepPhoto(file); }} onDiscard={discardPhoto}
      onNativeCamera={() => { setCameraOpen(false); camera.current?.click(); }}
      onChoosePhoto={() => { setCameraOpen(false); picker.current?.click(); }} /></Suspense>}
    {session?.membership_welcome && <MembershipWelcome key={session.owner_id + session.approved_at} session={session} onDismiss={() => setSession((current) => current ? { ...current, membership_welcome: false } : current)} />}
    {onboarding.active && !session?.membership_welcome && <Onboarding key={onboarding.active.owner} replay={onboarding.active.replay} onDismiss={() => {
      if (!onboarding.active?.replay) navigation.go({ page: "collection" }, { replace: true });
      onboarding.dismiss();
    }} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
