import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "huihui_ai/hy-mt1.5-abliterated:latest";
const DEFAULT_HOST = "http://127.0.0.1:11434";
const OUT_DIR = path.resolve("translator", "translated_json");
const translationMemory = new Map();
const translationMemoryConflicts = new Set();

function rowsOf(doc) { return Array.isArray(doc?.rows) ? doc.rows : []; }
function usableTranslation(row) {
  return row && row.shouldTranslate !== false && typeof row.original === "string" && row.original.trim() && typeof row.translation === "string" && row.translation.trim() && row.translationStatus !== "failed" && !row.translationError;
}
function rememberTranslation(row, sourceFile = "") {
  if (!usableTranslation(row)) return;
  const key = row.original;
  const value = row.translation.trim();
  if (translationMemoryConflicts.has(key)) return;
  const existing = translationMemory.get(key);
  if (!existing) {
    translationMemory.set(key, { translation: value, sourceId: row.id || "", sourceFile });
    return;
  }
  if (existing.translation !== value) {
    translationMemory.delete(key);
    translationMemoryConflicts.add(key);
  }
}
function buildTranslationMemory() {
  if (!fs.existsSync(OUT_DIR)) return;
  for (const name of fs.readdirSync(OUT_DIR).filter(x => x.endsWith(".json"))) {
    const file = path.join(OUT_DIR, name);
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const row of rowsOf(doc)) rememberTranslation(row, name);
    } catch {
      // Ignore damaged/nonstandard files; validation can report them separately.
    }
  }
}
function reuseTranslationFromMemory(row) {
  if (!row || row.shouldTranslate === false || !row.original || translationMemoryConflicts.has(row.original)) return false;
  const hit = translationMemory.get(row.original);
  if (!hit || !hit.translation) return false;
  row.translation = hit.translation;
  delete row.translationError;
  delete row.rejectedTranslation;
  row.translationStatus = "reused_duplicate_original";
  row.translationSourceId = hit.sourceId;
  row.translationSourceFile = hit.sourceFile;
  row.reusedAt = new Date().toISOString();
  rememberTranslation(row, hit.sourceFile);
  return true;
}
const args = process.argv.slice(2);

function argValue(name, fallback) { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; }
function hasArg(name) { return args.includes(name); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

const model = argValue("--model", DEFAULT_MODEL);
const host = argValue("--host", DEFAULT_HOST).replace(/\/$/, "");
const limit = Number.parseInt(argValue("--limit", "20"), 10);
const overwrite = hasArg("--overwrite");
const inputArg = argValue("--input", path.resolve("translator", "extracted_json", "Content_Forest.dc28793bf13e3dfdc5b8.js.json"));

const UI_GLOSSARY = new Map([
  ["Next", "下一步"],
  ["Back", "返回"],
  ["Leave", "离开"],
  ["Yes", "是"],
  ["No", "否"],
  ["Done", "完成"],
  ["Exit", "退出"],
  ["Cancel", "取消"],
  ["Accept", "接受"],
  ["Decline", "拒绝"]
]);
function applyUiGlossary(row) {
  if (!row || row.category !== "button_or_tooltip") return false;
  const hit = UI_GLOSSARY.get(row.original);
  if (!hit) return false;
  row.translation = hit;
  delete row.translationError;
  delete row.rejectedTranslation;
  row.translationStatus = "ui_glossary";
  row.translatedAt = new Date().toISOString();
  return true;
}

function collectInputFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return [resolved];
  return fs.readdirSync(resolved).filter(n => n.endsWith(".json") && n !== "_index.json").sort().map(n => path.join(resolved, n));
}
function outputPathFor(inputPath) { return path.join(OUT_DIR, path.basename(inputPath)); }
function mergeSourceQueueIntoTarget(sourceDoc, targetDoc) {
  if (!sourceDoc || !targetDoc || !Array.isArray(sourceDoc.rows) || !Array.isArray(targetDoc.rows)) return targetDoc;
  const sourceById = new Map(sourceDoc.rows.map((row) => [row.id, row]));
  for (const targetRow of targetDoc.rows) {
    const sourceRow = sourceById.get(targetRow.id);
    if (!sourceRow) continue;
    targetRow.shouldTranslate = sourceRow.shouldTranslate;
    targetRow.curatedReason = sourceRow.curatedReason;
    targetRow.contextKey = sourceRow.contextKey;
    targetRow.category = sourceRow.category;
    if (!sourceRow.shouldTranslate && !targetRow.translation) {
      delete targetRow.translationStatus;
      delete targetRow.translationError;
    }
  }
  if (sourceDoc.curated) targetDoc.curated = sourceDoc.curated;
  targetDoc.shouldTranslate = sourceDoc.shouldTranslate;
  return targetDoc;
}

