import crypto from "node:crypto";

export function sha1(text) {
  return crypto.createHash("sha1").update(String(text ?? "")).digest("hex");
}

export function shortHash(text) {
  return sha1(text).slice(0, 12);
}

export function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineOf(starts, offset) {
  let low = 0, high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

export function decodeJsString(raw) {
  try { return Function(`"use strict"; return (${raw});`)(); }
  catch { return null; }
}

function regexCanStart(source, slashIndex) {
  let i = slashIndex - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return true;
  if (/[({\[=,:;!&|?]/.test(source[i])) return true;
  const prefix = source.slice(Math.max(0, i - 14), i + 1);
  return /(?:^|\b)(?:return|throw|case|delete|void|typeof|instanceof|in|of)$/.test(prefix);
}

// Dependency-free lexer for ordinary quoted literals in webpack bundles.
// It deliberately ignores template literals: translated rows are only safe to
// replace when they are complete quoted literals or explicit manual overlays.
export function scanStringLiterals(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i], next = source[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (ch === "/" && next !== "/" && next !== "*" && regexCanStart(source, i)) {
      i += 1;
      let escaped = false, inClass = false;
      while (i < source.length) {
        const c = source[i];
        if (escaped) { escaped = false; i += 1; continue; }
        if (c === "\\") { escaped = true; i += 1; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { i += 1; while (/[A-Za-z]/.test(source[i] || "")) i += 1; break; }
        else if (c === "\n") break;
        i += 1;
      }
      continue;
    }
    if (ch === "`") {
      i += 1;
      let escaped = false;
      while (i < source.length) {
        const c = source[i];
        if (escaped) { escaped = false; i += 1; continue; }
        if (c === "\\") { escaped = true; i += 1; continue; }
        if (c === "`") { i += 1; break; }
        i += 1;
      }
      continue;
    }
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
        const end = i, raw = source.slice(start, end), value = decodeJsString(raw);
        if (typeof value === "string") tokens.push({ start, end, raw, value });
        break;
      }
      i += 1;
    }
  }
  return tokens;
}

export function looksLikeAssetOrCode(text) {
  const trimmed = String(text || "").trim();
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

function contextBefore(source, start, size = 2400) {
  return source.slice(Math.max(0, start - size), start);
}

function isInsideNamedCall(source, position, name, maxDistance = 6000) {
  const callAt = source.lastIndexOf(name, position);
  if (callAt < 0 || position - callAt > maxDistance) return false;
  const open = source.indexOf("(", callAt + name.length);
  if (open < 0 || open >= position) return false;
  let depth = 1, quote = "", escaped = false, lineComment = false, blockComment = false;
  for (let i = open + 1; i < position; i++) {
    const ch = source[i], next = source[i + 1];
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
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth <= 0) return false; }
  }
  return depth > 0;
}

export function classifyJsString(source, token) {
  const before = contextBefore(source, token.start);
  const near = before.slice(-700);
  const after = source.slice(token.end, Math.min(source.length, token.end + 240));
  const value = token.value;
  if (/(?:\{|,)\s*key\s*:\s*$/s.test(near)) return "internal_key";
  if (/^\s*(?:===|!==|==|!=)/.test(after) && /[.$\w\]]\s*\.\s*(?:desc|description|tooltip|text|message)\s*=\s*function\s*\([^)]*\)\s*\{\s*return\s*$/s.test(near)) return "internal_key";
  if (isInsideNamedCall(source, token.start, "CombatManager.bufferAliases") && /^(?:s|es|ies|y)$/i.test(value.trim())) return "internal_key";
  // showBust arguments and their concatenated suffixes are asset identifiers,
  // even if a nearby showName call would otherwise make them look like speakers.
  if (isInsideNamedCall(source, token.start, "showBust")) return "internal_key";
  if (/\b(?:output|outputParsed|textify|bufferAliases)\s*\([^;{}]*$/s.test(near) || /\bCombatManager\.bufferAliases\s*\([^;{}]*$/s.test(near)) return "dialogue";
  if (/\b(?:addButton|addDisabledButton|addGatedButton|addGatedButtonObj|addTooltip)\s*\([^;{}]*$/s.test(near)) return "button_or_tooltip";
  if (/\bshowName\s*\([^;{}]*$/s.test(near)) return "speaker";
  if (/[.$\w\]]\s*\.\s*(?:name|short|longName|desc|description|tooltip|title|text|label|message)\s*[:=]\s*$/s.test(near)) return "property_text";
  if (/[.$\w\]]\s*\.\s*(?:desc|description|tooltip|text|message)\s*=\s*function\s*\([^)]*\)\s*\{\s*return\s*$/s.test(near)) return "property_text";
  if (/(?:^|[,{])\s*["']?(?:name|short|longName|desc|description|tooltip|title|text|label|message)["']?\s*:\s*$/s.test(near)) return "property_text";
  if (/^\s*[,)}\]]/.test(after) && /[.!?,;:]|<[^>]+>|\[[^\]]+\]|\s/.test(value)) return "possible_text";
  return "unknown";
}

function looksLikeJsCodeShard(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const strong = /\.test\s*\(|function\s*\(|function\s*\{|=>|\breturn\b|\bwindow\.[A-Za-z_$][\w$]*\s*=\s*function\b|&&|\|\|/.test(t);
  const shape = /[{}]|\)\{|\}\)|\.toLowerCase\s*\(|\.includes\s*\(|\b(?:var|let|const)\s+[A-Za-z_$][\w$]*/.test(t);
  return strong && shape;
}

export function baseShouldTranslate(value, category) {
  const trimmed = String(value || "").trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) return false;
  if (category === "internal_key" || looksLikeAssetOrCode(trimmed)) return false;
  if (category === "unknown" && looksLikeJsCodeShard(trimmed)) return false;
  if (category !== "unknown") return true;
  return trimmed.length >= 18 && /[.!?,;:]|\s/.test(trimmed);
}

export function extractRowsFromJs(fileName, source) {
  const starts = lineStarts(source);
  const valueCounts = new Map(), categoryCounts = new Map();
  return scanStringLiterals(source).map((token, sourceIndex) => {
    const category = classifyJsString(source, token);
    const valueOccurrence = valueCounts.get(token.value) || 0;
    valueCounts.set(token.value, valueOccurrence + 1);
    const categoryKey = `${token.value}\u0000${category}`;
    const categoryOccurrence = categoryCounts.get(categoryKey) || 0;
    categoryCounts.set(categoryKey, categoryOccurrence + 1);
    return {
      id: `${fileName}:${token.start}:${token.end}:${shortHash(token.value)}`,
      stableId: `${fileName}:text:${shortHash(token.value)}:${valueOccurrence}`,
      file: fileName,
      category,
      shouldTranslate: baseShouldTranslate(token.value, category),
      original: token.value,
      translation: "",
      start: token.start,
      end: token.end,
      line: lineOf(starts, token.start),
      raw: token.raw,
      sourceIndex,
      valueOccurrence,
      categoryOccurrence
    };
  });
}

export function isQuotedLiteralRaw(raw) {
  const text = String(raw || "");
  if (text.length < 2) return false;
  const first = text.charCodeAt(0);
  return (first === 34 || first === 39) && text.charCodeAt(text.length - 1) === first;
}

export function pairRowsBySemanticOccurrence(newRows, oldRows) {
  const result = new Map(), usedOld = new Set();
  const oldById = new Map(oldRows.map((row) => [row.id, row]));
  const oldByStable = new Map(oldRows.filter((r) => r.stableId).map((row) => [row.stableId, row]));
  for (const row of newRows) {
    const hit = oldById.get(row.id) || oldByStable.get(row.stableId);
    if (hit && !usedOld.has(hit)) { result.set(row, hit); usedOld.add(hit); }
  }
  const group = (rows, skip, withCategory) => {
    const map = new Map();
    for (const row of rows) {
      if (skip.has(row) || typeof row.original !== "string") continue;
      const key = withCategory ? `${row.original}\u0000${row.category || ""}` : row.original;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  };
  const newIndex = new Map(newRows.map((row, index) => [row, index]));
  const oldIndex = new Map(oldRows.map((row, index) => [row, index]));
  const usedNew = new Set(result.keys());
  const contextScore = (fresh, prior) => {
    const ni = newIndex.get(fresh) ?? 0, oi = oldIndex.get(prior) ?? 0;
    let score = 0;
    for (let distance = 1; distance <= 3; distance += 1) {
      const weight = 5 - distance;
      if (newRows[ni - distance]?.original === oldRows[oi - distance]?.original) score += weight;
      if (newRows[ni + distance]?.original === oldRows[oi + distance]?.original) score += weight;
    }
    const freshRatio = ni / Math.max(1, newRows.length - 1);
    const oldRatio = oi / Math.max(1, oldRows.length - 1);
    score -= Math.abs(freshRatio - oldRatio) * 4;
    return score;
  };
  const pairGroup = (newGroup, oldGroup) => {
    if (!newGroup.length || !oldGroup.length) return;
    if (newGroup.length === oldGroup.length) {
      for (let i = 0; i < newGroup.length; i += 1) {
        result.set(newGroup[i], oldGroup[i]);
        usedNew.add(newGroup[i]);
        usedOld.add(oldGroup[i]);
      }
      return;
    }
    if (newGroup.length * oldGroup.length > 10000) {
      const oldAvailable = new Set(oldGroup);
      for (let i = 0; i < newGroup.length && oldAvailable.size; i += 1) {
        const fresh = newGroup[i];
        const target = newGroup.length <= 1 ? 0 : Math.round(i * (oldGroup.length - 1) / (newGroup.length - 1));
        let best = null, bestScore = -Infinity;
        for (let radius = 0; radius <= 12; radius += 1) {
          for (const candidateIndex of radius ? [target - radius, target + radius] : [target]) {
            const prior = oldGroup[candidateIndex];
            if (!prior || !oldAvailable.has(prior)) continue;
            const score = contextScore(fresh, prior);
            if (score > bestScore) { best = prior; bestScore = score; }
          }
        }
        if (!best) best = oldAvailable.values().next().value;
        result.set(fresh, best);
        usedNew.add(fresh);
        usedOld.add(best);
        oldAvailable.delete(best);
      }
      return;
    }
    const candidates = [];
    for (const fresh of newGroup) for (const prior of oldGroup) {
      candidates.push({ fresh, prior, score: contextScore(fresh, prior) });
    }
    candidates.sort((a, b) => b.score - a.score
      || (newIndex.get(a.fresh) ?? 0) - (newIndex.get(b.fresh) ?? 0)
      || (oldIndex.get(a.prior) ?? 0) - (oldIndex.get(b.prior) ?? 0));
    for (const { fresh, prior } of candidates) {
      if (usedNew.has(fresh) || usedOld.has(prior)) continue;
      result.set(fresh, prior);
      usedNew.add(fresh);
      usedOld.add(prior);
    }
  };
  for (const withCategory of [true, false]) {
    const news = group(newRows, usedNew, withCategory), olds = group(oldRows, usedOld, withCategory);
    for (const [key, newGroup] of news) {
      const oldGroup = olds.get(key) || [];
      if (!oldGroup.length) continue;
      pairGroup(newGroup, oldGroup);
    }
  }
  return result;
}

function allIndices(source, needle) {
  const out = [];
  if (!needle) return out;
  let at = -1;
  while ((at = source.indexOf(needle, at + 1)) >= 0) out.push(at);
  return out;
}

export function rebaseRowsToSource(rows, source, fileName, options = {}) {
  // Records were already located by migration. NEVER reassign occurrences using
  // editable array order; verify NEW offsets and produce only a transient index.
  const sorted = [...rows].sort((a,b) => a.start-b.start || a.end-b.end);
  const seen = new Set();
  for (const row of sorted) {
    if (!Number.isInteger(row.start) || !Number.isInteger(row.end) || row.start < 0 || row.end <= row.start || row.end > source.length || typeof row.raw !== 'string' || source.slice(row.start,row.end) !== row.raw || row.file !== fileName) {
      throw new Error('Source location mismatch; re-extract and migrate before apply: ' + row.id);
    }
    const k = row.start+':'+row.end;
    if(seen.has(k)) throw new Error('Duplicate record range: '+row.id);
    seen.add(k);
  }
  return {rows: sorted.map(r=>({...r,translation:r.shouldTranslate===true?r.translation:'',rebaseMatched:true})),freshRows:[],stats:{total:rows.length,matched:rows.length,overlays:rows.filter(r=>r.manualTextOverlay).length,unmatched:0,mode:'verified_new_offsets_no_relocation'}};
}
