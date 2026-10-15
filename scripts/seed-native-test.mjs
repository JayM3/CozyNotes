import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(process.argv[2] ?? "");
const localTemp = realpathSync(tmpdir());
const relativeRoot = relative(localTemp, root);
if (!relativeRoot || relativeRoot.startsWith("..") || !root.includes("cozynotes-everyday-test-")) throw new Error("Use a new isolated test directory beneath TEMP.");
const databasePath = join(root, "data", "cozynotes.sqlite");
if (existsSync(databasePath)) throw new Error("Refusing to replace an existing database.");
mkdirSync(join(root, "data"), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, plain_text TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'cream', revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER)");
const paragraph = text => ({ type: "paragraph", content: [{ type: "text", text }] });
const task = (text, checked, nested = []) => ({ type: "taskItem", attrs: { checked }, content: [paragraph(text), ...nested] });
const document = { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "Alpha " }, { type: "text", text: "beta", marks: [{ type: "bold" }] }, { type: "text", text: " caf\u00e9 Stra\u00dfe \u03a3\u03c2\u03c3 \ud83d\ude00 needle" }] },
  paragraph("A second needle after a longer paragraph. <img src=x onerror=alert(1)>"),
  { type: "paragraph", content: [{ type: "text", text: "soft" }, { type: "hardBreak" }, { type: "text", text: "break" }] },
  { type: "taskList", content: [task("Pack bag", true, [{ type: "taskList", content: [task("Charger", true)] }]), task("Keys", false)] },
] };
const insert = db.prepare("INSERT INTO notes VALUES (?,?,?, ?,7,1000,2000,?)");
insert.run("fixture-main", JSON.stringify(document), "legacy plain text", "sage", null);
insert.run("fixture-other", JSON.stringify({ type: "doc", content: [paragraph("A rose colored note")] }), "A rose colored note", "rose", null);
insert.run("fixture-trash", JSON.stringify({ type: "doc", content: [paragraph("Trashed needle")] }), "Trashed needle", "mist", 3000);
insert.run("fixture-broken", "{unreadable", "Text preserved from an unreadable document", "cream", null);
db.close();
console.log(JSON.stringify({ root, databasePath, syntheticNotes: 4 }));
