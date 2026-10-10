// Animations follow the device's reduce-motion setting unless this browser has
// asked to play them anyway (My account > Appearance > Animations). The choice
// sits on <html data-motion="on">; motion-preference.js rewrites the
// stylesheets' reduce-motion rules to respect it.
const key = "paktrak-motion";
const device = () => matchMedia("(prefers-reduced-motion: reduce)");

export const motionPreference = () => document.documentElement.dataset.motion === "on" ? "on" : "auto";
export const deviceReducesMotion = () => device().matches;
export const reducedMotion = () => motionPreference() !== "on" && deviceReducesMotion();

export function setMotionPreference(value: "auto" | "on") {
  try { if (value === "on") localStorage.setItem(key, "on"); else localStorage.removeItem(key); } catch { /* Kept for this page. */ }
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
  try { saved = localStorage.getItem(key); } catch { /* Follows the device. */ }
  apply(saved === "on" ? "on" : "auto");
  window.addEventListener("storage", (event) => { if (event.storageArea === localStorage && (event.key === key || event.key === null)) apply(event.newValue === "on" && event.key === key ? "on" : "auto"); });
}
