// Animations play for everyone by default, even when the device asks for less
// motion. My account > Appearance > Animations can instead follow the device
// (Auto) or turn them off (Off) in this browser. The choice sits on
// <html data-motion>; motionPreference.ts rewrites the stylesheets'
// reduce-motion rules to respect it.
export type MotionPreference = "on" | "auto" | "off";
const key = "paktrak-motion";
const device = () => matchMedia("(prefers-reduced-motion: reduce)");
const valid = (value: unknown): value is MotionPreference => value === "on" || value === "auto" || value === "off";

export const motionPreference = (): MotionPreference => { const value = document.documentElement.dataset.motion; return valid(value) ? value : "on"; };
export const deviceReducesMotion = () => device().matches;
export const reducedMotion = () => { const value = motionPreference(); return value === "off" || value === "auto" && deviceReducesMotion(); };

export function setMotionPreference(value: MotionPreference) {
  try { if (value === "on") localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Kept for this page. */ }
  apply(value);
}

/** Calls listener when either the device setting or this browser's choice changes. */
export function onMotionChange(listener: () => void) {
  const query = device();
  query.addEventListener("change", listener);
  window.addEventListener("paktrak-motion-change", listener);
  return () => { query.removeEventListener("change", listener); window.removeEventListener("paktrak-motion-change", listener); };
}

function apply(value: MotionPreference) {
  document.documentElement.dataset.motion = value;
  window.dispatchEvent(new Event("paktrak-motion-change"));
}
const saved = (value: string | null) => valid(value) ? value : "on";

export function loadMotionPreference() {
  let value: string | null = null;
  try { value = localStorage.getItem(key); } catch { /* Animations stay on. */ }
  apply(saved(value));
  window.addEventListener("storage", (event) => { if (event.storageArea === localStorage && (event.key === key || event.key === null)) apply(saved(event.key === key ? event.newValue : null)); });
}
