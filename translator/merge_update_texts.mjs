import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function hasArg(name) { return args.includes(name); }

const GAME_ROOT = process.cwd();
const DEFAULT_NEW_ROOT = path.resolve(GAME_ROOT, "resources", "app");
const NEW_APP_ROOT = path.resolve(argValue("--new-root", DEFAULT_NEW_ROOT));
const JSON_DIR = path.resolve(argValue("--json-dir", path.join(GAME_ROOT, "translator", "translated_json")));
const OUT_DIR = path.resolve(argValue("--out-dir", hasArg("--in-place") ? JSON_DIR : path.join(GAME_ROOT, "translator", "translated_json_update_preview")));
const BACKUP_DIR = path.resolve(argValue("--backup-dir", path.join(GAME_ROOT, "translator", `translated_json_backup_before_update_${timestamp()}`)));
const IN_PLACE = hasArg("--in-place");
const INCLUDE_NEW_FILES = hasArg("--include-new-files");
function autoIncludeNewFile(jsName, key) {
  return jsName.startsWith("Content_") || key === "103" || key === "505" || key === "673";
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function sha1(text) { return crypto.createHash("sha1").update(text).digest("hex"); }
function shortHash(text) { return sha1(text).slice(0, 12); }
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function logicalKey(name) {
  const base = name.endsWith(".json") ? name.slice(0, -5) : name;
  if (base.startsWith("Content_")) return base.split(".")[0];
  const m = base.match(/^(\d+)\./);
  if (m) return m[1];
  return base.replace(/\.[0-9a-f]{8,}(?=\.js$)/i, "");
}
function listFiles(dir, pred) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter(pred)
    .sort((a, b) => a.localeCompare(b));
}
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
function lineOf(starts, offset) {
  let low = 0, high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}
