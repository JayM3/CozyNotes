import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Window as NativeWindow } from "@tauri-apps/api/window";
import { Pin } from "lucide-react";
import { notesApi } from "./api";

export type KeepOnTopStatus = "loading" | "ready" | "unsupported" | "error";
type KeepOnTopErrorKind = "initialization" | "toggle" | null;

export type KeepOnTopController = {
  pinned: boolean;
  pending: boolean;
  status: KeepOnTopStatus;
  error: string;
  toggle: () => Promise<boolean>;
  retry: () => Promise<boolean>;
};

export const keepOnTopUnavailableMessage = "Keep on top isn't available in this desktop session.";

export function useKeepOnTop(nativeWindow: NativeWindow): KeepOnTopController {
  const [pinned, setPinned] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<KeepOnTopStatus>("loading");
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState<KeepOnTopErrorKind>(null);
  const mounted = useRef(false);
  const loadAttempt = useRef(0);
  const toggleRequest = useRef<Promise<boolean> | null>(null);

  const initialize = useCallback(async () => {
    const attempt = ++loadAttempt.current;
    setStatus("loading");
    setError("");
    setErrorKind(null);
    try {
      const capabilities = await notesApi.getPlatformCapabilities();
      if (!mounted.current || attempt !== loadAttempt.current) return false;
      if (!capabilities.alwaysOnTop) {
        setPinned(false);
        setStatus("unsupported");
        return true;
      }
      const current = await nativeWindow.isAlwaysOnTop();
      if (!mounted.current || attempt !== loadAttempt.current) return false;
      setPinned(current);
      setStatus("ready");
      return true;
    } catch {
      if (!mounted.current || attempt !== loadAttempt.current) return false;
      setStatus("error");
      setError("Couldn't initialize Keep on top. Try again.");
      setErrorKind("initialization");
      return false;
    }
  }, [nativeWindow]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadAttempt.current += 1;
    };
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const toggle = useCallback(async () => {
    if (status !== "ready" || toggleRequest.current || !mounted.current) return false;
    const nextValue = !pinned;
    setError("");
    setErrorKind(null);
    setPending(true);
    const request = (async () => {
      try {
        await nativeWindow.setAlwaysOnTop(nextValue);
        if (!mounted.current) return false;
        setPinned(nextValue);
        return true;
      } catch {
        if (mounted.current) {
          setError("Couldn't change Keep on top. Try again.");
          setErrorKind("toggle");
        }
        return false;
      } finally {
        toggleRequest.current = null;
        if (mounted.current) setPending(false);
      }
    })();
    toggleRequest.current = request;
    return request;
  }, [nativeWindow, pinned, status]);

  const retry = useCallback(() => errorKind === "initialization" ? initialize() : toggle(), [errorKind, initialize, toggle]);

  return { pinned, pending, status, error, toggle, retry };
}

export function KeepOnTopButton({ controller, disabled = false }: { controller: KeepOnTopController; disabled?: boolean }) {
  const unavailableId = useId();
  const unsupported = controller.status === "unsupported";
  const actionTitle = controller.pinned ? "Stop keeping on top" : "Keep on top";
  const blocked = disabled || (controller.status !== "ready" && !unsupported) || controller.pending;
  return <>
    <button
      type="button"
      className={`tool keep-on-top-tool ${controller.pinned ? "active" : ""}`}
      disabled={blocked}
      aria-label="Keep on top"
      aria-pressed={controller.pinned}
      aria-disabled={unsupported ? true : undefined}
      aria-describedby={unsupported ? unavailableId : undefined}
      title={actionTitle}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { if (!unsupported) void controller.toggle(); }}
    >
      <Pin size={16} aria-hidden="true" />
    </button>
    {unsupported && <span id={unavailableId} className="visually-hidden">{keepOnTopUnavailableMessage}</span>}
  </>;
}
