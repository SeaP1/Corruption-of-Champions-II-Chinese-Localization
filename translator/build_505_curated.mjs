import fs from "node:fs";
import path from "node:path";

const sourceDir = path.resolve("translator", "extracted_json");
const fileName = fs.readdirSync(sourceDir).filter((name) => /^505\..*\.js\.json$/i.test(name)).sort((a, b) => a.localeCompare(b))[0];
if (!fileName) throw new Error(`No extracted 505.*.js.json found in ${sourceDir}`);
const appName = fileName.slice(0, -5);
const sourcePath = path.join(sourceDir, fileName);
const sourceJsPath = path.resolve("resources", "app", appName);
const outDir = path.resolve("translator", "extracted_json_curated");
const outPath = path.join(outDir, fileName);

const BAD_WORDS = new Set([
  "use strict", "value", "string", "object", "function", "undefined", "arguments", "length", "prototype", "constructor",
  "serialize", "deserialize", "clone", "hasTags", "setType", "knotRatio", "adjust", "adjustUp", "adjustDown", "adjustSize",
  "map", "set", "object", "array", "promise", "symbol", "iterator"
]);
const SAFE_PROPERTY_KEYS = new Set(["name:", "description:", "short:", "message:", "noDataText:", "loadingText:", "pageJumpText:", "rowsSelectorText:"]);
const SAFE_CALL_KEYS = new Set(["output(", "outputParsed(", "author(", "showNotification(", ".setText(", "addButton(", "addGatedButton("]);
const BAD_CONTEXT_PREFIXES = new Set(["TypeError(", "ReferenceError(", "Error(", ".error(", ".warn(", ".log(", "className:", ".querySelector(", ".bufferAliases(", ".buffer(", ".getPerk(", ".getStatusEffect(", ".hasStatusEffect(", ".descStrength("]);

