import type { FormEvent } from "react";
import { useId, useState } from "react";
import { Check } from "lucide-react";
import { paperColors } from "./api";
import type { NoteDefaults, NoteFont, NoteFontSize } from "./api";
import { factoryNoteDefaults, noteFonts, noteSizePresets, noteTypography, readingSizes } from "./noteDefaults";

type Draft = Omit<NoteDefaults, "width" | "height"> & { width: string; height: string };
const draftOf = (value: NoteDefaults): Draft => ({ ...value, width: String(value.width), height: String(value.height) });

export function NewNoteDefaults({ initial, busy, onSave }: {
  initial: NoteDefaults;
  busy: boolean;
  onSave: (defaults: NoteDefaults) => Promise<NoteDefaults>;
}) {
  const id = useId();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [custom, setCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const width = Number(draft.width);
  const height = Number(draft.height);
  const widthError = !Number.isInteger(width) || width < 305 || width > 1600;
  const heightError = !Number.isInteger(height) || height < 240 || height > 1600;
  const changed = Object.entries(draft).some(([key, value]) => value !== draftOf(saved)[key as keyof Draft]);
  const disabled = busy || saving;
  const preset = custom ? "custom" : noteSizePresets.find(value => value.width === width && value.height === height)?.id ?? "custom";
  const previewWidth = widthError ? saved.width : width;
  const previewHeight = heightError ? saved.height : height;
  const previewScale = Math.min(240 / previewWidth, 270 / previewHeight);

  const change = (patch: Partial<Draft>) => {
    setDraft(value => ({ ...value, ...patch }));
    setMessage("");
    setError("");
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || !changed || widthError || heightError) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await onSave({ ...draft, width, height });
      setSaved(result);
      setDraft(draftOf(result));
      setMessage("Defaults saved. Your next note will use these settings.");
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Please try again.";
      setError(`Couldn't save note defaults. ${detail}`);
    } finally { setSaving(false); }
  };

  return <section className="settings-section" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>New note defaults</h2>
    <p className="defaults-description">Choose how new notes start. Existing notes keep their appearance.</p>
    <form className="defaults-form" onSubmit={event => void save(event)}>
      <fieldset disabled={disabled} className="defaults-fields">
        <legend className="visually-hidden">Default note appearance and size</legend>
        <fieldset className="defaults-colors">
          <legend>Paper color</legend>
          <div className="defaults-swatches">
            {paperColors.map(color => <label key={color} className={`defaults-swatch paper-${color}`}>
              <input type="radio" name={`${id}-color`} value={color} checked={draft.color === color} onChange={() => change({ color })} />
              <span className="defaults-swatch-paper" aria-hidden="true">{draft.color === color && <Check size={16} />}</span>
              <span>{color[0].toUpperCase() + color.slice(1)}</span>
            </label>)}
          </div>
        </fieldset>
        <div className="defaults-pair">
          <label htmlFor={`${id}-font`}>Note font
            <select id={`${id}-font`} value={draft.fontFamily} onChange={event => change({ fontFamily: event.target.value as NoteFont })}>
              {noteFonts.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
            </select>
          </label>
          <label htmlFor={`${id}-text-size`}>Text size
            <select id={`${id}-text-size`} value={draft.fontSize} onChange={event => change({ fontSize: Number(event.target.value) as NoteFontSize })}>
              {readingSizes.map(size => <option key={size} value={size}>{size} px</option>)}
            </select>
          </label>
        </div>
        <p className="defaults-hint">The note’s text-size buttons adjust reading size until you close it. Ctrl+0 returns to its saved size.</p>
        <label htmlFor={`${id}-preset`}>Note size
          <select id={`${id}-preset`} value={preset} onChange={event => {
            const selected = noteSizePresets.find(value => value.id === event.target.value);
            setCustom(!selected);
            if (selected) change({ width: String(selected.width), height: String(selected.height) });
          }}>
            {noteSizePresets.map(value => <option key={value.id} value={value.id}>{value.label} · {value.width} × {value.height}</option>)}
            <option value="custom">Custom</option>
          </select>
        </label>
        <div className="defaults-pair">
          <label htmlFor={`${id}-width`}><span id={`${id}-width-label`}>Width</span>
            <input id={`${id}-width`} aria-labelledby={`${id}-width-label`} type="number" min={305} max={1600} step={1} value={draft.width} aria-invalid={widthError} aria-describedby={`${id}-width-hint`} onChange={event => change({ width: event.target.value })} />
            <span id={`${id}-width-hint`} className={widthError ? "settings-error" : "defaults-hint"}>305–1600 px, whole numbers</span>
          </label>
          <label htmlFor={`${id}-height`}><span id={`${id}-height-label`}>Height</span>
            <input id={`${id}-height`} aria-labelledby={`${id}-height-label`} type="number" min={240} max={1600} step={1} value={draft.height} aria-invalid={heightError} aria-describedby={`${id}-height-hint`} onChange={event => change({ height: event.target.value })} />
            <span id={`${id}-height-hint`} className={heightError ? "settings-error" : "defaults-hint"}>240–1600 px, whole numbers</span>
          </label>
        </div>
        <p className="defaults-hint">Sizes follow display scaling and fit your screen. Double-click a note border to reset that dimension to your current default.</p>
      </fieldset>
      <figure className="defaults-preview">
        <figcaption>Preview <span>Scaled to fit</span></figcaption>
        <div className="defaults-preview-space">
          <div style={{ width: previewWidth * previewScale, height: previewHeight * previewScale }} className="defaults-preview-frame">
            <div className={`defaults-preview-note paper-${draft.color}`} style={{ ...noteTypography(draft.fontFamily, draft.fontSize), width: previewWidth, height: previewHeight, transform: `scale(${previewScale})` }}>
              <div className="defaults-preview-toolbar" aria-hidden="true"><span /><span /><span /></div>
              <div className="defaults-preview-content">
                <h3>A little room for ideas</h3>
                <p>Keep the things you want to remember close by.</p>
                <p className="defaults-preview-task"><span aria-hidden="true">☐</span> Make something lovely</p>
              </div>
            </div>
          </div>
        </div>
        <p>{widthError || heightError ? "Enter a valid size to preview it" : `${width} × ${height} logical pixels`}</p>
      </figure>
      <div className="defaults-actions">
        <button type="submit" className="update-button" disabled={disabled || !changed || widthError || heightError}>{saving ? "Saving defaults…" : "Save defaults"}</button>
        <button type="button" className="text-action" disabled={disabled} onClick={() => {
          setCustom(false);
          change(draftOf(factoryNoteDefaults));
          setMessage("Factory values selected. Save defaults to use them for new notes.");
        }}>Reset to CozyNotes defaults</button>
      </div>
      <p className="defaults-save-status settings-state" role="status">{saving ? "Saving note defaults…" : message}</p>
      {error && <p className="settings-error defaults-save-status" role="alert">{error}</p>}
    </form>
  </section>;
}
