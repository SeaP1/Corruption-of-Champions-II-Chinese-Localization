import fs from "node:fs";
import {stamp, target} from "./migration_common.mjs";
import path from "node:path";
import { extractRowsFromJs, sha1, shortHash, baseShouldTranslate } from "./js_text_tools.mjs";

const ROOT = path.resolve("resources", "app");
const OUT_DIR = path.resolve("translator", "extracted_json");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT,"package.json"),"utf8")).version;
const argv = process.argv.slice(2);
const mode = argv.includes("--all") || argv.includes("-all") ? "all" : "sample";
const sampleArg = argv.find((arg) => arg.startsWith("--sample="));
const SAMPLE_FILES = sampleArg ? [sampleArg.slice("--sample=".length)] : [];

function listInputFiles() {
  const names = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.js$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (mode === "all") return names.filter(target).map((name) => path.join(ROOT, name));
  const selected = SAMPLE_FILES.length ? SAMPLE_FILES : names.filter((name) => name.startsWith("Content_Forest.")).slice(0, 1);
  return selected.map((name) => path.join(ROOT, name));
}

function jsonPointerEscape(value) { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function walkJson(value, visitor, pointer = "") {
  if (typeof value === "string") return visitor(value, pointer);
  if (Array.isArray(value)) return value.forEach((item, index) => walkJson(item, visitor, `${pointer}/${index}`));
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walkJson(item, visitor, `${pointer}/${jsonPointerEscape(key)}`);
}
function extractFromJson(filePath, source) {
  const basename = path.basename(filePath), rows = [];
  walkJson(JSON.parse(source), (value, pointer) => rows.push({
    id: `${basename}:${pointer}:${shortHash(value)}`,
    stableId: `${basename}:json:${pointer}:${shortHash(value)}`,
    file: basename,
    category: "json_value",
    shouldTranslate: baseShouldTranslate(value, "json_value"),
    original: value,
    translation: "",
    jsonPointer: pointer
  }));
  return rows;
}
function summarize(rows) {
  const byCategory = {};
  let shouldTranslate = 0;
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    if (row.shouldTranslate) shouldTranslate += 1;
  }
  return { total: rows.length, shouldTranslate, byCategory };
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  if (!fs.existsSync(ROOT)) throw new Error(`找不到游戏目录：${ROOT}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = { schemaVersion: 2, sourceFormat: "prettier-multiline", mode, sourceRoot: ROOT, outputRoot: OUT_DIR, generatedAt: new Date().toISOString(), files: [] };
  for (const filePath of listInputFiles()) {
    if (!fs.existsSync(filePath)) { console.warn(`Missing sample file: ${filePath}`); continue; }
    const source = fs.readFileSync(filePath, "utf8"), basename = path.basename(filePath), ext = path.extname(filePath).toLowerCase();
    const rows = ext === ".json" ? extractFromJson(filePath, source) : extractRowsFromJs(basename, source);
    rows.forEach((r,i)=>Object.assign(r,stamp(r,VERSION,basename.split(".")[0],i)));
    const summary = summarize(rows), outputPath = path.join(OUT_DIR, `${basename}.json`);
    writeJson(outputPath, { schemaVersion: 2, sourceFormat: "prettier-multiline", sourceFile: filePath, sourceSha1: sha1(source), version: VERSION, rowOrder: "source_position", ...summary, rows });
    index.files.push({ sourceFile: filePath, outputFile: outputPath, ...summary });
    console.log(`${basename}: ${summary.shouldTranslate}/${summary.total} marked translatable -> ${outputPath}`);
  }
  writeJson(path.join(OUT_DIR, "_index.json"), index);
  console.log(`Index -> ${path.join(OUT_DIR, "_index.json")}`);
}

main();
