import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve("resources", "app");
const OUT_DIR = path.resolve("translator", "extracted_json");

const args = new Set(process.argv.slice(2));
const mode = args.has("--all") ? "all" : "sample";

const SAMPLE_FILES = ["Content_Forest.dc28793bf13e3dfdc5b8.js"];
const ALL_FILE_PATTERNS = [/\.js$/i];

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function shortHash(text) {
  return sha1(text).slice(0, 12);
}

function listInputFiles() {
  if (mode === "sample") {
    return SAMPLE_FILES.map((name) => path.join(ROOT, name));
  }

  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => ALL_FILE_PATTERNS.some((pattern) => pattern.test(name)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(ROOT, name));
}

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function decodeJsString(raw) {
  try {
    return Function(`"use strict"; return (${raw});`)();
  } catch {
    return null;
  }
}

function scanStringLiterals(source) {
  const tokens = [];
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch !== '"' && ch !== "'") {
      i += 1;
      continue;
    }

    const quote = ch;
    const start = i;
    i += 1;
    let escaped = false;

    while (i < source.length) {
      const current = source[i];

      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }

      if (current === "\\") {
        escaped = true;
        i += 1;
        continue;
      }

      if (current === quote) {
        i += 1;
        const end = i;
        const raw = source.slice(start, end);
        const value = decodeJsString(raw);
        if (typeof value === "string") {
          tokens.push({ start, end, raw, value });
        }
        break;
      }

      i += 1;
    }
  }

  return tokens;
}

function jsonPointerEscape(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function walkJson(value, visitor, pointer = "") {
  if (typeof value === "string") {
    visitor(value, pointer);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, visitor, `${pointer}/${index}`));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      walkJson(item, visitor, `${pointer}/${jsonPointerEscape(key)}`);
    }
  }
}

function looksLikeJsCodeShard(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const hasStrongCode = /\.test\s*\(|function\s*\(|function\s*\{|=>|\breturn\b|\bwindow\.[A-Za-z_$][\w$]*\s*=\s*function\b|&&|\|\|/.test(t);
  const hasCodeShape = /[{}]|\)\{|\}\)|\.toLowerCase\s*\(|\.includes\s*\(|\bvar\s+[A-Za-z_$][\w$]*/.test(t);
  return hasStrongCode && hasCodeShape;
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

  if (/\boutput\s*\([^)]*$/s.test(before) || /\btextify\s*\([^)]*$/s.test(before)) {
    return "dialogue";
  }

  if (/\b(addButton|addDisabledButton|addGatedButton|addGatedButtonObj|addTooltip)\s*\([^)]*$/s.test(before)) {
    return "button_or_tooltip";
  }

  if (/\b(showName)\s*\([^)]*$/s.test(before)) {
    return "speaker";
  }

  if (/[.$\w\]]\s*\.\s*(name|short|longName|description|tooltip|title|text|label|message)\s*[:=]\s*$/s.test(before)) {
    return "property_text";
  }

  if (/"(?:name|short|longName|description|tooltip|title|text|label|message)"\s*:\s*$/s.test(before)) {
    return "property_text";
  }

  if (/^\s*[,)\]}]/.test(after) && /[.!?,;:]|<[^>]+>|\[[^\]]+\]|\s/.test(value)) {
    return "possible_text";
  }

  return "unknown";
}

function shouldTranslate(value, category) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (looksLikeAssetOrCode(trimmed)) return false;
  if (category === "unknown" && looksLikeJsCodeShard(trimmed)) return false;

  if (category !== "unknown") return true;
  return trimmed.length >= 18 && /[.!?,;:]|\s/.test(trimmed);
}

function extractFromJs(filePath, source) {
  const starts = lineStarts(source);
  const basename = path.basename(filePath);
  const tokens = scanStringLiterals(source);

  return tokens.map((token) => {
    const category = classifyJsString(source, token);
    const translatable = shouldTranslate(token.value, category);
    return {
      id: `${basename}:${token.start}:${token.end}:${shortHash(token.value)}`,
      file: basename,
      category,
      shouldTranslate: translatable,
      original: token.value,
      translation: "",
      start: token.start,
      end: token.end,
      line: lineOf(starts, token.start),
      raw: token.raw
    };
  });
}

function extractFromJson(filePath, source) {
  const basename = path.basename(filePath);
  const rows = [];
  const parsed = JSON.parse(source);

  walkJson(parsed, (value, pointer) => {
    const category = "json_value";
    rows.push({
      id: `${basename}:${pointer}:${shortHash(value)}`,
      file: basename,
      category,
      shouldTranslate: shouldTranslate(value, category),
      original: value,
      translation: "",
      jsonPointer: pointer
    });
  });

  return rows;
}

function summarize(rows) {
  const byCategory = {};
  let shouldTranslateCount = 0;

  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    if (row.shouldTranslate) shouldTranslateCount += 1;
  }

  return {
    total: rows.length,
    shouldTranslate: shouldTranslateCount,
    byCategory
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  if (!fs.existsSync(ROOT)) {
    throw new Error(`鎵句笉鍒版父鎴忕洰褰曪細${ROOT}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const inputFiles = listInputFiles();
  const index = {
    mode,
    sourceRoot: ROOT,
    outputRoot: OUT_DIR,
    generatedAt: new Date().toISOString(),
    files: []
  };

  for (const filePath of inputFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    const basename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const rows = ext === ".json" ? extractFromJson(filePath, source) : extractFromJs(filePath, source);
    const summary = summarize(rows);
    const outputName = `${basename}.json`;
    const outputPath = path.join(OUT_DIR, outputName);

    writeJson(outputPath, {
      sourceFile: filePath,
      sourceSha1: sha1(source),
      ...summary,
      rows
    });

    index.files.push({
      sourceFile: filePath,
      outputFile: outputPath,
      ...summary
    });

    console.log(`${basename}: ${summary.shouldTranslate}/${summary.total} marked translatable -> ${outputPath}`);
  }

  writeJson(path.join(OUT_DIR, "_index.json"), index);
  console.log(`Index -> ${path.join(OUT_DIR, "_index.json")}`);
}

main();

