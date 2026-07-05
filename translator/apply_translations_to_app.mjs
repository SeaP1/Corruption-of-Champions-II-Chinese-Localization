import fs from "node:fs";
import path from "node:path";

const TRANSLATED_JSON_DIR = path.resolve("translator", "translated_json");
const TRANSLATED_APP_DIR = path.resolve("translator", "translated_app");
const ORIGINAL_APP_DIR = path.resolve("resources", "app");
const includeAll = process.argv.includes("--all");

function jsStringLiteral(value) {
  return JSON.stringify(value);
}

function isWordChar(value) {
  return /[A-Za-z0-9_]/.test(value || "");
}

function isPromptLeakTranslation(row) {
  const text = row && typeof row.translation === "string" ? row.translation : "";
  return text.includes("```") || text.includes("javascript") || text.includes("\u786c\u6027\u8981\u6c42") || text.includes("\u4ec5\u8f93\u51fa\u7b80\u4f53\u4e2d\u6587\u8bd1\u6587");
}

function isLikelyCodeSlice(row) {
  if (!row || row.category !== "unknown") return false;
  const text = row.original || "";
  return /\.test\(|\.includes\(|\.toLowerCase\(|function\s*\(|processTime\(|addButton\(|NameKiddo\(|return["A-Za-z_$]|var\s+[A-Za-z_$]|const\s+[A-Za-z_$]|let\s+[A-Za-z_$]|\}\);|=>/.test(text);
}
function isSafeReplacementRow(row, source) {
  if (!row || typeof row.raw !== "string" || typeof row.start !== "number" || typeof row.end !== "number") return false;
  if (isPromptLeakTranslation(row) || isLikelyCodeSlice(row)) return false;
  const raw = row.raw;
  if (raw.length < 2) return false;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || raw[raw.length - 1] !== quote) return false;

  if (source[row.start - 1] === "\\") return false;
  if (quote === "'" && (isWordChar(source[row.start - 1]) || isWordChar(source[row.end]))) return false;

  try {
    const value = Function(`return (${raw});`)();
    return typeof value === "string" && value === (row.original || "");
  } catch {
    return false;
  }
}

function patchRuntimeHelpers(source, appName) {
  if (!appName.startsWith("673.")) return source;
  const original = 'window.plural=function(e){var t=e.slice(-1),n=e.slice(-2,-1);return"s"===t||"s"===n&&"h"===t||"c"===n&&"h"===t?e+="es":"z"!==n&&"z"===t?e+="zes":"x"===t||"z"===t?e+="es":"y"===t&&"e"!==n&&"a"!==n&&"u"!==n&&"o"!==n&&"i"!==n?e=e.slice(0,-1)+"ies":e+="s",e}';
  const patched = 'window.plural=function(e){if(/[\\u4e00-\\u9fff]/.test(e))return e;var t=e.slice(-1),n=e.slice(-2,-1);return"s"===t||"s"===n&&"h"===t||"c"===n&&"h"===t?e+="es":"z"!==n&&"z"===t?e+="zes":"x"===t||"z"===t?e+="es":"y"===t&&"e"!==n&&"a"!==n&&"u"!==n&&"o"!==n&&"i"!==n?e=e.slice(0,-1)+"ies":e+="s",e}';
  if (!source.includes(original) && !source.includes(patched)) {
    console.warn(`${appName}: plural helper pattern not found; Chinese plural patch was not applied.`);
    return source;
  }
  return source.replace(original, patched);
}
function appFileNameFromJsonName(jsonName) {
  return jsonName.endsWith(".json") ? jsonName.slice(0, -5) : jsonName;
}

function collectJsonFiles() {
  if (!fs.existsSync(TRANSLATED_JSON_DIR)) return [];
  return fs.readdirSync(TRANSLATED_JSON_DIR)
    .filter((name) => name.endsWith(".json") && name !== "_index.json")
    .filter((name) => includeAll || name.startsWith("Content_") || name.startsWith("103.") || name.startsWith("505.") || name.startsWith("673."))
    .sort((a, b) => a.localeCompare(b));
}

function applyOne(jsonName) {
  const jsonPath = path.join(TRANSLATED_JSON_DIR, jsonName);
  const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const appName = appFileNameFromJsonName(jsonName);
  const originalPath = path.join(ORIGINAL_APP_DIR, appName);
  const outputPath = path.join(TRANSLATED_APP_DIR, appName);

  if (!fs.existsSync(originalPath)) return { jsonName, applied: 0, skipped: 0, reason: "missing source app file" };

  let source = fs.readFileSync(originalPath, "utf8");
  const rows = (doc.rows || [])
    .filter((row) => row.translation && row.translation.trim() && row.translationStatus !== "failed")
    .filter((row) => typeof row.start === "number" && typeof row.end === "number")
    .filter((row) => isSafeReplacementRow(row, source))
    .sort((a, b) => b.start - a.start);

  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    const currentRaw = source.slice(row.start, row.end);
    if (row.raw && currentRaw !== row.raw) {
      skipped += 1;
      continue;
    }
    source = source.slice(0, row.start) + jsStringLiteral(row.translation) + source.slice(row.end);
    applied += 1;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  source = patchRuntimeHelpers(source, appName);
  fs.writeFileSync(outputPath, source, "utf8");
  return { jsonName, outputPath, applied, skipped };
}

function main() {
  const summaries = collectJsonFiles().map(applyOne);
  let totalApplied = 0;
  let totalSkipped = 0;
  for (const item of summaries) {
    totalApplied += item.applied || 0;
    totalSkipped += item.skipped || 0;
    console.log(`${item.jsonName}: applied=${item.applied || 0}, skipped=${item.skipped || 0}${item.reason ? `, ${item.reason}` : ""}`);
  }
  const summary = { generatedAt: new Date().toISOString(), totalApplied, totalSkipped, files: summaries };
  fs.writeFileSync(path.resolve("translator", "apply_translations_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nTotal applied=${totalApplied}, skipped=${totalSkipped}`);
}

main();







