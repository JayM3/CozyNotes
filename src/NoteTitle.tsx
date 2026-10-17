import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { FindState } from "./editorTools";

type Props = {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  readOnly: boolean;
  find: FindState | undefined;
  onChange: (title: string) => void;
  onEnter: () => void;
  onBlur: () => void;
  onComposition: (composing: boolean) => void;
};

export function NoteTitle({ inputRef, value, readOnly, find, onChange, onEnter, onBlur, onComposition }: Props) {
  const backdrop = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const matches = find?.matches.filter(match => match.inTitle) ?? [];
  const active = find?.matches[find.activeIndex];
  const showMatches = matches.length > 0 && !focused;
  const parts = [];
  let position = 0;
  for (const match of matches) {
    parts.push(<span key={`text-${match.from}`}>{value.slice(position, match.from)}</span>);
    parts.push(<mark key={`match-${match.from}`} className={`find-match ${match === active ? "find-match-active" : ""}`} data-title-find-active={match === active}>{value.slice(match.from, match.to)}</mark>);
    position = match.to;
  }
  parts.push(<span key="tail">{value.slice(position)}</span>);

  useEffect(() => {
    const input = inputRef.current;
    const highlights = backdrop.current;
    if (!input || !highlights || !showMatches) return;
    const current = highlights.querySelector<HTMLElement>('[data-title-find-active="true"]');
    if (current) input.scrollLeft = Math.max(0, current.offsetLeft - input.clientWidth / 2);
    highlights.scrollLeft = input.scrollLeft;
  }, [inputRef, showMatches, active, value]);

  return <div className="note-heading">
    <div className="note-title-field">
      <div ref={backdrop} className="note-title-highlights" aria-hidden="true" hidden={!showMatches}>{parts}</div>
      <input
        ref={inputRef}
        className={`note-title-input ${showMatches ? "has-find-highlights" : ""}`}
        aria-label="Note title"
        placeholder="Title"
        value={value}
        readOnly={readOnly}
        onChange={event => onChange(event.target.value.replace(/[\r\n\u2028\u2029]+/g, " "))}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); onBlur(); }}
        onScroll={event => { if (backdrop.current) backdrop.current.scrollLeft = event.currentTarget.scrollLeft; }}
        onCompositionStart={() => onComposition(true)}
        onCompositionEnd={() => { window.setTimeout(() => onComposition(false), 0); }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            onEnter();
          }
        }}
      />
    </div>
  </div>;
}
