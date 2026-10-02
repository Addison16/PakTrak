/* Runs before rendering in the app and the sign-in theme. No network or account writes. */
(() => {
  "use strict";
  const key = "paktrak-appearance";
  const paletteKey = "paktrak-palette";
  const canvases = {
    forest: { light: "#f5f1e9", dark: "#0f1b19" },
    ocean: { light: "#edf4f8", dark: "#101c2b" },
    amethyst: { light: "#f4eff9", dark: "#1d162b" },
    ember: { light: "#faf0e8", dark: "#251914" },
    slate: { light: "#f0f1f3", dark: "#15171c" },
  };
  const valid = (value) => ["auto", "light", "dark"].includes(value);
  const validPalette = (value) => Object.prototype.hasOwnProperty.call(canvases, value);
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "auto";
  let palette = "forest";
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
    const savedPalette = localStorage.getItem(paletteKey);
    if (validPalette(savedPalette)) palette = savedPalette;
  } catch { /* Device settings still work when storage is unavailable. */ }

  function apply() {
    const theme = preference === "auto" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.appearance = preference;
    document.documentElement.dataset.palette = palette;
    const chrome = document.querySelector('meta[name="theme-color"]');
    if (chrome) chrome.content = canvases[palette][theme];
    document.querySelectorAll("[data-appearance-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.appearanceMode === preference));
    });
    document.querySelectorAll("[data-appearance-status]").forEach((element) => {
      element.textContent = preference === "auto"
        ? "Follows this device · " + (theme === "dark" ? "Dark" : "Light") + " right now"
        : (theme === "dark" ? "Dark" : "Light") + " on this device";
    });
    document.querySelectorAll("[data-palette-choice]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.paletteChoice === palette));
    });
    window.dispatchEvent(new Event("paktrak-appearance-change"));
  }
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-appearance-mode], button[data-palette-choice]") : null;
    if (!button) return;
    if (valid(button.dataset.appearanceMode)) {
      preference = button.dataset.appearanceMode;
      try { localStorage.setItem(key, preference); } catch { /* Retain the selection for this page. */ }
    } else if (validPalette(button.dataset.paletteChoice)) {
      palette = button.dataset.paletteChoice;
      try { localStorage.setItem(paletteKey, palette); } catch { /* Retain the selection for this page. */ }
    } else return;
    apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage || ![key, paletteKey, null].includes(event.key)) return;
    if (event.key === key || event.key === null) preference = valid(event.newValue) ? event.newValue : "auto";
    if (event.key === paletteKey || event.key === null) palette = validPalette(event.newValue) ? event.newValue : "forest";
    apply();
  });
  system.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  apply();
})();
