import { useId } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "./theme";
import type { ThemePreference } from "./theme";

const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "warm", label: "Warm", icon: Sun },
  { value: "night", label: "Night", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function ThemePicker() {
  const { preference, setPreference } = useTheme();
  const name = useId();

  return <fieldset className="theme-picker">
    <legend>Appearance</legend>
    <div className="theme-options">
      {themeOptions.map(({ value, label, icon: Icon }) => <label key={value} className="theme-option">
        <input type="radio" name={name} value={value} checked={preference === value} onChange={() => setPreference(value)} />
        <Icon size={16} aria-hidden="true" />
        <span className="theme-label">{label}</span>
      </label>)}
    </div>
  </fieldset>;
}

/** Insert directly into Popover; it already handles menu focus and dismissal. */
export function ThemeMenuItems() {
  const { preference, setPreference } = useTheme();

  return <>{themeOptions.map(({ value, label, icon: Icon }) => <button key={value} type="button" role="menuitemradio"
    aria-checked={preference === value} onClick={() => setPreference(value)}>
    <Icon size={15} aria-hidden="true" />
    <span className="theme-label">{label}</span>
    {preference === value && <Check size={15} className="menu-check" aria-hidden="true" />}
  </button>)}</>;
}
