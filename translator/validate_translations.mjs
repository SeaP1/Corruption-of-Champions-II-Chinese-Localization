import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve("D:/Codex/COC2 Fixed/translator/translated_json");

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}
function htmlTags(text) {
  return [...text.matchAll(/<\/?[A-Za-z][^>]*>/g)].map((m) => m[0]);
}
function bracketHeads(text) {
  const heads = [];
  const re = /\[\s*([A-Za-z_][A-Za-z0-9_.]*)/g;
  let m;
  while ((m = re.exec(text))) heads.push(m[1]);
  return heads;
}
function multiset(values) {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) || 0) + 1);
  return map;
}
function sameMultiset(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function structuralIssues(original, translated) {
  const checks = [
    ["[", countMatches(original, /\[/g), countMatches(translated, /\[/g)],
    ["]", countMatches(original, /\]/g), countMatches(translated, /\]/g)],
    ["|", countMatches(original, /\|/g), countMatches(translated, /\|/g)]
  ];
  const issues = checks.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n}: original=${a}, translated=${b}`);

  const ot = htmlTags(original).join(" ");
  const tt = htmlTags(translated).join(" ");
  if (ot !== tt) issues.push(`html: original=${ot}; translated=${tt}`);

  const oh = multiset(bracketHeads(original));
  const th = multiset(bracketHeads(translated));
  if (!sameMultiset(oh, th)) {
    issues.push(`bracket heads changed: original=${[...oh.entries()].map(([k,v])=>`${k}x${v}`).join(',')}; translated=${[...th.entries()].map(([k,v])=>`${k}x${v}`).join(',')}`);
  }
  return issues;
}

let cleared = 0;
let markedFailed = 0;
let alreadyFailed = 0;
let checked = 0;
const details = [];

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "_index.json")) {
  const filePath = path.join(DIR, file);
  const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let changed = false;

  for (const row of doc.rows || []) {
    if (!row.translation || !row.translation.trim()) continue;
    checked += 1;
    const issues = structuralIssues(row.original || "", row.translation || "");

    if (issues.length === 0) {
      if (row.translationError) {
        delete row.translationError;
        cleared += 1;
        changed = true;
      }
      if (row.translationStatus === "failed") {
        row.translationStatus = "ollama_translated_validated";
        changed = true;
      }
      continue;
    }

    if (row.translationStatus === "failed") {
      alreadyFailed += 1;
      continue;
    }

    row.rejectedTranslation = row.translation;
    row.translation = "";
    row.translationStatus = "failed";
    row.translationError = `post validation failed: ${issues.join("; ")}`;
    markedFailed += 1;
    changed = true;
    details.push({ file, id: row.id, error: row.translationError });
  }

  if (changed) fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

const summary = { generatedAt: new Date().toISOString(), checked, clearedStaleErrors: cleared, markedFailed, alreadyFailed, details: details.slice(0, 200) };
fs.writeFileSync(path.resolve("D:/Codex/COC2 Fixed/translator/validate_translations_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
