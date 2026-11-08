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
const SAFE_CALL_KEYS = new Set(["output(", "outputParsed(", "author(", "showNotification(", ".setText(", "addButton(", "addGatedButton(", ".bufferAliases("]);
const BAD_CONTEXT_PREFIXES = new Set(["TypeError(", "ReferenceError(", "Error(", ".error(", ".warn(", ".log(", "className:", ".querySelector(", ".buffer(", ".getPerk(", ".getStatusEffect(", ".hasStatusEffect(", ".descStrength("]);

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
function isInternalClassKey(sourceText, row) {
  const pre = sourceText.slice(Math.max(0, row.start - 24), row.start);
  return /(?:\{|,)\s*key\s*:\s*$/.test(pre);
}
function insideFirstBufferAliasesArgument(sourceText, row) {
  const needle = "CombatManager.bufferAliases";
  const callAt = sourceText.lastIndexOf(needle, row.start);
  if (callAt < 0 || row.start - callAt > 6000) return false;
  const open = sourceText.indexOf("(", callAt + needle.length);
  if (open < 0 || open >= row.start) return false;
  let paren = 1, square = 0, brace = 0, topLevelCommas = 0;
  let quote = "", escaped = false, lineComment = false, blockComment = false;
  for (let i = open + 1; i < row.start; i++) {
    const ch = sourceText[i], next = sourceText[i + 1];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") paren++;
    else if (ch === ")") { paren--; if (paren <= 0) return false; }
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === "," && paren === 1 && square === 0 && brace === 0) topLevelCommas++;
  }
  return paren > 0 && topLevelCommas === 0;
}
function trustedBufferAliasesText(row, sourceText) {
  const t = String(row.original || "").trim();
  if (!insideFirstBufferAliasesArgument(sourceText, row)) return false;
  if (!t || !hasLetters(t) || hasCjk(t) || isDeveloperMessage(t)) return false;
  if (isHtmlOnlyFragment(t) || /^(?:s|es|ies|y)$/i.test(t)) return false;
  if (/\b(?:function|return|undefined|null|prototype|constructor)\b/.test(t)) return false;
  return true;
}
function keepLexicon(row, kind) {
  const t = row.original.trim();
  if (!(kind === "randCollection_array" || kind === "push_arg")) return false;
  if (!cleanBase(t)) return false;
  if (!/^[A-Za-z][A-Za-z -]{1,40}$/.test(t)) return false;
  if (/^(up|down|both|true|false|null|none|left|right|skin|ass|asshole|anus|butt|butts|cock|cocks|cunt|cunts|pussy|pussies|vagina|vaginas|clit|clits|clitoris|clitorises|nipple|nipples|breast|breasts|chest|chests|areola|areolae|ball|balls|testicle|testicles|sack|sheath|belly|hip|hips|hair|eye|eyes|face|maw|mouth|arm|arms|leg|legs|tail|tails|tongue|ear|ears|horn|horns|wing|wings|body|armor|weapon|shield|boots|gear|apparel|equipment|item|accessory|ring|rings|necklace|clothing|clothes|underwear|panties)$/i.test(t)) return false;
  return true;
}
function looksHardUnsafeSourceWanted(row) {
  const t = String(row.original || "").trim();
  if (/^(?:<b>)?\s*(?:ERROR|Error|Parse Error)\b/i.test(t) || /\b(?:INVALID ARG|NONVALID FLUID|NO WANGS DETECTED|CockDescript|CockShape2|CockHead|breastDescript|wombdescript|multiCockDescript|simpleCockNoun|CLITDESCRIPT)\b/i.test(t)) return true;
  if (!t || !hasLetters(t) || hasCjk(t)) return true;
  if (!balancedStructure(t)) return true;
  if (isHtmlOnlyFragment(t) || isDeveloperMessage(t)) return true;
  if (/^(?:function|undefined|null|arguments|prototype|constructor|value|string|object|array|promise|symbol|iterator)$/i.test(t)) return true;
  if (/^rgba\(/i.test(t) || /^\.[A-Za-z0-9_-]+$/.test(t)) return true;
  if (/\.(svg|png|jpg|jpeg|webp|gif|mp3|ogg|wav|js|css|json|woff2?|ttf|otf)(\b|$|[?#])/i.test(t)) return true;
  if (/^damage\.(attackType|damage)$/.test(t)) return true;
  if (/^[{};,.()+\][]{1,8}$/.test(t)) return true;
  if (/\.test\(|\.includes\(|\.toLowerCase\(|readMainTextInput\(|NameKiddo\(|processTime\(|addButton\(|addGatedButton\(|return\s+[^\n]*textify|\}\);|=>/.test(t)) return true;
  if (/\b(function|return|typeof|undefined|null|Promise|Object|Array|RegExp|prototype|constructor|WEBPACK|regeneratorRuntime)\b/.test(t)) return true;
  if (/\.(concat|map|filter|forEach|then|catch|slice|apply|call|bind)\s*\(/.test(t)) return true;
  return false;
}
function keepSourceWanted(row) {
  if (!row.shouldTranslate) return false;
  if (looksHardUnsafeSourceWanted(row)) return false;
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
function decide(row, key, kind, internalClassKey, trustedAliasText) {
  if (internalClassKey) return { keep: false, reason: "disabled_internal_class_key" };
  if (trustedAliasText) return { keep: true, reason: "505_visible_buffer_alias_text" };
  if (BAD_CONTEXT_PREFIXES.has(key)) return { keep: false, reason: "disabled_internal_lookup_key" };
  if (!row.shouldTranslate && !cleanBase(row.original)) return { keep: false, reason: "source_not_translatable" };
  if (keepSourceWanted(row)) return { keep: true, reason: "505_source_should_translate_safe" };
  if (keepLexicon(row, kind)) return { keep: true, reason: `505_lexicon_${kind}` };
  if (row.shouldTranslate && keepVisible(row, key, kind)) return { keep: true, reason: `505_visible_${key.replace(/[^A-Za-z0-9]+/g, "_")}_${row.category}` };
  return { keep: false, reason: "disabled_for_505_safety" };
}

function corruptionLiteralRole(sourceText, row) {
  const value = String(row.original || "");
  if (!/^(?:demonic|corrupted|tainted|pure)$/.test(value)) return null;
  const before = sourceText.slice(Math.max(0, row.start - 12000), row.start);
  const lastMatchOffset = (regex) => {
    let found = -1, match;
    regex.lastIndex = 0;
    while ((match = regex.exec(before))) found = match.index;
    return found < 0 ? -1 : row.start - before.length + found;
  };
  const coinStart = lastMatchOffset(/key\s*:\s*["']corruptionCoin["']/g);
  const titleStart = lastMatchOffset(/key\s*:\s*["']corruptionTitle["']/g);
  const tail = sourceText.slice(row.start, Math.min(sourceText.length, row.start + 12000));
  const boundary = /}\s*,\s*{\s*key\s*:\s*["']/.exec(tail);
  const nextMethod = boundary ? row.start + boundary.index : -1;
  if (coinStart > titleStart && (nextMethod < 0 || row.start < nextMethod)) return "coin";
  if (titleStart > coinStart && (nextMethod < 0 || row.start < nextMethod)) return "title";
  return null;
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
  const corruptionRole = corruptionLiteralRole(sourceText, row);
  const d = corruptionRole === "coin"
    ? { keep: false, reason: "disabled_internal_corruption_coin_key" }
    : corruptionRole === "title"
      ? { keep: true, reason: "505_visible_corruption_title" }
      : decide(row, key, kind, isInternalClassKey(sourceText, row), trustedBufferAliasesText(row, sourceText));
  row.shouldTranslate = d.keep;
  row.curatedReason = d.reason;
  if (d.keep) {
    kept++;
    keptByReason[d.reason] = (keptByReason[d.reason] || 0) + 1;
  } else disabled++;
}
doc.curated = {
  sourceFormat: "prettier-multiline",
  locatorPolicy: "content/category/context; whitespace-tolerant method detection",
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






