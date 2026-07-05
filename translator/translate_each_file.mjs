import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const extractedDir = path.resolve("translator", "extracted_json");
const curatedDir = path.resolve("translator", "extracted_json_curated");
const translatorScript = path.resolve("translator", "ollama_translate_v2.mjs");
const build103Script = path.resolve("translator", "build_103_curated.mjs");
const build673Script = path.resolve("translator", "build_673_fullcopy_curated.mjs");
const build673LegacyScript = path.resolve("translator", "build_673_curated.mjs");
const build505Script = path.resolve("translator", "build_505_curated.mjs");

const args = process.argv.slice(2);
const perFileLimit = Number.parseInt(args.find((arg) => /^\d+$/.test(arg)) || "20", 10);
const includeAll = args.includes("--all");
const withCore = args.includes("--with-core");
const coreOnly = args.includes("--core-only");

function listJsonFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "_index.json")
    .filter(predicate)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(dir, name));
}

function contentFiles() {
  return listJsonFiles(extractedDir, (name) => includeAll || name.startsWith("Content_"));
}

function firstMatchingJson(dir, prefix) {
  return listJsonFiles(dir, (name) => name.startsWith(`${prefix}.`))[0] || null;
}

function runBuilder(script) {
  if (!script || !fs.existsSync(script)) return false;
  const result = spawnSync(process.execPath, [script], { stdio: "inherit", cwd: process.cwd(), shell: false });
  if (result.status !== 0) {
    console.error(`Builder failed: ${path.basename(script)}, exit=${result.status}`);
    return false;
  }
  return true;
}

function curatedCoreFiles() {
  const builders = [
    { script: build103Script, prefix: "103" },
    { script: fs.existsSync(build673Script) ? build673Script : build673LegacyScript, prefix: "673" },
    { script: build505Script, prefix: "505" }
  ];
  const files = [];
  for (const item of builders) {
    runBuilder(item.script);
    const file = firstMatchingJson(curatedDir, item.prefix);
    if (file) files.push(file);
    else console.warn(`No curated JSON found for ${item.prefix}.* in ${curatedDir}`);
  }
  return files;
}

let files = [];
if (!coreOnly) files.push(...contentFiles());
if (withCore || coreOnly) files.push(...curatedCoreFiles());

files = [...new Map(files.map((file) => [path.resolve(file), file])).values()];

if (!files.length) {
  console.error("No input JSON files found. Expected translator/extracted_json for Content files and translator/extracted_json_curated for 103/505/673.");
  process.exit(1);
}

for (const input of files) {
  const name = path.basename(input);
  console.log(`\n=== ${name}: translating up to ${perFileLimit} entries ===`);
  const result = spawnSync(process.execPath, [translatorScript, "--input", input, "--limit", String(perFileLimit)], {
    stdio: "inherit",
    cwd: process.cwd(),
    shell: false
  });
  if (result.status !== 0) console.error(`Failed on ${name}, exit=${result.status}`);
}