function protectText(text) {
  const protectedValues = [];
  let output = text.replace(/\r\n/g, "\n");
  function add(value) { const token = `__T${protectedValues.length}__`; protectedValues.push({ token, value }); return token; }
  // 不保护换行，但保护 HTML 标签和 HTML entity。
  output = output.replace(/&[A-Za-z0-9#]+;/g, add);
  return { text: output, protectedValues };
}
function restoreText(text, protectedValues) {
  let output = text.trim();
  for (const item of [...protectedValues].reverse()) output = output.replaceAll(item.token, item.value);
  return output.replace(/^["“”'‘’]+/, "").replace(/["“”'‘’]+$/, "").trim();
}
function missingTokens(text, protectedValues) { return protectedValues.map(x => x.token).filter(t => !text.includes(t)); }
function buildPrompt(text) {
  return [
    "你是专业游戏本地化翻译。",
    "任务：将下面英文翻译为简体中文。",
    "要求：",
    "1. 只输出简体中文译文，不要解释，不要前缀。",
    "2. 除人名、专名、代码占位符外，不要保留英文原句。",
    "3. 不要新增原文没有的方括号结构；如果原文没有 [condition|...]，译文也不能出现。",
    "4. 必须原样保留所有方括号占位符，例如 [pc.name]、[pc.cock __E0__]。",
    "5. 必须保留所有形如 __T0__、__E0__ 的占位符，不能删除、改写。",
    "6. 语气自然，适合游戏文本。",
    "7. 不要自行增加换行。",
    "",
    "英文：",
    text
  ].join("\n");
}
function buildPromptForOriginal(original, protectedText) {
  if (!/[\[\]|<>]/.test(original)) {
    return [
      "你是专业游戏本地化翻译。",
      "任务：将下面英文翻译为简体中文。",
      "要求：",
      "1. 只输出简体中文译文，不要解释，不要前缀。",
      "2. 不要保留英文原句。",
      "3. 禁止输出方括号、管道符或任何条件语法字符：[ ] |。",
      "4. 语气自然，适合游戏文本。",
      "",
      "英文：",
      protectedText
    ].join("\n");
  }
  return buildPrompt(protectedText);
}
async function ollamaGenerate(prompt) {
  const response = await fetch(`${host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1, top_p: 0.9, num_predict: 1200 } })
  });
  if (!response.ok) throw new Error(`Ollama API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.response || "";
}
function normalizeModelResponse(text) {
  let output = String(text || "").trim();
  output = output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  output = output.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*/g, "").replace(/```$/g, "").trim();
  output = output.replace(/^\s*(?:译文|翻译|简体中文|中文)\s*[:：]\s*/i, "").trim();
  return output;
}
function hasGameSyntax(text) {
  return /[\[\]|<>]/.test(text);
}
function introducedForbiddenPlainSyntax(original, translated) {
  return !hasGameSyntax(original) && /[\[\]|]/.test(translated);
}function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}
function htmlTags(text) {
  return [...text.matchAll(/<\/?[A-Za-z][^>]*>/g)].map((match) => match[0]);
}
function bracketHeads(text) {
  const heads = [];
  const re = /\[\s*([A-Za-z_][A-Za-z0-9_.]*)/g;
  let match;
  while ((match = re.exec(text))) heads.push(match[1]);
  return heads;
}
function multiset(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) || 0) + 1);
  return map;
}
function sameMultiset(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
function structuralIssues(original, translated) {
  const checks = [
    ["[", countMatches(original, /\[/g), countMatches(translated, /\[/g)],
    ["]", countMatches(original, /\]/g), countMatches(translated, /\]/g)],
    ["|", countMatches(original, /\|/g), countMatches(translated, /\|/g)]
  ];
  const issues = checks
    .filter(([, a, b]) => a !== b)
    .map(([name, a, b]) => `${name}: original=${a}, translated=${b}`);
  const originalTags = htmlTags(original).join(" ");
  const translatedTags = htmlTags(translated).join(" ");
  if (originalTags !== translatedTags) issues.push(`html: original=${originalTags}; translated=${translatedTags}`);

  const originalHeads = multiset(bracketHeads(original));
  const translatedHeads = multiset(bracketHeads(translated));
  if (!sameMultiset(originalHeads, translatedHeads)) {
    issues.push(`bracket heads changed: original=${[...originalHeads.entries()].map(([k, v]) => `${k}x${v}`).join(",")}; translated=${[...translatedHeads.entries()].map(([k, v]) => `${k}x${v}`).join(",")}`);
  }
  return issues;
}
function englishPressure(text) {
  const visible = text.replace(/__T\d+__/g, "").replace(/\[[^\]]+\]/g, "");
  const letters = (visible.match(/[A-Za-z]/g) || []).length;
  const cjk = (visible.match(/[\u4e00-\u9fff]/g) || []).length;
  return letters / Math.max(1, letters + cjk);
}
function splitTopLevelText(text, maxChars = 1800) {
  if (text.length <= maxChars) return [{ type: "text", value: text }];
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "[") depth += 1;
    else if (ch === "]" && depth > 0) depth -= 1;

    if (ch === "\n" && depth === 0) {
      const match = text.slice(i).match(/^\n[ \t]*\n[ \t]*/);
      if (match && i - start >= 250) {
        parts.push({ type: "text", value: text.slice(start, i) });
        parts.push({ type: "sep", value: match[0] });
        i += match[0].length;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  if (start < text.length) parts.push({ type: "text", value: text.slice(start) });
  return parts.length ? parts : [{ type: "text", value: text }];
}
function splitOuterWhitespace(text) {
  const leading = text.match(/^\s*/)?.[0] || "";
  const trailing = text.match(/\s*$/)?.[0] || "";
  const core = text.slice(leading.length, text.length - trailing.length);
  return { leading, core, trailing };
}
async function translateSegment(original) {
  const protectedText = protectText(original);
  const plainMode = !hasGameSyntax(original);
  let response = normalizeModelResponse(await ollamaGenerate(buildPromptForOriginal(original, protectedText.text)));
  let missing = missingTokens(response, protectedText.protectedValues);
  let restored = restoreText(response, protectedText.protectedValues);
  let issues = structuralIssues(original, restored);

  if (missing.length || englishPressure(response) > 0.35 || issues.length) {
    response = normalizeModelResponse(await ollamaGenerate([
      plainMode ? "请只做普通文本翻译，不要模仿游戏脚本语法。" : "你上一次没有正确完成翻译。请重新翻译为简体中文。",
      "硬性要求：只输出简体中文译文；不要解释；不要保留英文句子。",
      plainMode ? "原文是普通文本，不含任何游戏条件结构；译文绝对禁止出现 [、]、| 三种字符。" : "必须保留所有游戏结构符号：方括号 []、管道符 |、HTML 标签；不要新增原文没有的方括号结构。",
      plainMode ? "如果需要停顿，请使用中文标点，不要使用方括号或竖线。" : "如果原文里有 [condition|text|text]，只翻译 text 部分，不要删除 [ ] 或 |。",
      missing.length ? `必须包含这些占位符：${missing.join(" ")}` : "",
      issues.length ? `结构必须修复：${issues.join("; ")}` : "",
      "",
      "英文原文：",
      protectedText.text
    ].join("\n")));
  }

  missing = missingTokens(response, protectedText.protectedValues);
  restored = restoreText(response, protectedText.protectedValues);
  issues = structuralIssues(original, restored);

  if (plainMode && (missing.length || issues.length || introducedForbiddenPlainSyntax(original, restored))) {
    response = normalizeModelResponse(await ollamaGenerate([
      "普通英文到简体中文翻译。",
      "只输出译文。不要解释。不要添加任何格式。",
      "绝对禁止使用这些字符：[ ] |。",
      "不要输出 condition、choice、branch 等游戏结构词。",
      "保留 __T0__ 这类占位符。",
      "",
      protectedText.text
    ].join("\n")));
    missing = missingTokens(response, protectedText.protectedValues);
    restored = restoreText(response, protectedText.protectedValues);
    issues = structuralIssues(original, restored);
  }

  if (missing.length) throw new Error(`missing protected token: ${missing.join(", ")}`);
  if (issues.length) throw new Error(`structure mismatch: ${issues.join("; ")}`);
  return restored;
}
function parseSingleOuterBracketBlock(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

  const startOffset = text.indexOf("[");
  const endOffset = text.lastIndexOf("]");
  const leading = text.slice(0, startOffset);
  const trailing = text.slice(endOffset + 1);
  const inner = text.slice(startOffset + 1, endOffset);

  let depth = 0;
  const pipes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "[") depth += 1;
    else if (ch === "]" && depth > 0) depth -= 1;
    else if (ch === "|" && depth === 0) pipes.push(i);
  }
  if (!pipes.length) return null;

  const header = inner.slice(0, pipes[0]);
  const branches = [];
  for (let i = 0; i < pipes.length; i += 1) {
    const start = pipes[i] + 1;
    const end = i + 1 < pipes.length ? pipes[i + 1] : inner.length;
    branches.push(inner.slice(start, end));
  }
  return { leading, trailing, header, branches };
}
async function translateOuterBracketBranches(original) {
  const parsed = parseSingleOuterBracketBlock(original);
  if (!parsed) return null;
  const translatedBranches = [];
  for (const branch of parsed.branches) {
    const ws = splitOuterWhitespace(branch);
    if (!ws.core.trim()) {
      translatedBranches.push(branch);
      continue;
    }
    translatedBranches.push(ws.leading + await translateOne(ws.core) + ws.trailing);
  }
  const joined = `${parsed.leading}[${parsed.header}|${translatedBranches.join("|")}]${parsed.trailing}`;
  const issues = structuralIssues(original, joined);
  if (issues.length) throw new Error(`structure mismatch after branch translation: ${issues.join("; ")}`);
  return joined;
}
function findMatchingBracketForStructured(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function topLevelPipesForStructured(inner) {
  const pipes = [];
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "[") depth += 1;
    else if (ch === "]" && depth > 0) depth -= 1;
    else if (ch === "|" && depth === 0) pipes.push(i);
  }
  return pipes;
}
async function translateLooseSyntaxText(text) {
  let output = "";
  let buffer = "";
  async function flush() {
    if (buffer) {
      output += await translatePlainStructuredText(buffer);
      buffer = "";
    }
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "|" || ch === "]") {
      await flush();
      output += ch;
    } else if (ch === "[" && text.indexOf("]", i + 1) < 0) {
      await flush();
      output += ch;
    } else {
      buffer += ch;
    }
  }
  await flush();
  return output;
}async function translateHtmlStructuredText(text) {
  const re = /<\/?[A-Za-z][^>\n]{0,160}>/g;
  let output = "";
  let cursor = 0;
  let match;
  let sawTag = false;
  while ((match = re.exec(text))) {
    sawTag = true;
    output += await translatePlainStructuredText(text.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }
  if (!sawTag) return null;
  output += await translatePlainStructuredText(text.slice(cursor));
  return output;
}
function splitPlainSentencesForStructured(text, maxChars = 520) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ((ch === "." || ch === "!" || ch === "?" || ch === "\n") && i - start >= 220) {
      let end = i + 1;
      while (end < text.length && /\s/.test(text[end])) end += 1;
      chunks.push(text.slice(start, end));
      start = end;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks.length > 1 ? chunks : [text];
}
async function translatePlainStructuredText(text) {
  if (!/[A-Za-z]/.test(text)) return text;
  const ws = splitOuterWhitespace(text);
  if (!ws.core.trim()) return text;
  const htmlTranslated = await translateHtmlStructuredText(ws.core);
  if (htmlTranslated !== null) return ws.leading + htmlTranslated + ws.trailing;
  const parts = splitTopLevelText(ws.core, 1400);
  if (parts.length > 1) {
    const out = [];
    for (const part of parts) {
      if (part.type === "sep") out.push(part.value);
      else out.push(await translatePlainStructuredText(part.value));
    }
    return ws.leading + out.join("") + ws.trailing;
  }
  const sentenceChunks = splitPlainSentencesForStructured(ws.core);
  if (sentenceChunks.length > 1) {
    const translatedChunks = [];
    for (const chunk of sentenceChunks) translatedChunks.push(await translatePlainStructuredText(chunk));
    return ws.leading + translatedChunks.join("") + ws.trailing;
  }
  try {
    return ws.leading + await translateSegment(ws.core) + ws.trailing;
  } catch (error) {
    if (!hasGameSyntax(ws.core) && String(error.message || error).includes("structure mismatch") && ws.core.length > 80) {
      const smallerChunks = splitPlainSentencesForStructured(ws.core, 180);
      if (smallerChunks.length > 1) {
        const translatedChunks = [];
        for (const chunk of smallerChunks) translatedChunks.push(await translatePlainStructuredText(chunk));
        return ws.leading + translatedChunks.join("") + ws.trailing;
      }
    }
    throw error;
  }
}
async function translateBracketBlockStructured(block) {
  const inner = block.slice(1, -1);
  const pipes = topLevelPipesForStructured(inner);
  if (!pipes.length) return block;
  const header = inner.slice(0, pipes[0]);
  const branches = [];
  for (let i = 0; i < pipes.length; i += 1) {
    const start = pipes[i] + 1;
    const end = i + 1 < pipes.length ? pipes[i + 1] : inner.length;
    branches.push(inner.slice(start, end));
  }
  const translatedBranches = [];
  for (const branch of branches) translatedBranches.push(await translateStructuredText(branch));
  return `[${header}|${translatedBranches.join("|")}]`;
}
async function translateStructuredText(text) {
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("[", cursor);
    if (open < 0) {
      const rest = text.slice(cursor);
      output += /[|\]]/.test(rest) ? await translateLooseSyntaxText(rest) : await translatePlainStructuredText(rest);
      break;
    }
    output += await translatePlainStructuredText(text.slice(cursor, open));
    const close = findMatchingBracketForStructured(text, open);
    if (close < 0) {
      output += await translateLooseSyntaxText(text.slice(open));
      break;
    }
    output += await translateBracketBlockStructured(text.slice(open, close + 1));
    cursor = close + 1;
  }
  return output;
}
async function translateOne(original) {
  const translated = await translateStructuredText(original);
  const issues = structuralIssues(original, translated);
  if (issues.length) throw new Error(`structure mismatch after structured translation: ${issues.join("; ")}`);
  return translated;
}
function loadSourceText(doc) { return doc.sourceFile && fs.existsSync(doc.sourceFile) ? fs.readFileSync(doc.sourceFile, "utf8") : ""; }
function joinExpressionBetween(sourceText, leftRow, rightRow) {
  if (!sourceText || typeof leftRow.end !== "number" || typeof rightRow.start !== "number") return null;
  const between = sourceText.slice(leftRow.end, rightRow.start);
  const m = between.match(/^\s*\+\s*([^+"'`;]+?)\s*\+\s*$/s);
  if (!m) return null;
  const expr = m[1].trim();
  return expr && expr.length <= 100 ? expr : null;
}
function buildUnit(rows, startIndex, sourceText) {
  const unitRows = [rows[startIndex]];
  const expressions = [];
  let original = rows[startIndex].original;
  let index = startIndex;
  while (index + 1 < rows.length) {
    const current = rows[index];
    const next = rows[index + 1];
    if (!next.shouldTranslate) break;
    if (!overwrite && next.translation && next.translation.trim()) break;
    const expr = joinExpressionBetween(sourceText, current, next);
    if (!expr) break;
    const token = `__E${expressions.length}__`;
    expressions.push({ token, expression: expr });
    unitRows.push(next);
    original += token + next.original;
    index += 1;
  }
  return { rows: unitRows, expressions, original, nextIndex: index + 1 };
}
function splitTranslatedUnit(translated, expressions) {
  if (!expressions.length) return [translated];
  const pieces = [];
  let cursor = 0;
  for (const item of expressions) {
    const found = translated.indexOf(item.token, cursor);
    if (found < 0) return null;
    pieces.push(translated.slice(cursor, found));
    cursor = found + item.token.length;
  }
  pieces.push(translated.slice(cursor));
  return pieces;
}

async function translateFile(inputPath, budget) {
  const sourceDoc = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const outPath = outputPathFor(inputPath);
  let target = sourceDoc;
  if (fs.existsSync(outPath) && !overwrite) target = mergeSourceQueueIntoTarget(sourceDoc, JSON.parse(fs.readFileSync(outPath, "utf8")));
  const sourceText = loadSourceText(target);
  let translated = 0, reused = 0, skipped = 0, failed = 0;
  const startedAt = Date.now();

  for (let index = 0; index < (target.rows || []).length;) {
    const row = target.rows[index];
    if (budget.value <= 0) break;
    if (!row.shouldTranslate) { skipped++; index++; continue; }
    if (!overwrite && row.translation && row.translation.trim()) { skipped++; index++; continue; }

    const unit = buildUnit(target.rows, index, sourceText);
    const preview = unit.original.replace(/\s+/g, " ").slice(0, 90);
    const joinNote = unit.rows.length > 1 ? ` joined=${unit.rows.length}` : "";
    process.stdout.write(`[${translated + 1}/${limit}] ${path.basename(inputPath)} #${row.line ?? row.jsonPointer ?? "?"}${joinNote}: ${preview}\n`);

    try {
      const unitTranslation = await translateOne(unit.original);
      const pieces = splitTranslatedUnit(unitTranslation, unit.expressions);
      if (!pieces || pieces.length !== unit.rows.length) throw new Error(`missing expression marker; got: ${unitTranslation}`);
      unit.rows.forEach((unitRow, pieceIndex) => {
        unitRow.translation = pieces[pieceIndex].trim();
        delete unitRow.translationError;
        delete unitRow.rejectedTranslation;
        unitRow.translationStatus = unit.rows.length > 1 ? "ollama_translated_joined_expression" : "ollama_translated";
        unitRow.translationModel = model;
        unitRow.translatedAt = new Date().toISOString();
        rememberTranslation(unitRow, path.basename(outPath));
        if (unit.expressions[pieceIndex]) {
          unitRow.trailingExpression = unit.expressions[pieceIndex].expression;
          unitRow.trailingExpressionToken = unit.expressions[pieceIndex].token;
        }
      });
      translated++;
      budget.value--;
    } catch (error) {
      if (row.translation && row.translation.trim()) row.rejectedTranslation = row.translation;
      row.translation = "";
      row.translationStatus = "failed";
      row.translationError = String(error.message || error);
      failed++;
      budget.value--;
    }

    index = unit.nextIndex;
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, `${JSON.stringify(target, null, 2)}\n`, "utf8");
  }
  return { inputPath, outPath, translated, reused, skipped, failed, seconds: ((Date.now() - startedAt) / 1000).toFixed(1) };
}

async function main() {
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit 必须是大于 0 的数字。 ");
  ensureDir(OUT_DIR);
  buildTranslationMemory();
  const files = collectInputFiles(inputArg);
  const budget = { value: limit };
  const summaries = [];
  for (const file of files) { if (budget.value <= 0) break; summaries.push(await translateFile(file, budget)); }
  console.log("\n完成：");
  for (const s of summaries) console.log(`${path.basename(s.inputPath)} -> ${s.outPath}, translated=${s.translated}, reused=${s.reused || 0}, skipped=${s.skipped}, failed=${s.failed}, time=${s.seconds}s`);
}
main().catch(e => { console.error(e); process.exit(1); });









