export { imageLimit } from "./offlineLimits";

// Browsers only run service workers on HTTPS addresses and localhost. On a
// plain http:// address PakTrak still keeps lists and queued changes in this
// tab, but it can't open with no connection or keep card pictures.
export const offlineImagesReady = () => window.isSecureContext && "serviceWorker" in navigator && !!navigator.serviceWorker.controller;

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: Error) => console.warn("PakTrak offline support could not start", error.message));
  if (document.readyState === "complete") void register(); else window.addEventListener("load", () => void register(), { once: true });
}
