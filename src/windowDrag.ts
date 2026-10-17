import type { MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const interactive = 'button, a, input, select, textarea, label, summary, [role="button"], [role="menu"], [contenteditable]:not([contenteditable="false"])';

export function startWindowDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.detail > 1 || !("__TAURI_INTERNALS__" in window)) return;
  if (!(event.target instanceof Element) || event.target.closest(interactive)) return;

  event.preventDefault();
  // React handles the press before Tauri's document listener. Stop it there so
  // the same press cannot start two native drag operations.
  event.stopPropagation();
  void getCurrentWindow().startDragging().catch(error => console.error("Couldn't move the window.", error));
}
