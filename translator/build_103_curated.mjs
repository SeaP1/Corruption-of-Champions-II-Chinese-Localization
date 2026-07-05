import fs from "node:fs";
import path from "node:path";

const sourceDir = path.resolve("translator", "extracted_json");
const sourceName = fs.readdirSync(sourceDir).filter((name) => /^103\..*\.js\.json$/i.test(name)).sort((a, b) => a.localeCompare(b))[0];
if (!sourceName) throw new Error(`No extracted 103.*.js.json found in ${sourceDir}`);
const sourcePath = path.join(sourceDir, sourceName);
const sourceJsPath = path.resolve("resources", "app", sourceName.slice(0, -5));
const outDir = path.resolve("translator", "extracted_json_curated");
const outPath = path.join(outDir, sourceName);

const ALWAYS_KEEP_EXACT = new Set([
  "Story", "Easy", "Normal", "Dark",
  "OFF", "ON", "AUTO",
  "MALE", "FEMALE", "FIRST", "SECOND",
  "Fullscreen", "Windowed",
  "Default", "Stylized", "Dyslexia-friendly",
  "LIGHT", "DARK", "BIMBO",
  "Upload", "Confirm", "Yes", "No", "Back", "Exit Game",
  "PLAYER", "MANUAL",
  "Images", "Fonts", "Theme", "Gender", "Autosave", "Difficulty", "Brightness"
]);

const OPTION_WINDOW_START = 148000;
const OPTION_WINDOW_END = 159200;
const CONFIRM_WINDOWS = [[127000, 128000], [165700, 168100]];

function hasLetters(s) { return /[A-Za-z]/.test(s); }
function hasCjk(s) { return /[\u4e00-\u9fff]/.test(s); }
function inRange(row, start, end) { return typeof row.start === "number" && row.start >= start && row.start <= end; }
function inAnyConfirmWindow(row) { return CONFIRM_WINDOWS.some(([a, b]) => inRange(row, a, b)); }
function wordCount(s) { return (String(s).match(/[A-Za-z]+/g) || []).length; }
function isTitleish(s) {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 7) return false;
  return words.every((w) => /^[A-Z0-9][A-Za-z0-9'.&()/-]*$/.test(w) || /^[A-Z]{2,}$/.test(w));
}
function balancedStructure(t) {
  return (t.match(/\[/g)||[]).length === (t.match(/\]/g)||[]).length &&
    (t.match(/</g)||[]).length === (t.match(/>/g)||[]).length;
}
function looksResourceOrUrl(t) {
  return /^\.\//.test(t) || /^https?:\/\//i.test(t) || /\.(png|jpg|jpeg|webp|svg|css|js|json)$/i.test(t) || /^webpack:/i.test(t);
}
function looksRuntimeError(t) {
  return /Symbol\.iterator|Cannot call a class|super\(\)|Super expression|non-iterable|destructure|initialised|Derived constructors|Invariant Violation|React/i.test(t);
}
function looksCodeOrCss(t) {
  if (/[{};]/.test(t)) return true;
  if (/\b(function|return|typeof|undefined|null|Promise|Object|Array|RegExp|prototype|constructor|WEBPACK|regeneratorRuntime|className)\b/.test(t)) return true;
  if (/\.(concat|map|filter|forEach|then|catch|slice|push|apply|call|bind)\s*\(/.test(t)) return true;
  if (/^[.#]?[a-z][A-Za-z0-9_$:-]+(?:\s+[.#]?[a-z][A-Za-z0-9_$:-]+){1,}$/.test(t) && !/[.!?]$/.test(t) && wordCount(t) <= 5) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t) && !ALWAYS_KEEP_EXACT.has(t)) return true;
  return false;
}
function cleanVisible(row) {
  const t = String(row.original || "").trim();
  if (!t || !hasLetters(t) || hasCjk(t)) return false;
  if (!balancedStructure(t)) return false;
  if (looksResourceOrUrl(t) || looksRuntimeError(t) || looksCodeOrCss(t)) return false;
  return true;
}
function keepOptionArea(row) {
  const t = String(row.original || "").trim();
  if (!inRange(row, OPTION_WINDOW_START, OPTION_WINDOW_END)) return false;
  if (!cleanVisible(row)) return false;
  if (ALWAYS_KEEP_EXACT.has(t)) return true;
  if (row.category === "button_or_tooltip") return t.length <= 80;
  if (row.category === "possible_text") {
    if (t.length <= 45 && isTitleish(t)) return true;
    if (/[.!?]$/.test(t) && t.length <= 260) return true;
    if (wordCount(t) >= 2 && wordCount(t) <= 5 && /^[A-Z]/.test(t)) return true;
  }
  if (row.category === "unknown") {
    if (ALWAYS_KEEP_EXACT.has(t)) return true;
    if (t.length <= 24 && isTitleish(t)) return true;
  }
  return false;
}
function keepConfirmOrPopup(row) {
  const t = String(row.original || "").trim();
  if (!inAnyConfirmWindow(row)) return false;
  if (!cleanVisible(row)) return false;
  if (ALWAYS_KEEP_EXACT.has(t)) return true;
  if (row.category === "button_or_tooltip") return t.length <= 80;
  if (/[.!?]$/.test(t) && t.length <= 260) return true;
  if (t.length <= 60 && isTitleish(t)) return true;
  return false;
}
function keepGeneralSafe(row) {
  const t = String(row.original || "").trim();
  if (!row.shouldTranslate) return false;
  if (!cleanVisible(row)) return false;
  if (row.category === "button_or_tooltip" && t.length <= 80) return true;
  if (row.category === "property_text" && t.length <= 180 && (isTitleish(t) || /[.!?]$/.test(t))) return true;
  if (row.category === "possible_text" && /[.!?]$/.test(t) && t.length >= 10 && t.length <= 260) return true;
  return false;
}
function keepRow(row) {
  if (keepOptionArea(row)) return { keep: true, reason: "103_options_area" };
  if (keepConfirmOrPopup(row)) return { keep: true, reason: "103_confirm_or_popup" };
  if (keepGeneralSafe(row)) return { keep: true, reason: "103_general_safe_visible" };
  return { keep: false, reason: "disabled_for_103_curated_safety" };
}

const doc = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const sourceText = fs.existsSync(sourceJsPath) ? fs.readFileSync(sourceJsPath, "utf8") : "";
let kept = 0;
let disabled = 0;
const keptByReason = {};
const keptByCategory = {};
for (const row of doc.rows || []) {
  const decision = keepRow(row);
  row.shouldTranslate = decision.keep;
  row.curatedReason = decision.reason;
  row.curatedSource = "build_103_curated";
  if (decision.keep) {
    kept += 1;
    keptByReason[decision.reason] = (keptByReason[decision.reason] || 0) + 1;
    keptByCategory[row.category || "unknown"] = (keptByCategory[row.category || "unknown"] || 0) + 1;
  } else {
    disabled += 1;
  }
}
doc.curated = {
  generatedAt: new Date().toISOString(),
  source: sourcePath,
  sourceJs: sourceJsPath,
  sourceJsBytes: sourceText.length,
  policy: "Curated visible UI/configuration text from 103 core chunk. Keeps options UI, confirm popups, concise buttons/headings/descriptions; disables runtime errors, paths, CSS/classes, React internals, and code fragments.",
  kept,
  disabled,
  keptByReason,
  keptByCategory,
  windows: { optionArea: [OPTION_WINDOW_START, OPTION_WINDOW_END], confirmWindows: CONFIRM_WINDOWS }
};
doc.shouldTranslate = kept;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ outPath, kept, disabled, keptByReason, keptByCategory }, null, 2));
