import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Library } from "./Library";
import { NoteWindow } from "./NoteWindow";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/500.css";
import "@fontsource/source-sans-3/600.css";
import "./styles.css";

export default function App() {
  const label = useMemo(() => "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "library", []);
  return label.startsWith("note-") ? <NoteWindow id={label.slice(5)} /> : <Library />;
}
