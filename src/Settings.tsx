import { useCallback, useEffect, useId, useRef, useState } from "react";
import { notesApi } from "./api";
import type { AppSettings } from "./api";
import { ThemePicker } from "./ThemePicker";

function errorText(error: unknown) {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return "Please try again.";
}

export function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const request = useRef(0);
  const descriptionId = useId();

  const loadSettings = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    setLoadError("");
    try {
      const result = await notesApi.getSettings();
      if (token === request.current) setSettings(result);
    } catch (reason) {
      if (token === request.current) setLoadError(`Couldn't load Settings. ${errorText(reason)}`);
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    return () => { request.current++; };
  }, [loadSettings]);

  const updateBackground = async (enabled: boolean) => {
    if (!settings || saving || !settings.trayAvailable) return;
    const previous = settings;
    setSaving(true);
    setSaveError("");
    try {
      setSettings(await notesApi.setRunInBackground(enabled));
    } catch (reason) {
      setSettings(previous);
      setSaveError(`Couldn't save the background setting. ${errorText(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  return <div className="settings-page">
    <section className="settings-section" aria-labelledby="settings-appearance-title">
      <h2 id="settings-appearance-title">Appearance</h2>
      <ThemePicker />
    </section>
    <section className="settings-section" aria-labelledby="settings-behavior-title">
      <h2 id="settings-behavior-title">App behavior</h2>
      {loading && <p className="settings-state" role="status">Loading settings...</p>}
      {!loading && loadError && <div className="settings-error" role="alert"><p>{loadError}</p><button className="text-action" onClick={() => void loadSettings()}>Retry</button></div>}
      {!loading && settings && <>
        <div className="background-setting">
          <div className="background-copy">
            <label htmlFor={`${descriptionId}-switch`}>Run in background</label>
            <p id={descriptionId}>Keep CozyNotes in the system tray when all windows are closed.</p>
          </div>
          <input
            id={`${descriptionId}-switch`}
            className="background-switch"
            type="checkbox"
            role="switch"
            aria-label="Run in background"
            aria-describedby={descriptionId}
            checked={settings.runInBackground}
            onChange={event => void updateBackground(event.target.checked)}
            disabled={saving || !settings.trayAvailable}
          />
        </div>
        {saving && <p className="settings-state" role="status">Saving...</p>}
        {saveError && <p className="settings-error" role="alert">{saveError}</p>}
        {(settings.warning || !settings.trayAvailable) && <p className="settings-warning" role="status">{settings.warning || "Run in background is unavailable because the system tray could not be created."}</p>}
      </>}
    </section>
  </div>;
}
