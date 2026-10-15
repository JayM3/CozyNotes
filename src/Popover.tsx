import { useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import type { ReactNode, CSSProperties } from "react";

export function Popover({ label, icon, children, disabled = false, className = "" }: {
  label: string; icon: ReactNode; children: ReactNode; disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(224, window.innerWidth - 16);
    const height = Math.min(menu.current.scrollHeight, window.innerHeight - 16);
    setPosition({ width, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) });
    menu.current.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close(false);
    };
    const resized = () => close(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resized);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", resized); };
  }, [open]);
  return <div className={`popover ${className}`}>
    <button ref={trigger} className="tool" aria-label={label} title={label} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined}
      disabled={disabled} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>{icon}</button>
    {open && <div id={id} ref={menu} className="popover-menu" role="menu" aria-label={label} style={position}
      onClick={event => {
        const button = (event.target as HTMLElement).closest("button:not(:disabled)");
        if (button) close(!button.hasAttribute("data-editor-action"));
      }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        if (event.key === "Tab") { close(true); return; }
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []).filter(button => button.getClientRects().length > 0);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : -1;
        if (target >= 0) { event.preventDefault(); buttons[target]?.focus(); }
      }}>{children}</div>}
  </div>;
}
