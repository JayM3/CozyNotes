import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Library } from "./Library";
import { NoteWindow } from "./NoteWindow";
import { ThemeProvider } from "./theme";
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/400-italic.css";
import "@fontsource/nunito/500.css";
import "@fontsource/nunito/500-italic.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/600-italic.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/700-italic.css";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/400-italic.css";
import "@fontsource/source-sans-3/500.css";
import "@fontsource/source-sans-3/500-italic.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-sans-3/600-italic.css";
import "@fontsource/source-sans-3/700.css";
import "@fontsource/source-sans-3/700-italic.css";
import "../tokens.css";
import "./styles.css";

export default function App() {
  const label = useMemo(() => "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "library", []);
  return <ThemeProvider>{label.startsWith("note-") ? <NoteWindow id={label.slice(5)} /> : <Library />}</ThemeProvider>;
}
