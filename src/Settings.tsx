import { useCallback, useEffect, useId, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download, RefreshCw } from "lucide-react";
import { notesApi } from "./api";
import type { AppSettings } from "./api";
import { ThemePicker } from "./ThemePicker";

type UpdateState = "idle" | "checking" | "current" | "available" | "installing" | "error";

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
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [updateError, setUpdateError] = useState("");
  const updateRef = useRef<Update | null>(null);
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
    return () => {
      request.current++;
      void updateRef.current?.close().catch(() => undefined);
    };
  }, [loadSettings]);

  const checkForUpdates = async () => {
    if (updateState === "checking" || updateState === "installing") return;
    setUpdateState("checking");
    setUpdateError("");
    setUpdateVersion("");
    await updateRef.current?.close().catch(() => undefined);
    updateRef.current = null;
    try {
      const update = await check();
      if (!update) {
        setUpdateState("current");
        return;
      }
      updateRef.current = update;
      setUpdateVersion(update.version);
      setUpdateState("available");
    } catch (reason) {
      setUpdateState("error");
      setUpdateError(errorText(reason));
    }
  };

  const installUpdate = async () => {
    const update = updateRef.current;
    if (!update || updateState === "installing") return;
    setUpdateState("installing");
    setUpdateError("");
    try {
      await update.downloadAndInstall(undefined, { restartAfterInstall: true });
      if (!navigator.userAgent.includes("Windows")) await relaunch();
    } catch (reason) {
      setUpdateState("error");
      setUpdateError(errorText(reason));
    }
  };

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

  const updateDesk = async (enabled: boolean) => {
    if (!settings || saving) return;
    setSaving(true);
    setSaveError("");
    try { setSettings(await notesApi.setRememberDesk(enabled)); }
    catch (reason) { setSaveError(`Couldn't save the desk setting. ${errorText(reason)}`); }
    finally { setSaving(false); }
  };

  const updateStartup = async (enabled: boolean) => {
    if (!settings || saving) return;
    setSaving(true);
    setSaveError("");
    try { setSettings(await notesApi.setOpenOnStartup(enabled)); }
    catch (reason) { setSaveError(`Couldn't save the startup setting. ${errorText(reason)}`); }
    finally { setSaving(false); }
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
            <label htmlFor={`${descriptionId}-startup`}>Open on startup</label>
            <p id={`${descriptionId}-startup-description`}>Start CozyNotes automatically when you sign in.</p>
          </div>
          <input id={`${descriptionId}-startup`} className="background-switch" type="checkbox" role="switch" aria-label="Open on startup" aria-describedby={`${descriptionId}-startup-description`} checked={settings.openOnStartup} onChange={event => void updateStartup(event.target.checked)} disabled={saving} />
        </div>
        <div className="background-setting">
          <div className="background-copy">
            <label htmlFor={`${descriptionId}-desk`}>Remember my desk</label>
            <p id={`${descriptionId}-desk-description`}>Reopen notes left open when you exit, with their sizes, positions, and folded state. Notes you close individually stay closed.</p>
          </div>
          <input id={`${descriptionId}-desk`} className="background-switch" type="checkbox" role="switch" aria-label="Remember my desk" aria-describedby={`${descriptionId}-desk-description`} checked={settings.rememberDesk ?? true} onChange={event => void updateDesk(event.target.checked)} disabled={saving} />
        </div>
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
    <section className="settings-section" aria-labelledby="settings-updates-title">
      <h2 id="settings-updates-title">Updates</h2>
      <div className="update-setting">
        <div className="background-copy">
          <strong>CozyNotes updates</strong>
          <p>{updateState === "available" ? `Version ${updateVersion} is ready to install.` : updateState === "current" ? "You're using the latest version." : updateState === "error" ? "Check failed. Try again." : "Check GitHub for the latest CozyNotes release."}</p>
        </div>
        {updateState === "available"
          ? <button className="update-button" onClick={() => void installUpdate()} disabled={updateState !== "available"}><Download size={15} /> Update to {updateVersion}</button>
          : <button className="update-button secondary" onClick={() => void checkForUpdates()} disabled={updateState === "checking" || updateState === "installing"}><RefreshCw size={15} /> {updateState === "checking" ? "Checking..." : "Check for updates"}</button>}
      </div>
      {updateState === "installing" && <p className="settings-state" role="status">Downloading update...</p>}
      {updateState === "error" && <p className="settings-error" role="alert">Couldn't check for updates. {updateError}</p>}
    </section>
  </div>;
}
