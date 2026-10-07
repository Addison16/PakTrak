export { imageLimit } from "./offlineLimits";

// Browsers only run service workers on HTTPS addresses and localhost. On a
// plain http:// address PakTrak still keeps lists and queued changes in this
// tab, but it can't open with no connection or keep card pictures.
export const offlineImagesReady = () => window.isSecureContext && "serviceWorker" in navigator && !!navigator.serviceWorker.controller;

/**
 * Opening PakTrak at a plain http:// address when it's set up at an https://
 * one (for example behind Cloudflare) moves to the https address, so the
 * camera and full offline use always work. Returns true when it navigates.
 */
export function moveToSecureAddress(appUrl: string | undefined) {
  if (window.isSecureContext || location.protocol !== "http:" || !appUrl) return false;
  let target: URL;
  try { target = new URL(appUrl); } catch { return false; }
  if (target.protocol !== "https:" || target.origin === location.origin) return false;
  location.replace(target.origin + location.pathname + location.search + location.hash);
  return true;
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: Error) => console.warn("PakTrak offline support could not start", error.message));
  if (document.readyState === "complete") void register(); else window.addEventListener("load", () => void register(), { once: true });
}
