import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : "translator/translated_json");
const dryRun = process.argv.includes("--dry-run");

const UI_GLOSSARY = new Map([
  ["Next", "下一步"],
  ["Back", "返回"],
  ["Leave", "离开"],
  ["Yes", "是"],
  ["No", "否"],
  ["Done", "完成"],
  ["Exit", "退出"],
  ["Cancel", "取消"],
  ["Accept", "接受"],
  ["Decline", "拒绝"]
]);
function applyUiGlossary(row) {
  if (!row || row.category !== "button_or_tooltip") return false;
  const hit = UI_GLOSSARY.get(row.original);
  if (!hit) return false;
  row.translation = hit;
  delete row.translationError;
  delete row.rejectedTranslation;
  row.translationStatus = "ui_glossary";
  row.reusedAt = new Date().toISOString();
  return true;
}

function rowsOf(doc) { return Array.isArray(doc?.rows) ? doc.rows : []; }
function usable(row) {
  return row && row.shouldTranslate !== false && typeof row.original === "string" && row.original.trim() && typeof row.translation === "string" && row.translation.trim() && row.translationStatus !== "failed" && !row.translationError;
}

const files = fs.readdirSync(dir).filter(x => x.endsWith(".json")).sort((a, b) => a.localeCompare(b));
const memory = new Map();
const conflicts = new Set();

for (const name of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  for (const row of rowsOf(doc)) {
    if (!usable(row)) continue;
    const existing = memory.get(row.original);
    const value = row.translation.trim();
    if (!existing) memory.set(row.original, { translation: value, sourceId: row.id || "", sourceFile: name });
    else if (existing.translation !== value) { memory.delete(row.original); conflicts.add(row.original); }
  }
}

let totalReused = 0;
let touchedFiles = 0;
for (const name of files) {
  const full = path.join(dir, name);
  const doc = JSON.parse(fs.readFileSync(full, "utf8"));
  let changed = 0;
  for (const row of rowsOf(doc)) {
    if (!row || row.shouldTranslate === false || !row.original || conflicts.has(row.original)) continue;
    const glossaryApplied = applyUiGlossary(row);
    if (glossaryApplied) { changed++; continue; }
    if (row.translation && row.translation.trim()) continue;
    const hit = memory.get(row.original);
    if (!hit) continue;
    row.translation = hit.translation;
    delete row.translationError;
    delete row.rejectedTranslation;
    row.translationStatus = "reused_duplicate_original";
    row.translationSourceId = hit.sourceId;
    row.translationSourceFile = hit.sourceFile;
    row.reusedAt = new Date().toISOString();
    changed++;
  }
  if (changed) {
    touchedFiles++;
    totalReused += changed;
    console.log(`${name}: reused=${changed}`);
    if (!dryRun) fs.writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }
}
console.log(`done: reused=${totalReused}, touchedFiles=${touchedFiles}, conflictsSkipped=${conflicts.size}, dryRun=${dryRun}`);
