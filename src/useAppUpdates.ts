import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

type UpdateState = {
  status: "idle" | "checking" | "current" | "available" | "installing" | "error";
  version: string;
  error: string;
};
const initialState: UpdateState = { status: "idle", version: "", error: "" };

function errorText(error: unknown) {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return "Please try again.";
}

function closeUpdate(update: Update | null) {
  void update?.close().catch(() => undefined);
}

// Owned by the library window, which stays mounted when hidden in the tray.
export function useAppUpdates() {
  const [state, setState] = useState<UpdateState>(initialState);
  const session = useRef({
    mounted: false,
    busy: false,
    lastCheck: null as number | null,
    checkFailed: false,
    timer: undefined as number | undefined,
    update: null as Update | null,
    state: initialState,
  });

  const publish = useCallback((next: UpdateState) => {
    session.current.state = next;
    if (session.current.mounted) setState(next);
  }, []);

  const checkForUpdates = useCallback(async function performCheck(automatic = false) {
    const current = session.current;
    if (!current.mounted || current.busy) return;
    current.busy = true;
    current.lastCheck = Date.now();
    window.clearTimeout(current.timer);
    const previous = current.state;
    publish({ ...previous, status: "checking", error: "" });
    try {
      const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
      if (!current.mounted) {
        closeUpdate(update);
        return;
      }
      const replaced = current.update;
      current.update = update;
      current.checkFailed = false;
      publish({ status: update ? "available" : "current", version: update?.version ?? "", error: "" });
      closeUpdate(replaced);
    } catch (reason) {
      current.checkFailed = true;
      if (current.mounted) publish(automatic ? previous : {
        ...previous,
        status: current.update ? "available" : "error",
        error: `Couldn't check for updates. ${errorText(reason)}`,
      });
    } finally {
      current.busy = false;
      if (current.mounted && "__TAURI_INTERNALS__" in window) {
        current.timer = window.setTimeout(() => void performCheck(true), UPDATE_CHECK_INTERVAL_MS);
      }
    }
  }, [publish]);

  const installUpdate = useCallback(async () => {
    const current = session.current;
    const update = current.update;
    if (!current.mounted || current.busy || !update) return;
    current.busy = true;
    window.clearTimeout(current.timer);
    publish({ status: "installing", version: update.version, error: "" });
    try {
      await update.downloadAndInstall(undefined, { restartAfterInstall: true });
      if (!navigator.userAgent.includes("Windows")) await relaunch();
      // Keep checks and duplicate installs locked until the app exits.
    } catch (reason) {
      current.busy = false;
      if (current.mounted) {
        publish({ status: "available", version: update.version, error: `Couldn't install the update. ${errorText(reason)}` });
        if ("__TAURI_INTERNALS__" in window) {
          current.timer = window.setTimeout(() => void checkForUpdates(true), UPDATE_CHECK_INTERVAL_MS);
        }
      }
    } finally {
      if (!current.mounted) {
        current.update = null;
        closeUpdate(update);
      }
    }
  }, [checkForUpdates, publish]);

  useEffect(() => {
    const current = session.current;
    current.mounted = true;
    const checkIfDue = () => {
      if (current.lastCheck === null || Date.now() - current.lastCheck >= UPDATE_CHECK_INTERVAL_MS) {
        void checkForUpdates(true);
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") checkIfDue(); };
    const onOnline = () => { if (current.checkFailed) void checkForUpdates(true); else checkIfDue(); };
    if ("__TAURI_INTERNALS__" in window) {
      checkIfDue();
      window.addEventListener("focus", checkIfDue);
      window.addEventListener("online", onOnline);
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      current.mounted = false;
      window.clearTimeout(current.timer);
      window.removeEventListener("focus", checkIfDue);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      if (current.state.status !== "installing") {
        closeUpdate(current.update);
        current.update = null;
      }
    };
  }, [checkForUpdates]);

  return { ...state, checkForUpdates, installUpdate };
}

export type AppUpdates = ReturnType<typeof useAppUpdates>;
