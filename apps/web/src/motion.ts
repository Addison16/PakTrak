// Animations play for everyone by default, even when the device asks for less
// motion. My account > Appearance > Animations > Follow device hands that
// choice back to the device for this browser. "On" sits on
// <html data-motion="on">; motionPreference.ts rewrites the stylesheets'
// reduce-motion rules to respect it.
const key = "paktrak-motion";
const device = () => matchMedia("(prefers-reduced-motion: reduce)");

export const motionPreference = () => document.documentElement.dataset.motion === "on" ? "on" : "auto";
export const deviceReducesMotion = () => device().matches;
export const reducedMotion = () => motionPreference() !== "on" && deviceReducesMotion();

export function setMotionPreference(value: "auto" | "on") {
  try { if (value === "auto") localStorage.setItem(key, "auto"); else localStorage.removeItem(key); } catch { /* Kept for this page. */ }
  apply(value);
}

/** Calls listener when either the device setting or this browser's choice changes. */
export function onMotionChange(listener: () => void) {
  const query = device();
  query.addEventListener("change", listener);
  window.addEventListener("paktrak-motion-change", listener);
  return () => { query.removeEventListener("change", listener); window.removeEventListener("paktrak-motion-change", listener); };
}

function apply(value: "auto" | "on") {
  if (value === "on") document.documentElement.dataset.motion = "on"; else delete document.documentElement.dataset.motion;
  window.dispatchEvent(new Event("paktrak-motion-change"));
}

export function loadMotionPreference() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(key); } catch { /* Animations stay on. */ }
  apply(saved === "auto" ? "auto" : "on");
  window.addEventListener("storage", (event) => { if (event.storageArea === localStorage && (event.key === key || event.key === null)) apply(event.key === key && event.newValue === "auto" ? "auto" : "on"); });
}
