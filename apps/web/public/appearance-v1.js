/* Runs before rendering in the app and the sign-in theme. No network or account writes. */
(() => {
  "use strict";
  const key = "paktrak-appearance";
  const valid = (value) => ["auto", "light", "dark"].includes(value);
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "auto";
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch { /* Device settings still work when storage is unavailable. */ }

  function apply() {
    const theme = preference === "auto" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.appearance = preference;
    const chrome = document.querySelector('meta[name="theme-color"]');
    if (chrome) chrome.content = theme === "dark" ? "#0f1b19" : "#f5f1e9";
    document.querySelectorAll("[data-appearance-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.appearanceMode === preference));
    });
    document.querySelectorAll("[data-appearance-status]").forEach((element) => {
      element.textContent = preference === "auto"
        ? "Follows this device · " + (theme === "dark" ? "Dark" : "Light") + " right now"
        : (theme === "dark" ? "Dark" : "Light") + " on this device";
    });
    window.dispatchEvent(new Event("paktrak-appearance-change"));
  }
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-appearance-mode]") : null;
    if (!button || !valid(button.dataset.appearanceMode)) return;
    preference = button.dataset.appearanceMode;
    try { localStorage.setItem(key, preference); } catch { /* Retain the selection for this page. */ }
    apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : "auto";
    apply();
  });
  system.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  apply();
})();
