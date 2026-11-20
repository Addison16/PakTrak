import { useEffect, useRef, useState } from "react";
import type { Page } from "./navigation";
import "./collection-qol.css";
import "./shortcuts.css";

const places: [string, Page, string][] = [
  ["u", "scan", "Upload photo"], ["b", "batches", "Batches"], ["c", "collection", "Collection"], ["d", "decks", "Decks"],
  ["w", "wishlist", "Wishlist"], ["s", "sets", "Set completion"], ["t", "trade", "Trade value"], ["f", "friends", "Friends"],
];
/** Sent on window to open the list from the menu. */
export const showShortcuts = "paktrak-shortcuts";
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const searchBox = () => [...document.querySelectorAll<HTMLInputElement>("main input[type=search]")].find((field) => !field.disabled && field.getClientRects().length > 0);

/** Keyboard shortcuts for people at a desk: / to search, G then a letter to move, ? for this list. */
export default function Shortcuts({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const [listed, setListed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const go = useRef(onNavigate); go.current = onNavigate;
  useEffect(() => {
    let leader = 0, waiting = 0;
    function focusSearch(tries: number) {
      const field = searchBox();
      if (field) { field.focus(); field.select(); }
      else if (tries > 0) waiting = window.setTimeout(() => focusSearch(tries - 1), 80);
    }
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || typing(event.target)) return;
      // Dialogs, the menu and the card viewer keep the keyboard to themselves.
      if (document.querySelector("dialog[open]")) return;
      const pressed = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const led = leader && Date.now() - leader < 1500; leader = 0;
      if (led) {
        const place = places.find(([letter]) => letter === pressed);
        if (place) { event.preventDefault(); go.current(place[1]); }
        return;
      }
      if (pressed === "g") leader = Date.now();
      else if (pressed === "?") { event.preventDefault(); setListed(true); }
      else if (pressed === "/") {
        event.preventDefault(); window.clearTimeout(waiting);
        if (!searchBox()) go.current("collection");
        focusSearch(12);
      }
    }
    const list = () => setListed(true);
    window.addEventListener("keydown", key); window.addEventListener(showShortcuts, list);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener(showShortcuts, list); window.clearTimeout(waiting); };
  }, []);
  useEffect(() => { if (listed) dialog.current?.showModal(); }, [listed]);
  if (!listed) return null;
  return <dialog ref={dialog} className="bulk-collection-dialog shortcuts-dialog" aria-labelledby="shortcuts-title" onClose={() => setListed(false)}>
    <div className="dialog-heading"><div><span className="eyebrow">AT A KEYBOARD</span><h2 id="shortcuts-title">Keyboard shortcuts</h2></div><button className="text-button" onClick={() => dialog.current?.close()}>Close ×</button></div>
    <dl className="shortcut-list">
      <div><dt><kbd>/</kbd></dt><dd>Search this page, or your collection</dd></div>
      {places.map(([letter, , name]) => <div key={letter}><dt><kbd>G</kbd> then <kbd>{letter.toUpperCase()}</kbd></dt><dd>{name}</dd></div>)}
      <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Previous or next card while one is open</dd></div>
      <div><dt><kbd>Esc</kbd></dt><dd>Close what’s open</dd></div>
      <div><dt><kbd>?</kbd></dt><dd>Show this list</dd></div>
    </dl>
  </dialog>;
}
