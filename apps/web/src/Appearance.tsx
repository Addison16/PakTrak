import { useSyncExternalStore } from "react";
import { deviceReducesMotion, motionPreference, onMotionChange, setMotionPreference } from "./motion";

const subscribe = (listener: () => void) => {
  window.addEventListener("paktrak-appearance-change", listener);
  return () => window.removeEventListener("paktrak-appearance-change", listener);
};
const snapshot = () => `${document.documentElement.dataset.appearance || "auto"}:${document.documentElement.dataset.theme || "light"}:${document.documentElement.dataset.palette || "forest"}`;
const motionChoices = [["on", "On"], ["auto", "Auto"], ["off", "Off"]] as const;
const motionSnapshot = () => `${motionPreference()}:${deviceReducesMotion()}`;
const palettes = ["forest", "ocean", "amethyst", "ember", "slate"] as const;

export default function Appearance() {
  const [mode, theme, palette] = useSyncExternalStore(subscribe, snapshot).split(":");
  const [motion, reduced] = useSyncExternalStore(onMotionChange, motionSnapshot).split(":");
  // My account's "Appearance" heading names the whole section, so each choice gets its own label.
  return <div className="appearance-picker">
    <fieldset className="mode-picker">
      <legend>Light or dark</legend>
      <div className="appearance-options">
        {(["auto", "light", "dark"] as const).map((value) => <button key={value} type="button" className="appearance-option" data-appearance-mode={value} aria-pressed={mode === value}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
      <p className="appearance-note">{mode === "auto" ? `Follows this device · ${theme === "dark" ? "Dark" : "Light"} right now` : `${theme === "dark" ? "Dark" : "Light"} on this device`}</p>
    </fieldset>
    <fieldset className="palette-picker">
      <legend>Color theme</legend>
      <div className="palette-options">
        {palettes.map((value) => <button key={value} type="button" className="palette-option" data-palette-choice={value} aria-pressed={palette === value}>
          <span className="palette-preview" data-palette-preview={value} aria-hidden="true">
            <span className="palette-preview-bar" />
            <span className="palette-preview-cards"><i /><i /><i /></span>
          </span>
          <span className="palette-name">{value[0].toUpperCase() + value.slice(1)}<span className="palette-check" aria-hidden="true">✓</span></span>
        </button>)}
      </div>
      <p className="appearance-note">Make it yours. Your choice stays in this browser.</p>
    </fieldset>
    <fieldset className="motion-picker">
      <legend>Animations</legend>
      <div className="appearance-options">
        {motionChoices.map(([value, label]) => <button key={value} type="button" className="appearance-option" aria-pressed={motion === value} onClick={() => setMotionPreference(value)}>{label}</button>)}
      </div>
      <p className="appearance-note">{motion === "on" ? "Animations play on this device, even if it asks for less motion" : motion === "off" ? "Animations are off on this device" : `Follows this device · ${reduced === "true" ? "Off right now because it asks for less motion" : "On right now"}`}</p>
    </fieldset>
  </div>;
}
