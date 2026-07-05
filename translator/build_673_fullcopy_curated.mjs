import fs from "node:fs";
import path from "node:path";

const sourceDir = path.resolve("translator", "extracted_json");
const sourceName = fs.readdirSync(sourceDir).filter((name) => /^673\..*\.js\.json$/i.test(name)).sort((a, b) => a.localeCompare(b))[0];
if (!sourceName) throw new Error(`No extracted 673.*.js.json found in ${sourceDir}`);
const sourcePath = path.join(sourceDir, sourceName);
const outDir = path.resolve("translator", "extracted_json_curated");
const outPath = path.join(outDir, sourceName);

function hasLetters(s) { return /[A-Za-z]/.test(String(s || "")); }
function hasCjk(s) { return /[\u4e00-\u9fff]/.test(String(s || "")); }
function words(s) { return (String(s || "").match(/[A-Za-z]+(?:['?\-][A-Za-z]+)?|\d+(?:\.\d+)?/g) || []).length; }
function balanced(s) { return (String(s).match(/\[/g)||[]).length === (String(s).match(/\]/g)||[]).length; }
function sentenceLike(s) { return /[.!????](["')\]]|$)/.test(String(s).trim()) || /\n\s*\n/.test(String(s)); }
function pipeTextFragment(s) {
  const t = String(s || "").trim();
  return t.startsWith("|") && words(t) >= 8 && /[A-Za-z]/.test(t) && /[.!?]/.test(t) && !/[{};]/.test(t);
}
function lowerNaturalPhrase(row, t) {
  const w = words(t);
  return row.category === "possible_text" && /^[a-z]/.test(t) && w >= 6 && w < 10 && !/[{};()[\]=>]/.test(t) && /\s/.test(t);
}
function titleLike(s) {
  const parts = String(s).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 10) return false;
  const small = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);
  return parts.every((w, i) => /^[A-Z0-9][A-Za-z0-9'.&:\-]*$/.test(w) || (i > 0 && small.has(w)));
}
function rejectReason(row) {
  const raw = String(row.original || "");
  const t = raw.trim();
  if (!row.shouldTranslate) return "source_not_translatable";
  if (!t || !hasLetters(t) || hasCjk(t)) return "reject_base";
  if (!balanced(t) && !pipeTextFragment(t)) return "reject_unbalanced";

  // Runtime/Babel/Webpack error templates and debug strings.
  if (/^(Derived constructors may only|this hasn't been initialised|Super expression must|Cannot call a class|Invalid attempt to|In order to be iterable)/i.test(t)) return "reject_runtime_error";
  if (/^\.[A-Za-z_$][\w$]*\s+not overwritten/i.test(t)) return "reject_internal_not_overwritten";
  if (/^\([^)]+\)$/.test(t)) return "reject_css_or_parenthesized";

  // Obvious code fragments/minified JS shards.
  if (/[{}]/.test(t)) return "reject_code_punctuation";
  if (/=>|\b(typeof|undefined|null|Promise|Object|Array|RegExp|prototype|constructor|WEBPACK|regeneratorRuntime|Symbol\.iterator)\b/.test(t)) return "reject_code_words";
  if (/\b(function|return)\b/.test(t) && (/[{}]/.test(t) || /=>|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bvar\s+|\blet\s+|\bconst\s+/.test(t))) return "reject_code_words";
  if (/\.(concat|map|filter|forEach|then|catch|slice|push|apply|call|bind)\s*\(/.test(t)) return "reject_code_call";
  if (/^[,.:;)+\]}]/.test(t) || /[,;:({\[]$/.test(t)) return "reject_fragment_edge";
  if (/\.(js|json|png|jpg|jpeg|webp|svg|css|coc2)$/i.test(t)) return "reject_asset_path";

  // Very short lower-case fragments are usually pieces of expressions, not UI text.
  if (t.length < 3) return "reject_too_short";
  if (/^(s|t|ve|re|ll|d|m)\b/i.test(t)) return "reject_leading_contraction_fragment";
  if (/\)\)\)|\]\)\)|"\]\)/.test(t)) return "reject_code_tail_fragment";
  if (/^[a-z]/.test(t) && !sentenceLike(t) && words(t) < 10 && !lowerNaturalPhrase(row, t)) return "reject_lower_fragment";

  return "";
}
function keepReason(row) {
  const bad = rejectReason(row);
  if (bad) return { keep: false, reason: bad };
  const t = String(row.original || "").trim();
  const w = words(t);

  // Keep old useful categories plus long prose. This catches quests/codex/race descriptions.
  if (row.category === "dialogue") return { keep: true, reason: "wide_dialogue" };
  if (row.category === "property_text") return { keep: true, reason: "wide_property_text" };
  if (row.category === "button_or_tooltip" && (titleLike(t) || sentenceLike(t))) return { keep: true, reason: "wide_button_or_tooltip" };
  if (row.category === "possible_text" && (sentenceLike(t) || w >= 10 || titleLike(t) || lowerNaturalPhrase(row, t) || pipeTextFragment(t))) return { keep: true, reason: pipeTextFragment(t) ? "wide_pipe_text_fragment" : (lowerNaturalPhrase(row, t) ? "wide_lower_natural_phrase" : "wide_possible_text") };
  if (row.category === "unknown" && w >= 35 && sentenceLike(t) && !/^[a-z]/.test(t)) return { keep: true, reason: "wide_unknown_long_prose" };
  if (row.category === "unknown") return { keep: false, reason: "reject_unknown_safety" };

  return { keep: false, reason: "reject_not_visible_enough" };
}

const doc = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
let kept = 0;
let disabled = 0;
const keptByReason = {};
const disabledByReason = {};
const keptByCategory = {};

for (const row of doc.rows || []) {
  const decision = keepReason(row);
  row.shouldTranslate = decision.keep;
  row.curatedReason = decision.reason;
  if (decision.keep) {
    kept++;
    keptByReason[decision.reason] = (keptByReason[decision.reason] || 0) + 1;
    keptByCategory[row.category || "unknown"] = (keptByCategory[row.category || "unknown"] || 0) + 1;
  } else {
    disabled++;
    disabledByReason[decision.reason] = (disabledByReason[decision.reason] || 0) + 1;
  }
}

doc.curated = {
  generatedAt: new Date().toISOString(),
  source: sourcePath,
  policy: "Wide 673 builder based on extractor shouldTranslate, but rejects runtime errors, debug/internal strings, CSS/media queries, asset paths, and obvious minified code fragments. Keeps dialogue/prose for quests, codex, race and item descriptions.",
  kept,
  disabled,
  keptByReason,
  keptByCategory,
  disabledByReason
};
doc.shouldTranslate = kept;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ outPath, kept, disabled, keptByReason, keptByCategory, disabledByReason }, null, 2));
