import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  window.addEventListener("paktrak-appearance-change", listener);
  return () => window.removeEventListener("paktrak-appearance-change", listener);
};
const snapshot = () => `${document.documentElement.dataset.appearance || "auto"}:${document.documentElement.dataset.theme || "light"}`;

export default function Appearance() {
  const [mode, theme] = useSyncExternalStore(subscribe, snapshot).split(":");
  return <fieldset className="appearance-picker">
    <legend>Appearance</legend>
    <div className="appearance-options">
      {(["auto", "light", "dark"] as const).map((value) => <button key={value} type="button" className="appearance-option" data-appearance-mode={value} aria-pressed={mode === value}>{value[0].toUpperCase() + value.slice(1)}</button>)}
    </div>
    <p className="appearance-note">{mode === "auto" ? `Follows this device · ${theme === "dark" ? "Dark" : "Light"} right now` : `${theme === "dark" ? "Dark" : "Light"} on this device`}</p>
  </fieldset>;
}