function decodeJsString(raw) {
  try { return Function(`"use strict"; return (${raw});`)(); }
  catch { return null; }
}
function scanStringLiterals(source) {
  const tokens = [];
  let i = 0, inLineComment = false, inBlockComment = false;
  while (i < source.length) {
    const ch = source[i], next = source[i + 1];
    if (inLineComment) { if (ch === "\n") inLineComment = false; i += 1; continue; }
    if (inBlockComment) { if (ch === "*" && next === "/") { inBlockComment = false; i += 2; } else i += 1; continue; }
    if (ch === "/" && next === "/") { inLineComment = true; i += 2; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i += 2; continue; }
    if (ch !== '"' && ch !== "'") { i += 1; continue; }
    const quote = ch, start = i;
    i += 1;
    let escaped = false;
    while (i < source.length) {
      const current = source[i];
      if (escaped) { escaped = false; i += 1; continue; }
      if (current === "\\") { escaped = true; i += 1; continue; }
      if (current === quote) {
        i += 1;
        const end = i;
        const raw = source.slice(start, end);
        const value = decodeJsString(raw);
        if (typeof value === "string") tokens.push({ start, end, raw, value });
        break;
      }
      i += 1;
    }
  }
  return tokens;
}
function looksLikeAssetOrCode(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[A-Z0-9_.$-]+$/.test(trimmed) && trimmed.length <= 32) return true;
  if (/^[a-z0-9_.$-]+$/i.test(trimmed) && !/[aeiou]/i.test(trimmed) && trimmed.length <= 32) return true;
  if (/^[a-z0-9_./\\:-]+\.(png|jpg|jpeg|webp|svg|mp4|woff2?|ico|json|js|css|html)$/i.test(trimmed)) return true;
  if (/^[a-z0-9_./\\:-]+$/i.test(trimmed) && /[\\/]/.test(trimmed)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return true;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  return false;
}
function classifyJsString(source, token) {
  const before = source.slice(Math.max(0, token.start - 260), token.start);
  const after = source.slice(token.end, Math.min(source.length, token.end + 120));
  const value = token.value;
  if (/\boutput\s*\([^)]*$/s.test(before) || /\btextify\s*\([^)]*$/s.test(before)) return "dialogue";
  if (/\b(addButton|addDisabledButton|addGatedButton|addGatedButtonObj|addTooltip)\s*\([^)]*$/s.test(before)) return "button_or_tooltip";
  if (/\b(showName)\s*\([^)]*$/s.test(before)) return "speaker";
  if (/[.$\w\]]\s*\.\s*(name|short|longName|description|tooltip|title|text|label|message)\s*[:=]\s*$/s.test(before)) return "property_text";
  if (/"(?:name|short|longName|description|tooltip|title|text|label|message)"\s*:\s*$/s.test(before)) return "property_text";
  if (/^\s*[,\)\]}]/.test(after) && /[.!?,;:]|<[^>]+>|\[[^\]]+\]|\s/.test(value)) return "possible_text";
  return "unknown";
}
function baseShouldTranslate(value, category) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (looksLikeAssetOrCode(trimmed)) return false;
  if (category !== "unknown") return true;
  return trimmed.length >= 18 && /[.!?,;:]|\s/.test(trimmed);
}
function extractFromJs(fileName, source) {
  const starts = lineStarts(source);
  return scanStringLiterals(source).map((token) => {
    const category = classifyJsString(source, token);
    const shouldTranslate = baseShouldTranslate(token.value, category);
    return {
      id: `${fileName}:${token.start}:${token.end}:${shortHash(token.value)}`,
      file: fileName,
      category,
      shouldTranslate,
      original: token.value,
      translation: "",
      start: token.start,
      end: token.end,
      line: lineOf(starts, token.start),
      raw: token.raw
    };
  });
}
function hasLetters(s) { return /[A-Za-z]/.test(String(s || "")); }
function hasCjk(s) { return /[\u4e00-\u9fff]/.test(String(s || "")); }
function words(s) { return (String(s || "").match(/[A-Za-z]+(?:['?\-][A-Za-z]+)?|\d+(?:\.\d+)?/g) || []).length; }
function balanced(s) { return (String(s).match(/\[/g)||[]).length === (String(s).match(/\]/g)||[]).length; }
function sentenceLike(s) { return /[.!?？。！](["')\]]|$)/.test(String(s).trim()) || /\n\s*\n/.test(String(s)); }
function titleLike(s) {
  const parts = String(s).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 10) return false;
  const small = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);
  return parts.every((w, i) => /^[A-Z0-9][A-Za-z0-9'.&:\-]*$/.test(w) || (i > 0 && small.has(w)));
}
function reject673(row) {
  const t = String(row.original || "").trim();
  if (!row.shouldTranslate) return "source_not_translatable";
  if (!t || !hasLetters(t) || hasCjk(t)) return "reject_base";
  if (!balanced(t)) return "reject_unbalanced";
  if (/^(Derived constructors may only|this hasn't been initialised|Super expression must|Cannot call a class|Invalid attempt to|In order to be iterable)/i.test(t)) return "reject_runtime_error";
  if (/^\.[A-Za-z_$][\w$]*\s+not overwritten/i.test(t)) return "reject_internal_not_overwritten";
  if (/^\([^)]+\)$/.test(t)) return "reject_css_or_parenthesized";
  if (/[{}]/.test(t)) return "reject_code_punctuation";
  if (/=>|\b(function|return|typeof|undefined|null|Promise|Object|Array|RegExp|prototype|constructor|WEBPACK|regeneratorRuntime|Symbol\.iterator)\b/.test(t)) return "reject_code_words";
  if (/\.(concat|map|filter|forEach|then|catch|slice|push|apply|call|bind)\s*\(/.test(t)) return "reject_code_call";
  if (/^[,.:;)+\]}]/.test(t) || /[,;:({\[]$/.test(t)) return "reject_fragment_edge";
  if (/\.(js|json|png|jpg|jpeg|webp|svg|css|coc2)$/i.test(t)) return "reject_asset_path";
  if (t.length < 3) return "reject_too_short";
  if (/^(s|t|ve|re|ll|d|m)\b/i.test(t)) return "reject_leading_contraction_fragment";
  if (/\)\)\)|\]\)\)|"\]\)/.test(t)) return "reject_code_tail_fragment";
  if (/^[a-z]/.test(t) && !sentenceLike(t) && words(t) < 10) return "reject_lower_fragment";
  return "";
}
function keepReason(row, key, oldWantedOriginals) {
  if (oldWantedOriginals.has(row.original)) return "carried_from_old_json";
  const t = String(row.original || "").trim();
  const w = words(t);
  if (key === "673") {
    const bad = reject673(row);
    if (bad) return "";
    if (row.category === "dialogue") return "wide_dialogue";
    if (row.category === "property_text") return "wide_property_text";
    if (row.category === "button_or_tooltip" && (titleLike(t) || sentenceLike(t))) return "wide_button_or_tooltip";
    if (row.category === "possible_text" && (sentenceLike(t) || w >= 10 || titleLike(t))) return "wide_possible_text";
    if (row.category === "unknown" && w >= 35 && sentenceLike(t) && !/^[a-z]/.test(t)) return "wide_unknown_long_prose";
    return "";
  }
  if (key === "103" || key === "505") {
    if (!row.shouldTranslate || !hasLetters(t) || hasCjk(t)) return "";
    if (row.category !== "unknown") return `generic_${row.category}`;
    if (sentenceLike(t) || titleLike(t) || w >= 8) return "generic_unknown_visible";
    return "";
  }
  if (String(row.file || "").startsWith("Content_")) return row.shouldTranslate ? `generic_${row.category}` : "";
  return "";
}
function backupJsonDir() {
  if (!IN_PLACE) return null;
  if (!fs.existsSync(JSON_DIR)) throw new Error(`Missing json dir: ${JSON_DIR}`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const name of listFiles(JSON_DIR, (n) => n.endsWith(".json"))) {
    fs.copyFileSync(path.join(JSON_DIR, name), path.join(BACKUP_DIR, name));
  }
  return BACKUP_DIR;
}
function buildOldIndex() {
  const index = new Map();
  for (const name of listFiles(JSON_DIR, (n) => n.endsWith(".json") && n !== "_index.json")) {
    const key = logicalKey(name);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(name);
  }
  return index;
}
function translationMaps(oldDoc) {
  const translated = new Map();
  const wanted = new Set();
  for (const row of oldDoc.rows || []) {
    if (row.shouldTranslate) wanted.add(row.original);
    if (row.translation && String(row.translation).trim() && row.translationStatus !== "failed") {
      if (!translated.has(row.original)) translated.set(row.original, row.translation);
    }
  }
  return { translated, wanted };
}
function summarizeRows(rows) {
  const byCategory = {};
  let shouldTranslate = 0, inherited = 0, newlyAdded = 0;
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    if (row.shouldTranslate) shouldTranslate += 1;
    if (row.updateStatus === "inherited_translation") inherited += 1;
    if (row.updateStatus === "new_in_version") newlyAdded += 1;
  }
  return { total: rows.length, shouldTranslate, inherited, newlyAdded, byCategory };
}
function main() {
  if (!fs.existsSync(NEW_APP_ROOT)) throw new Error(`Missing new app root: ${NEW_APP_ROOT}`);
  if (!fs.existsSync(JSON_DIR)) throw new Error(`Missing translated json dir: ${JSON_DIR}`);
  const backup = backupJsonDir();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const oldIndex = buildOldIndex();
  const jsFiles = listFiles(NEW_APP_ROOT, (n) => n.endsWith(".js"));
  const summaries = [];

  for (const jsName of jsFiles) {
    const key = logicalKey(jsName);
    const oldNames = oldIndex.get(key) || [];
    if (!oldNames.length && !INCLUDE_NEW_FILES && !autoIncludeNewFile(jsName, key)) continue;
    const oldName = oldNames[0] || `${jsName}.json`;
    const oldDoc = oldNames.length ? JSON.parse(fs.readFileSync(path.join(JSON_DIR, oldName), "utf8")) : { rows: [] };
    const { translated, wanted } = translationMaps(oldDoc);
    const sourcePath = path.join(NEW_APP_ROOT, jsName);
    const source = fs.readFileSync(sourcePath, "utf8");
    const extracted = extractFromJs(jsName, source);

    const keptByReason = {};
    const rows = extracted.map((row) => {
      const reason = keepReason(row, key, wanted);
      const keep = Boolean(reason);
      row.shouldTranslate = keep;
      if (keep) {
        row.curatedReason = reason;
        keptByReason[reason] = (keptByReason[reason] || 0) + 1;
        const oldTranslation = translated.get(row.original);
        if (oldTranslation) {
          row.translation = oldTranslation;
          row.updateStatus = "inherited_translation";
        } else {
          row.translation = "";
          row.updateStatus = "new_in_version";
        }
      } else {
        row.translation = "";
        row.updateStatus = "disabled_by_update_filter";
      }
      return row;
    });
    const summary = summarizeRows(rows);
    const outName = `${jsName}.json`;
    const outPath = path.join(OUT_DIR, outName);
    const doc = {
      sourceFile: sourcePath,
      sourceSha1: sha1(source),
      migratedFrom: oldNames,
      updateGeneratedAt: new Date().toISOString(),
      updateMode: IN_PLACE ? "in-place" : "preview",
      keptByReason,
      ...summary,
      rows
    };
    writeJson(outPath, doc);
    summaries.push({ key, oldNames, newJson: outName, ...summary, outPath });
    console.log(`${key}: old=${oldNames.join(",") || "<none>"} -> ${outName}; inherited=${summary.inherited}, new=${summary.newlyAdded}, should=${summary.shouldTranslate}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    newAppRoot: NEW_APP_ROOT,
    jsonDir: JSON_DIR,
    outDir: OUT_DIR,
    backupDir: backup,
    inPlace: IN_PLACE,
    files: summaries,
    totals: summaries.reduce((acc, s) => {
      acc.files += 1; acc.inherited += s.inherited; acc.newlyAdded += s.newlyAdded; acc.shouldTranslate += s.shouldTranslate; return acc;
    }, { files: 0, inherited: 0, newlyAdded: 0, shouldTranslate: 0 })
  };
  writeJson(path.join(path.dirname(OUT_DIR), "merge_update_texts_summary.json"), report);
  console.log(`Summary -> ${path.join(path.dirname(OUT_DIR), "merge_update_texts_summary.json")}`);
  if (!IN_PLACE) console.log("Preview only. Add --in-place to replace translator/translated_json after checking the preview output.");
  if (backup) console.log(`Backup -> ${backup}`);
}

main();