function hasLetters(s) { return /[A-Za-z]/.test(s); }
function hasCjk(s) { return /[\u4e00-\u9fff]/.test(s); }
function balancedStructure(t) { return (t.match(/\[/g)||[]).length === (t.match(/\]/g)||[]).length; }
function looksCodey(s) {
  const t = s.trim();
  if (!t) return true;
  if (BAD_WORDS.has(t.toLowerCase())) return true;
  if (/\b(function|return|typeof|undefined|null|Promise|Object|Array|RegExp|prototype|constructor|WEBPACK|regeneratorRuntime)\b/.test(t)) return true;
  if (/[{};]/.test(t)) return true;
  if (/^[:.,)+\]\[]/.test(t)) return true;
  if (/\.(concat|map|filter|forEach|then|catch|slice|push|apply|call|bind)\s*\(/.test(t)) return true;
  if (/\.(js|json|png|jpg|webp|svg|css|coc2)$/i.test(t)) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t) && /[A-Z_]/.test(t) && t.length > 6) return true;
  return false;
}
function isHtmlOnlyFragment(t) {
  return /^\s*(?:<\/?[A-Za-z][^>]*>|[.!?,;:])+\s*$/.test(t);
}
function isDeveloperMessage(t) {
  return /\b(?:NOT OVERWRITTEN|not overwritten|TODO|FIXME|debug|undefined|null)\b/.test(t);
}
function isLeadingFragment(t) {
  return /^\s+(?:from|of|and|or|to|with|for|in|on|at|by)\b/i.test(t);
}
function cleanBase(s) {
  const t = String(s || "").trim();
  if (!hasLetters(t) || hasCjk(t)) return false;
  if (isHtmlOnlyFragment(t) || isDeveloperMessage(t) || isLeadingFragment(String(s || ""))) return false;
  if (!balancedStructure(t)) return false;
  if (looksCodey(t)) return false;
  if (t.length < 2) return false;
  return true;
}
function isTitleish(s) {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 8) return false;
  return words.every((w) => /^[A-Z0-9][A-Za-z0-9'.&-]*$/.test(w));
}
function contextKeyBefore(sourceText, row) {
  const pre = sourceText.slice(Math.max(0, row.start - 360), row.start);
  let m = pre.match(/([A-Za-z_$][\w$]*)\s*:\s*$/);
  if (m) return `${m[1]}:`;
  m = pre.match(/\.([A-Za-z_$][\w$]*)\s*\(\s*$/);
  if (m) return `.${m[1]}(`;
  m = pre.match(/([A-Za-z_$][\w$]*)\s*\(\s*$/);
  if (m) return `${m[1]}(`;
  return "unknown";
}
function contextKind(sourceText, row) {
  const pre = sourceText.slice(Math.max(0, row.start - 180), row.start);
  if (/randCollection\s*\(\s*\[[^\]]*$/s.test(pre)) return "randCollection_array";
  if (/\.push\s*\(\s*$/.test(pre)) return "push_arg";
  if (/textify\s*\([^\[]*\[\s*$/s.test(pre)) return "textify_array";
  return "other";
}
function keepLexicon(row, kind) {
  const t = row.original.trim();
  if (!(kind === "randCollection_array" || kind === "push_arg")) return false;
  if (!cleanBase(t)) return false;
  if (!/^[A-Za-z][A-Za-z -]{1,40}$/.test(t)) return false;
  if (/^(up|down|both|true|false|null|none|left|right|skin|ass|asshole|anus|butt|butts|cock|cocks|cunt|cunts|pussy|pussies|vagina|vaginas|clit|clits|clitoris|clitorises|nipple|nipples|breast|breasts|chest|chests|areola|areolae|ball|balls|testicle|testicles|sack|sheath|belly|hip|hips|hair|eye|eyes|face|maw|mouth|arm|arms|leg|legs|tail|tails|tongue|ear|ears|horn|horns|wing|wings|body|armor|weapon|shield|boots|gear|apparel|equipment|item|accessory|ring|rings|necklace|clothing|clothes|underwear|panties)$/i.test(t)) return false;
  return true;
}
function keepVisible(row, key, kind) {
  const t = row.original.trim();
  if (!cleanBase(t)) return false;
  if (BAD_CONTEXT_PREFIXES.has(key)) return false;
  if (SAFE_PROPERTY_KEYS.has(key)) return t.length <= 900;
  if (SAFE_CALL_KEYS.has(key)) return t.length <= 1800;
  if (kind === "textify_array" && row.category !== "unknown") return t.length <= 2400;
  if (row.category === "dialogue") return kind === "textify_array" && t.length <= 5000;
  if (row.category === "button_or_tooltip") return t.length <= 400;
  if (row.category === "property_text") return t.length <= 900;
  if (row.category === "possible_text") {
    if (key !== "unknown" && t.length <= 80 && isTitleish(t)) return true;
    if (key !== "unknown" && /[.!?]$/.test(t) && t.length <= 500) return true;
  }
  return false;
}
function decide(row, key, kind) {
  if (!row.shouldTranslate && !cleanBase(row.original)) return { keep: false, reason: "source_not_translatable" };
  if (keepLexicon(row, kind)) return { keep: true, reason: `505_lexicon_${kind}` };
  if (row.shouldTranslate && keepVisible(row, key, kind)) return { keep: true, reason: `505_visible_${key.replace(/[^A-Za-z0-9]+/g, "_")}_${row.category}` };
  return { keep: false, reason: "disabled_for_505_safety" };
}

const doc = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const sourceText = fs.readFileSync(sourceJsPath, "utf8");
let kept = 0;
let disabled = 0;
const keptByReason = {};
for (const row of doc.rows || []) {
  const key = contextKeyBefore(sourceText, row);
  const kind = contextKind(sourceText, row);
  row.contextKey = key;
  row.contextKind = kind;
  const d = decide(row, key, kind);
  row.shouldTranslate = d.keep;
  row.curatedReason = d.reason;
  if (d.keep) {
    kept++;
    keptByReason[d.reason] = (keptByReason[d.reason] || 0) + 1;
  } else disabled++;
}
doc.curated = {
  generatedAt: new Date().toISOString(),
  source: sourcePath,
  sourceJs: sourceJsPath,
  policy: "Conservative visible text and descriptor lexicon from 505 chunk. Keeps dialogue/UI plus randCollection/.push descriptor words; disables runtime errors, internal identifiers and code fragments.",
  kept,
  disabled,
  keptByReason
};
doc.shouldTranslate = kept;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outPath, kept, disabled, keptByReason }, null, 2));






