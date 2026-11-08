import fs from "node:fs";
import path from "node:path";
import { rebaseRowsToSource } from "./js_text_tools.mjs";

const TRANSLATED_JSON_DIR = path.resolve("translator", "translated_json");
const TRANSLATED_APP_DIR = path.resolve("translator", "translated_app");
const ORIGINAL_APP_DIR = path.resolve("resources", "app");
const includeAll = process.argv.includes("--all");
const DISPLAY_MAPPING_PATH = path.resolve("translator", "glossary", "mapping_apply.json");
const DISPLAY_MAPPING_DOC = fs.existsSync(DISPLAY_MAPPING_PATH) ? JSON.parse(fs.readFileSync(DISPLAY_MAPPING_PATH, "utf8")) : { mappings: {} };
function displayMapping(groupName) { return DISPLAY_MAPPING_DOC.mappings?.[groupName] || {}; }


function jsStringLiteral(value) {
  return JSON.stringify(value);
}

function jsStringContent(value, quote = '"') {
  let content = JSON.stringify(value).slice(1, -1);
  if (quote === "'") content = content.replaceAll("'", "\\'");
  if (quote === "`") content = content.replaceAll("`", "\\`").replaceAll("${", "\\${");
  return content;
}

function looseCodePattern(code, flags = "g") {
  const tokens = [];
  for (let i = 0; i < code.length;) {
    if (/\s/.test(code[i])) { i += 1; continue; }
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1, escaped = false;
      while (j < code.length) {
        const current = code[j++];
        if (escaped) { escaped = false; continue; }
        if (current === "\\") { escaped = true; continue; }
        if (current === quote) break;
      }
      tokens.push(code.slice(i, j)); i = j; continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
    if (identifier) { tokens.push(identifier[0]); i += identifier[0].length; continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(code.slice(i));
    if (number) { tokens.push(number[0]); i += number[0].length; continue; }
    const operator = /^(?:===|!==|>>>|\*\*|=>|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|\?\?|\?\.)/.exec(code.slice(i));
    if (operator) { tokens.push(operator[0]); i += operator[0].length; continue; }
    tokens.push(ch); i += 1;
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern = "";
  for (let i = 0; i < tokens.length; i += 1) {
    if (i) pattern += /^[\])}]$/.test(tokens[i]) ? "\\s*,?\\s*" : "\\s*";
    pattern += escape(tokens[i]);
  }
  return new RegExp(pattern, flags);
}

function looseCount(source, code) {
  return [...source.matchAll(looseCodePattern(code))].length;
}

function replaceLooseCode(source, from, to, { expected = 1, label = from, fatal = false, all = true } = {}) {
  const fromCount = looseCount(source, from);
  const toCount = looseCount(source, to);
  if (fromCount === expected) return source.replace(looseCodePattern(from), all ? to : (...args) => to);
  if (fromCount === 0 && toCount === expected) return source;
  const message = `${label} pattern count ${fromCount}, expected ${expected}`;
  if (fatal) throw new Error(message);
  console.warn(message);
  return source;
}

function replaceLooseAny(source, from, to, label = from) {
  const fromCount = looseCount(source, from);
  if (fromCount > 0) return source.replace(looseCodePattern(from), to);
  if (looseCount(source, to) > 0) return source;
  console.warn(`${label} pattern not found`);
  return source;
}

function isSafeManualTextOverlay(row, source) {
  return Boolean(
    row &&
    row.manualTextOverlay === true &&
    typeof row.raw === "string" &&
    row.raw.length > 0 &&
    typeof row.translation === "string" &&
    row.translation.length > 0 &&
    typeof row.start === "number" &&
    typeof row.end === "number" &&
    row.end === row.start + row.raw.length &&
    source.slice(row.start, row.end) === row.raw &&
    !isPromptLeakTranslation(row)
  );
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
  return /\.test\(|\.includes\(|\.toLowerCase\(|function\s*\(|processTime\(|addButton\(|NameKiddo\(|return["A-Za-z_$]|\bvar\s+[A-Za-z_$][\w$]*\s*(?:=|,|;)|\bconst\s+[A-Za-z_$][\w$]*\s*(?:=|,|;)|\blet\s+[A-Za-z_$][\w$]*\s*(?:=|,|;)|\}\);|=>/.test(text);
}

function isDangerousCodeKeyReplacement(row, source) {
  if (!row || typeof source !== "string") return false;
  const before = source.slice(Math.max(0, row.start - 24), row.start);
  const after = source.slice(row.end, row.end + 96);

  // Babel/Webpack class property descriptors: {key:"short",get:function...}
  // These are internal method/property names, not player-facing text.
  if (/key:\s*$/.test(before) && /^\s*,\s*(get|set|value|enumerable|configurable|writable)\b/.test(after)) return true;

  // Runtime error strings inside throw new TypeError/ReferenceError are diagnostic code, not game text.
  if (/(TypeError|ReferenceError|Error)\s*\(\s*$/.test(before)) return true;

  return false;
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


function patchSelectItemShortLabels(source, appName) {
  const hairMap = displayMapping("cnHairLabel");
  const beardMap = displayMapping("cnBeardLabel");
  // Selector names are internal keys. Translate only the temporary display
  // object and restore the English name before the game callback stores it.
  const tattooMap = displayMapping("cnTattooLabel");
  const makeupMap = displayMapping("cnMakeupLabel");
  const mapExpr = JSON.stringify(hairMap);
  const beardMapExpr = JSON.stringify(beardMap);
  const tattooMapExpr = JSON.stringify(tattooMap);
  const makeupMapExpr = JSON.stringify(makeupMap);
  const inject = "var __cnSelectLabelMap=" + mapExpr + ",__cnBeardLabelMap=" + beardMapExpr + ",__cnTattooLabelMap=" + tattooMapExpr + ",__cnMakeupLabelMap=" + makeupMapExpr + ",__cnSelectLabel=function(e){return __cnSelectLabelMap[e]||e},__cnPatchSelectShort=function(e){return e&&e.name&&__cnSelectLabelMap[e.name]&&(e.short=__cnSelectLabelMap[e.name]),e},__cnPatchHairSelectItem=function(e){var t;return e&&e.name&&(t=__cnSelectLabelMap[e.name])&&(e.__cnOriginalName=e.name,e.__cnOriginalShort=e.short,e.name=t),e},__cnPatchBeardSelectItem=function(e){var t;return e&&e.name&&(t=__cnBeardLabelMap[e.name])&&(e.__cnOriginalName=e.name,e.__cnOriginalShort=e.short,e.name=t),e},__cnWrapHairSelectCallback=function(e){return function(){var t=arguments[0];return t&&t.__cnOriginalName&&(t.name=t.__cnOriginalName,t.short=t.__cnOriginalShort,delete t.__cnOriginalName,delete t.__cnOriginalShort),e.apply(this,arguments)}},__cnPatchTattooSelectItem=function(e){var t;return e&&e.name&&(t=__cnTattooLabelMap[e.name])&&(e.__cnOriginalName=e.name,e.__cnOriginalShort=e.short,e.name=t),e},__cnWrapTattooSelectCallback=function(e){return function(){var t=arguments[0];return t&&t.__cnOriginalName&&(t.name=t.__cnOriginalName,t.short=t.__cnOriginalShort,delete t.__cnOriginalName,delete t.__cnOriginalShort),e.apply(this,arguments)}},__cnPatchMakeupSelectItem=function(e){var t;return e&&e.name&&(t=__cnMakeupLabelMap[e.name])&&(e.__cnOriginalName=e.name,e.__cnOriginalShort=e.short,e.name=t),e},__cnWrapMakeupSelectCallback=function(e){return function(){var t=arguments[0];return t&&t.__cnOriginalName&&(t.name=t.__cnOriginalName,t.short=t.__cnOriginalShort,delete t.__cnOriginalName,delete t.__cnOriginalShort),e.apply(this,arguments)}};";
  if (!source.includes("__cnPatchSelectShort=function")) {
    if (appName.startsWith("Content_Hawkethorne.") || appName.startsWith("Content_MarefolkVillage.")) source = inject + source;
  }

  const patchSelectorRegion = ({ startAnchor, endAnchor, serviceName, itemHelper, callbackHelper, expected, label }) => {
    const start = source.indexOf(startAnchor);
    let end = endAnchor ? source.indexOf(endAnchor, start) : -1;
    if (start >= 0 && end < 0) {
      const nextWindow = /\(\s*window\.[A-Za-z_$][\w$]*\s*=\s*function\b/g;
      nextWindow.lastIndex = start + startAnchor.length;
      end = nextWindow.exec(source)?.index ?? source.length;
    }
    if (start < 0 || end <= start) throw new Error(appName + ": " + label + " selector region not found");
    let region = source.slice(start, end);
    const pattern = new RegExp("\\bDoItemSelectTable\\(\\s*([a-zA-Z_$][\\w$]*)\\s*,\\s*([a-zA-Z_$][\\w$]*)\\s*,\\s*" + serviceName + "\\s*,", "g");
    let count = 0;
    region = region.replace(pattern, (_, items, callback) => {
      count++;
      return "DoItemSelectTable(" + items + ".map(" + itemHelper + ")," + callbackHelper + "(" + callback + ")," + serviceName + ",";
    });
    if (count !== expected) throw new Error(appName + ": " + label + " selector count " + count + ", expected " + expected);
    source = source.slice(0, start) + region + source.slice(end);
  };

  if (appName.startsWith("Content_Hawkethorne.")) {
    patchSelectorRegion({ startAnchor: "window.StylistsHairdressing", endAnchor: "window.StylistsMakeup", serviceName: "StylistServices", itemHelper: "__cnPatchHairSelectItem", callbackHelper: "__cnWrapHairSelectCallback", expected: 1, label: "hair" });
    patchSelectorRegion({ startAnchor: "window.StylistsMakeup", endAnchor: "window.StylistsTattoos", serviceName: "StylistsMakeup", itemHelper: "__cnPatchMakeupSelectItem", callbackHelper: "__cnWrapMakeupSelectCallback", expected: 3, label: "makeup" });
    patchSelectorRegion({ startAnchor: "window.StylistsTattoosAss", endAnchor: "window.StylistsBeards", serviceName: "StylistsTattoos", itemHelper: "__cnPatchTattooSelectItem", callbackHelper: "__cnWrapTattooSelectCallback", expected: 8, label: "tattoo" });
    patchSelectorRegion({ startAnchor: "window.StylistsBeards", serviceName: "StylistServices", itemHelper: "__cnPatchBeardSelectItem", callbackHelper: "__cnWrapHairSelectCallback", expected: 1, label: "beard" });
  }
  if (appName.startsWith("Content_MarefolkVillage.")) {
    patchSelectorRegion({ startAnchor: "window.MarefolkStylistsBeards", endAnchor: "window.MarefolkStylistsHairdressing", serviceName: "MarefolkStylistsServices", itemHelper: "__cnPatchBeardSelectItem", callbackHelper: "__cnWrapHairSelectCallback", expected: 1, label: "beard" });
    patchSelectorRegion({ startAnchor: "window.MarefolkStylistsHairdressing", serviceName: "MarefolkStylistsServices", itemHelper: "__cnPatchHairSelectItem", callbackHelper: "__cnWrapHairSelectCallback", expected: 1, label: "hair" });
  }

  return source;
}

function patch103QuestDisplayLabels(source) {
  const questMap = displayMapping("cnQuestLabel");
  const inject = "globalThis.cnQuestLabel=globalThis.cnQuestLabel||function(e){var t=String(e||\"\");return Object.prototype.hasOwnProperty.call(globalThis.cnQuestLabel.map,t)?globalThis.cnQuestLabel.map[t]:t};globalThis.cnQuestLabel.map=Object.assign(globalThis.cnQuestLabel.map||{}," + JSON.stringify(questMap) + ");";
  if (!source.includes("globalThis.cnQuestLabel=globalThis.cnQuestLabel||function")) source = inject + source;
  const selector = /(ref\s*:\s*a\s*\?\s*e\.selRef\s*:\s*null\s*,?\s*}\s*,)\s*n\.name\s*,/g;
  const matches = [...source.matchAll(selector)];
  if (matches.length !== 1) {
    console.warn(`103 quest-list display selector pattern count ${matches.length}, expected 1`);
    return source;
  }
  return source.replace(selector, '$1 globalThis.cnQuestLabel?globalThis.cnQuestLabel(n.name):n.name,');
}

function patch673QuestDisplayLabels(source) {
  const questMap = displayMapping("cnQuestLabel");
  const inject = "globalThis.cnQuestLabel=globalThis.cnQuestLabel||function(e){var t=String(e||\"\");return Object.prototype.hasOwnProperty.call(globalThis.cnQuestLabel.map,t)?globalThis.cnQuestLabel.map[t]:t};globalThis.cnQuestLabel.map=Object.assign(globalThis.cnQuestLabel.map||{}," + JSON.stringify(questMap) + ");";
  if (!source.includes("globalThis.cnQuestLabel=globalThis.cnQuestLabel||function")) source = inject + source;
  const selector = /(\)\)\s*,\s*)this\.name(\s*,\s*r\s*,\s*a\s*,\s*this\.currentDesc\(\)\s*,?\s*\))/g;
  const matches = [...source.matchAll(selector)];
  if (matches.length !== 1) {
    console.warn("673: inline quest-blurb title selector not found uniquely; inline quest title mapping was not applied.");
    return source;
  }
  return source.replace(selector, '$1(globalThis.cnQuestLabel?globalThis.cnQuestLabel(this.name):this.name)$2');
}

function patch673QuestCharacterLabels(source) {
  const characterMap = displayMapping("cnCharacterLabel");
  const inject = "globalThis.cnCharacterLabel=globalThis.cnCharacterLabel||function(e){var f=globalThis.cnCharacterLabel,t=String(e==null?\"\":e);if(Object.prototype.hasOwnProperty.call(f.map,t))return f.map[t];if(Object.prototype.hasOwnProperty.call(f.cache,t))return f.cache[t];function w(c){var n=c&&c.charCodeAt(0);return n>=65&&n<=90||n>=97&&n<=122}var r=t;for(var i=0;i<f.keys.length;i++){var k=f.keys[i],v=f.map[k],p=0;while((p=r.indexOf(k,p))>=0){var a=p===0||!w(r.charAt(p-1)),b=p+k.length===r.length||!w(r.charAt(p+k.length));if(a&&b){r=r.slice(0,p)+v+r.slice(p+k.length);p+=v.length}else p+=k.length}}return f.cache[t]=r};globalThis.cnCharacterLabel.map=Object.assign(globalThis.cnCharacterLabel.map||{}," + JSON.stringify(characterMap) + ");globalThis.cnCharacterLabel.cache={};globalThis.cnCharacterLabel.keys=Object.keys(globalThis.cnCharacterLabel.map).sort(function(a,b){return b.length-a.length});";
  if (!source.includes("globalThis.cnCharacterLabel=globalThis.cnCharacterLabel||function")) source = inject + source;
  const replacements = [
    ['colorText(e.KohakuMet?"green":"gray","Kohaku")', 'colorText(e.KohakuMet?"green":"gray",globalThis.cnCharacterLabel("Kohaku"))', "Kohaku quest display"],
    ['colorText(e.MikoMaiMet?"green":"gray","Miko and Mai")', 'colorText(e.MikoMaiMet?"green":"gray",globalThis.cnCharacterLabel("Miko and Mai"))', "Miko and Mai quest display"],
    ['colorText(e.NakanoMet?"green":"gray","Nakano")', 'colorText(e.NakanoMet?"green":"gray",globalThis.cnCharacterLabel("Nakano"))', "Nakano quest display"],
    [')),1===flags.ASHE_SPEAR_CHOICE?"Azzy":"Evelyn",1===flags.ASHE_SPEAR_CHOICE?', ')),globalThis.cnCharacterLabel(1===flags.ASHE_SPEAR_CHOICE?"Azzy":"Evelyn"),1===flags.ASHE_SPEAR_CHOICE?', "Ashe quest dynamic companion display"],
    ['colorText(e.askedElthara?"green":"gray","Elthara")', 'colorText(e.askedElthara?"green":"gray",globalThis.cnCharacterLabel("Elthara"))', "Wyld Hunt Elthara display"],
    ['colorText(e.askedHethia?"green":"gray","Hethia")', 'colorText(e.askedHethia?"green":"gray",globalThis.cnCharacterLabel("Hethia"))', "Wyld Hunt Hethia display"],
    ['colorText(e.askedDaliza?"green":"gray","Daliza")', 'colorText(e.askedDaliza?"green":"gray",globalThis.cnCharacterLabel("Daliza"))', "Wyld Hunt Daliza display"],
    ['.concat(flags.WAYFORT_OGRISH?"Ogrish":flags.WAYFORT_RAGS?"Ragnild":"Zuzaan",".")', '.concat(globalThis.cnCharacterLabel(flags.WAYFORT_OGRISH?"Ogrish":flags.WAYFORT_RAGS?"Ragnild":"Zuzaan"),".")', "Wayfort blacksmith display"],
    ['.concat(flags.WAYFORT_NELIA?"Nelia":"Telfir",".")', '.concat(globalThis.cnCharacterLabel(flags.WAYFORT_NELIA?"Nelia":"Telfir"),".")', "Wayfort tailor display"],
    ['.concat(flags.WAYFORT_EVERGREEN?"Evergreen":flags.WAYFORT_IMORA?"Imora":flags.WAYFORT_MAIDENS?"Miko & Mai":flags.WAYFORT_VIV?"Viviane":"Zuzaan",".")', '.concat(globalThis.cnCharacterLabel(flags.WAYFORT_EVERGREEN?"Evergreen":flags.WAYFORT_IMORA?"Imora":flags.WAYFORT_MAIDENS?"Miko & Mai":flags.WAYFORT_VIV?"Viviane":"Zuzaan"),".")', "Wayfort enchanter display"],
    ['.concat(flags.ROOST_VIV?"Viviane":flags.ROOST_EVERGREEN?"Evergreen":"Zuzaan",".")', '.concat(globalThis.cnCharacterLabel(flags.ROOST_VIV?"Viviane":flags.ROOST_EVERGREEN?"Evergreen":"Zuzaan"),".")', "Dragon Roost enchanter display"],
    ['.concat(1===flags.WAYFORT_DUNGEON_ENCH?"Evergreen":2===flags.WAYFORT_DUNGEON_ENCH?"Viviane":3===flags.WAYFORT_DUNGEON_ENCH?"Miko":4===flags.WAYFORT_DUNGEON_ENCH?"Mai":5===flags.WAYFORT_DUNGEON_ENCH?"Meira":"",".")', '.concat(globalThis.cnCharacterLabel(1===flags.WAYFORT_DUNGEON_ENCH?"Evergreen":2===flags.WAYFORT_DUNGEON_ENCH?"Viviane":3===flags.WAYFORT_DUNGEON_ENCH?"Miko":4===flags.WAYFORT_DUNGEON_ENCH?"Mai":5===flags.WAYFORT_DUNGEON_ENCH?"Meira":""),".")', "Dungeoneering enchanter display"],
    [',e.oracleVisited)', ',globalThis.cnCharacterLabel(e.oracleVisited))', "Nightmemory oracle display"],
  ];
  for (const [original, patched, label] of replacements) {
    source = replaceLooseAny(source, original, patched, `673 ${label}`);
  }
  return source;
}

function patch505CharacterNameLabels(source) {
  const characterMap = displayMapping("cnCharacterLabel");
  const inject = "globalThis.cnCharacterLabel=globalThis.cnCharacterLabel||function(e){var f=globalThis.cnCharacterLabel,t=String(e==null?\"\":e);if(Object.prototype.hasOwnProperty.call(f.map,t))return f.map[t];if(Object.prototype.hasOwnProperty.call(f.cache,t))return f.cache[t];function w(c){var n=c&&c.charCodeAt(0);return n>=65&&n<=90||n>=97&&n<=122}var r=t;for(var i=0;i<f.keys.length;i++){var k=f.keys[i],v=f.map[k],p=0;while((p=r.indexOf(k,p))>=0){var a=p===0||!w(r.charAt(p-1)),b=p+k.length===r.length||!w(r.charAt(p+k.length));if(a&&b){r=r.slice(0,p)+v+r.slice(p+k.length);p+=v.length}else p+=k.length}}return f.cache[t]=r};globalThis.cnCharacterLabel.map=Object.assign(globalThis.cnCharacterLabel.map||{}," + JSON.stringify(characterMap) + ");globalThis.cnCharacterLabel.cache={};globalThis.cnCharacterLabel.keys=Object.keys(globalThis.cnCharacterLabel.map).sort(function(a,b){return b.length-a.length});globalThis.cnCompNames=globalThis.cnCompNames||function(e){var t=globalThis.cnCharacterLabel?globalThis.cnCharacterLabel(e):String(e==null?\"\":e),i=t.lastIndexOf(\", and \");if(i>=0)return t.slice(0,i).replace(/, /g,\"、\")+\"和\"+t.slice(i+6);i=t.lastIndexOf(\" and \");return i>=0?t.slice(0,i)+\"和\"+t.slice(i+5):t};";
  if (!source.includes("globalThis.cnCharacterLabel=globalThis.cnCharacterLabel||function")) source = inject + source;
  const stringOriginal = 'if("string"==typeof _)return O&&v.setDefaultCock(k),d(_),"continue";';
  const stringPatched = 'if("string"==typeof _)return O&&v.setDefaultCock(k),d("compNames"===r&&globalThis.cnCompNames?globalThis.cnCompNames(_):("name"===r||"Name"===r)&&globalThis.cnCharacterLabel?globalThis.cnCharacterLabel(_):_),"continue";';
  const functionOriginals = [
    'var I=g(P,s,u,C,w,v);return d(I),"continue"',
    'var I=g(P,s,l,C,w,v);return d(I),"continue"'
  ];
  const functionPatchedReturn = 'return d("compNames"===r&&globalThis.cnCompNames?globalThis.cnCompNames(I):("name"===r||"Name"===r)&&globalThis.cnCharacterLabel?globalThis.cnCharacterLabel(I):I)';
  const valueOriginals = [
    'return d(B.toString()),"continue"}if("dayNight"===l)',
    'return d(B.toString()),"continue"}if("dayNight"===u)'
  ];
  const valuePatchedReturn = 'return d("compNames"===r&&globalThis.cnCompNames?globalThis.cnCompNames(B.toString()):("name"===r||"Name"===r)&&globalThis.cnCharacterLabel?globalThis.cnCharacterLabel(B.toString()):B.toString())';
  const stringStart = source.indexOf('if ("string" == typeof _)');
  if (stringStart >= 0) {
    const stringEnd = source.indexOf('if (!(r in v))', stringStart);
    let region = source.slice(stringStart, stringEnd > stringStart ? stringEnd : stringStart + 500);
    const call = /\bd\(_\)/;
    if ((region.match(new RegExp(call.source, "g")) || []).length === 1) {
      region = region.replace(call, 'd("compNames"===r&&globalThis.cnCompNames?globalThis.cnCompNames(_):("name"===r||"Name"===r)&&globalThis.cnCharacterLabel?globalThis.cnCharacterLabel(_):_)');
      source = source.slice(0, stringStart) + region + source.slice(stringEnd > stringStart ? stringEnd : stringStart + 500);
    } else console.warn("505: dynamic string name parser hook not found uniquely.");
  } else console.warn("505: dynamic string name parser branch not found.");
  if (!source.includes(functionPatchedReturn)) {
    const functionAnchor = source.indexOf("var I = g(P, s, l, C, w, v)");
    if (functionAnchor < 0) console.warn("505: dynamic function name parser hook not found.");
    else {
      const functionEnd = source.indexOf('if ((O && v.setDefaultCock(k), "boolean" == typeof B))', functionAnchor);
      let region = source.slice(functionAnchor, functionEnd);
      if ((region.match(/\bd\(I\)/g) || []).length !== 1) console.warn("505: dynamic function name output not found uniquely.");
      else {
        region = region.replace(/\bd\(I\)/, 'd("compNames"===r&&globalThis.cnCompNames?globalThis.cnCompNames(I):("name"===r||"Name"===r)&&globalThis.cnCharacterLabel?globalThis.cnCharacterLabel(I):I)');
        source = source.slice(0, functionAnchor) + region + source.slice(functionEnd);
      }
    }
  }
  if (!source.includes(valuePatchedReturn)) {
    const valueMatches = [...source.matchAll(/\bd\(B\.toString\(\)\)/g)];
    if (valueMatches.length !== 1) console.warn("505: dynamic value name parser hook not found uniquely.");
    else source = source.replace(/\bd\(B\.toString\(\)\)/, 'd("compNames"===r&&globalThis.cnCompNames?globalThis.cnCompNames(B.toString()):("name"===r||"Name"===r)&&globalThis.cnCharacterLabel?globalThis.cnCharacterLabel(B.toString()):B.toString())');
  }
  const __cnNameHookCounts = {
    character: source.split("globalThis.cnCharacterLabel?globalThis.cnCharacterLabel").length - 1,
    companionList: source.split("globalThis.cnCompNames?globalThis.cnCompNames").length - 1,
  };
  if (__cnNameHookCounts.character < 4 || __cnNameHookCounts.companionList < 3)
    throw new Error("505 dynamic character mapping hooks incomplete: " + JSON.stringify(__cnNameHookCounts));
  return source;
}

function patch505ItemDisplayLabels(source) {
  const itemMap = displayMapping("cnItemLabel");
  const inject = "globalThis.cnItemLabel=globalThis.cnItemLabel||function(e){var t=String(e||\"\");return Object.prototype.hasOwnProperty.call(globalThis.cnItemLabel.map,t)?globalThis.cnItemLabel.map[t]:t};globalThis.cnItemLabel.map=Object.assign(globalThis.cnItemLabel.map||{}," + JSON.stringify(itemMap) + ");";
  if (!source.includes("globalThis.cnItemLabel=globalThis.cnItemLabel||function")) source = inject + source;
  const replacements = [
    [
      '{key:"nameFancy",value:function(){var e=capitalize(this.name);return this.isUnique()',
      '{key:"nameFancy",value:function(){var e=capitalize(globalThis.cnItemLabel?globalThis.cnItemLabel(this.name):this.name);return this.isUnique()'
    ],
    [
      '{key:"shortFancy",value:function(){var e=capitalize(this.short);return this.isUnique()',
      '{key:"shortFancy",value:function(){var e=capitalize(globalThis.cnItemLabel?globalThis.cnItemLabel(this.short):this.short);return this.isUnique()'
    ]
  ];
  for (const [original, patched] of replacements) {
    source = replaceLooseCode(source, original, patched, { label: "505 item display getter" });
  }
  return source;
}

function patch505StatDisplayLabels(source) {
  const statMap = displayMapping("cnStatLabel");
  if (!Object.keys(statMap).length) {
    console.warn("505: stat display map is empty");
    return source;
  }
  const inject = 'globalThis.cnStatLabel=globalThis.cnStatLabel||function(e){var t=String(e),m=globalThis.cnStatLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnStatLabel.map=Object.assign(globalThis.cnStatLabel.map||{},' + JSON.stringify(statMap) + ');';
  if (!source.includes("globalThis.cnStatLabel=globalThis.cnStatLabel||function")) source = inject + source;
  const original = 'i.createElement("div",null,t?"".concat(t,":"):" ")';
  const patched = 'i.createElement("div",null,t?"".concat(globalThis.cnStatLabel?globalThis.cnStatLabel(t):t,":"):" ")';
  return replaceLooseCode(source, original, patched, { expected: 2, label: "505 stat-label renderer" });
}

function patch673CompanionAffinityLabels(source) {
  const statMap = displayMapping("cnStatLabel");
  if (!Object.keys(statMap).length) {
    console.warn("673: stat display map is empty; companion affinity labels were not mapped");
    return source;
  }
  const inject = 'globalThis.cnStatLabel=globalThis.cnStatLabel||function(e){var t=String(e),m=globalThis.cnStatLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnStatLabel.map=Object.assign(globalThis.cnStatLabel.map||{},' + JSON.stringify(statMap) + ');';
  if (!source.includes("globalThis.cnStatLabel=globalThis.cnStatLabel||function")) source = inject + source;
  const original = 'this.allocStats.map(function(e){return GLOBALS.AFFINITY[e];}).join(", ")';
  const patched = 'this.allocStats.map(function(e){var t=GLOBALS.AFFINITY[e];return globalThis.cnStatLabel?globalThis.cnStatLabel(t):t}).join("、")';
  return replaceLooseCode(source, original, patched, { label: "673 companion affinity renderer", fatal: true });
}

function patch505EquipmentInfoLabels(source) {
  const tagMap = displayMapping("cnItemTagLabel");
  const attackMap = displayMapping("cnAttackTypeLabel");
  const tagInject = 'globalThis.cnItemTagLabel=globalThis.cnItemTagLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnItemTagLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnItemTagLabel.map=Object.assign(globalThis.cnItemTagLabel.map||{},' + JSON.stringify(tagMap) + ');';
  const attackInject = 'globalThis.cnAttackTypeLabel=globalThis.cnAttackTypeLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnAttackTypeLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnAttackTypeLabel.map=Object.assign(globalThis.cnAttackTypeLabel.map||{},' + JSON.stringify(attackMap) + ');';
  if (!source.includes("globalThis.cnItemTagLabel=globalThis.cnItemTagLabel||function")) source = tagInject + source;
  if (!source.includes("globalThis.cnAttackTypeLabel=globalThis.cnAttackTypeLabel||function")) source = attackInject + source;
  const replacements = [
    ['"".concat(capitalize(e).split(/(?=[A-Z])/).join(" "),": ")', '"".concat(globalThis.cnStatLabel?globalThis.cnStatLabel(capitalize(e).split(/(?=[A-Z])/).join(" ")):capitalize(e).split(/(?=[A-Z])/).join(" "),": ")', "equipment stat-label renderer"],
    ["var t=GLOBALS.ITEMTAG_TITLES[e]", "var t=globalThis.cnItemTagLabel(GLOBALS.ITEMTAG_TITLES[e])", "equipment item-tag renderer"],
    ["GLOBALS.ATTACK_TITLES[e]", "globalThis.cnAttackTypeLabel(GLOBALS.ATTACK_TITLES[e])", "equipment attack-type current renderer"],
    ["GLOBALS.ATTACK_TITLES[t]", "globalThis.cnAttackTypeLabel(GLOBALS.ATTACK_TITLES[t])", "equipment attack-type comparison renderer"],
    ["capitalize(GLOBALS.DAMAGE_TITLES[e])", "globalThis.cnDamageTypeLabel?globalThis.cnDamageTypeLabel(capitalize(GLOBALS.DAMAGE_TITLES[e])):capitalize(GLOBALS.DAMAGE_TITLES[e])", "equipment damage-type renderer"],
  ];
  for (const [original, patched, label] of replacements) {
    source = replaceLooseAny(source, original, patched, `505 ${label}`);
  }
  return source;
}

function powerUiLabelHelper(map) {
  return 'globalThis.cnPowerUiLabel=globalThis.cnPowerUiLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnPowerUiLabel.map||{},k=globalThis.cnPowerUiLabel.keys||[];for(var i=0;i<k.length;i++)t=t.split(k[i]).join(m[k[i]]);return t};globalThis.cnPowerUiLabel.map=Object.assign(globalThis.cnPowerUiLabel.map||{},' + JSON.stringify(map) + ');globalThis.cnPowerUiLabel.keys=Object.keys(globalThis.cnPowerUiLabel.map).sort(function(a,b){return b.length-a.length});';
}

function patch103PowerUiLabels(source) {
  const map=displayMapping("cnPowerUiLabel"),inject=powerUiLabelHelper(map);
  if(!source.includes("globalThis.cnPowerUiLabel=globalThis.cnPowerUiLabel||function"))source=inject+source;
  source=replaceLooseAny(source,'r.createElement("span",{className:"className"},e.name)','r.createElement("span",{className:"className"},globalThis.cnPowerUiLabel(e.name))',"103 power class label");
  source=replaceLooseAny(source,'r.createElement("div",null,s[o])','r.createElement("div",null,globalThis.cnPowerUiLabel(s[o]))',"103 power category label");
  source=replaceLooseAny(source,'r.createElement("div",{key:t},"Set ".concat(t))','r.createElement("div",{key:t},globalThis.cnPowerUiLabel("Set").concat(t))',"103 power set label");
  source=replaceLooseAny(source,'r.createElement("span",{className:"underText"},"Corruption")','r.createElement("span",{className:"underText"},globalThis.cnPowerUiLabel("Corruption"))',"103 corruption label");
  source=replaceLooseAny(source,'r.createElement("span",{className:"corruptionTitle"},capitalize(n))','r.createElement("span",{className:"corruptionTitle"},globalThis.cnPowerUiLabel(capitalize(n)))',"103 corruption title");
  return source;
}

function patch505PowerUiLabels(source) {
  const map=displayMapping("cnPowerUiLabel"),inject=powerUiLabelHelper(map);
  if(!source.includes("globalThis.cnPowerUiLabel=globalThis.cnPowerUiLabel||function"))source=inject+source;
  const original='t.slice(0,4).join(" ")',patched='t.slice(0,4).map(globalThis.cnPowerUiLabel).join(" ")';
  return replaceLooseCode(source,original,patched,{label:"505 power tag renderer"});
}


function patch505DamageTypeLabels(source) {
  const map = displayMapping("cnDamageTypeLabel");
  const inject = 'globalThis.cnDamageTypeLabel=globalThis.cnDamageTypeLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnDamageTypeLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnDamageTypeLabel.map=Object.assign(globalThis.cnDamageTypeLabel.map||{},' + JSON.stringify(map) + ');';
  if (!source.includes("globalThis.cnDamageTypeLabel=globalThis.cnDamageTypeLabel||function")) source = inject + source;
  const original = "GLOBALS.DAMAGE_TITLES[a]";
  const patched = "globalThis.cnDamageTypeLabel(GLOBALS.DAMAGE_TITLES[a])";
  if (source.includes(original)) source = source.split(original).join(patched);
  else if (!source.includes(patched)) console.warn("505: damage-title renderer not found; damage type mapping was not applied");
  return source;
}

function patch505PowerDisplayLabels(source) {
  const powerMap = displayMapping("cnPowerLabel");
  const inject = "globalThis.cnPowerLabel=globalThis.cnPowerLabel||function(e){var t=String(e||\"\");return Object.prototype.hasOwnProperty.call(globalThis.cnPowerLabel.map,t)?globalThis.cnPowerLabel.map[t]:t};globalThis.cnPowerLabel.map=Object.assign(globalThis.cnPowerLabel.map||{}," + JSON.stringify(powerMap) + ");";
  if (!source.includes("globalThis.cnPowerLabel=globalThis.cnPowerLabel||function")) source = inject + source;
  const original = "var d=function(e){return e.name.length>15?e.short:e.name}";
  const patched = "var d=function(e){var t=e.name.length>15?e.short:e.name;return globalThis.cnPowerLabel?globalThis.cnPowerLabel(t):t}";
  const selector = /return\s+e\.name\.length\s*>\s*15\s*\?\s*e\.short\s*:\s*e\.name\s*;/g;
  const matches = [...source.matchAll(selector)];
  if (matches.length !== 1) { console.warn(`505 power-card display selector pattern count ${matches.length}, expected 1`); return source; }
  return source.replace(selector, 'var t=e.name.length>15?e.short:e.name;return globalThis.cnPowerLabel?globalThis.cnPowerLabel(t):t;');
}

function patch505InterruptPowerLabel(source) {
  const from = "return\"<b>\".concat(this.owner.getDescription(\"CombatName's\"),\" \").concat(this.name,\"被打断！</b>\")";
  const to = "return\"<b>\".concat(this.owner.getDescription(\"CombatName's\"),\" \").concat(globalThis.cnPowerLabel?globalThis.cnPowerLabel(this.name):this.name,\"被打断！</b>\")";
  return replaceLooseCode(source, from, to, { label: "505 interrupt power display", fatal: true });
}

function effectLabelHelper() {
  const map = displayMapping("cnEffectLabel");
  return 'globalThis.cnEffectLabel=globalThis.cnEffectLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnEffectLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnEffectLabel.map=Object.assign(globalThis.cnEffectLabel.map||{},' + JSON.stringify(map) + ');';
}

function patch103EffectDisplayLabels(source) {
  if (!source.includes("globalThis.cnEffectLabel=globalThis.cnEffectLabel||function")) source = effectLabelHelper() + source;
  const replacements = [
    ['ttH:capitalize(o.name)', 'ttH:globalThis.cnEffectLabel(capitalize(o.name))'],
    ['__html:"<b>".concat(e.name,":</b> ")', '__html:"<b>".concat(globalThis.cnEffectLabel(e.name),":</b> ")'],
    ['concat(d,"回合").concat(d>1?"s":"")', 'concat(d,"回合")'],
    ['concat(n,"回合").concat(n>1?"s":"")', 'concat(n,"回合")']
  ];
  for (const [from, to] of replacements) {
    const expected = from.startsWith('__html:') ? 3 : 1;
    source = replaceLooseCode(source, from, to, { expected, label: `103 effect display: ${from}`, fatal: true });
  }
  return source;
}

function patch505EffectDisplayLabels(source) {
  if (!source.includes("globalThis.cnEffectLabel=globalThis.cnEffectLabel||function")) source = effectLabelHelper() + source;
  const from = 'concat(capitalize(a.name),"影响！</b>")';
  const to = 'concat(globalThis.cnEffectLabel(capitalize(a.name)),"影响！</b>")';
  return replaceLooseCode(source, from, to, { label: "505 effect display", fatal: true });
}

function patch673EviscerateDynamicCount(source) {
  const skillStartMatch = /\)\.name\s*=\s*"Eviscerate"/.exec(source);
  const skillStart = skillStartMatch ? skillStartMatch.index : -1;
  if (skillStart < 0) { console.warn("673: Eviscerate block not found; numeric hit-count patch was not applied."); return source; }
  const skillEndMatch = /\bo\.type\s*=\s*GLOBALS\.POWER_ENCOUNTER\b/g;
  skillEndMatch.lastIndex = skillStart;
  const skillEndFound = skillEndMatch.exec(source);
  const skillEnd = skillEndFound ? skillEndFound.index : -1;
  if (skillEnd < 0) { console.warn("673: Eviscerate block end not found; numeric hit-count patch was not applied."); return source; }
  const block = source.slice(skillStart, skillEnd);
  const original = 'num2Text(o.attacks())';
  const count = block.split(original).length - 1;
  if (count === 0 && block.includes('o.attacks()')) return source;
  if (count !== 1) { console.warn(`673: Eviscerate hit-count expression found ${count} times; patch was not applied.`); return source; }
  return source.slice(0, skillStart) + block.replace(original, 'o.attacks()') + source.slice(skillEnd);
}


function patch505CombatPhrases(source) {
  // Code-safety fixes only. Visible prose now belongs to translated_json.
  const oldBolstered = '(this.getCombatEffect(CEFFECTS.Bolstered)||this.hasStance(POWERS.BolsteringDance))&&(e+=this.getCombatEffect(CEFFECTS.Bolstered).values[0])';
  const safeBolstered = 'this.getCombatEffect(CEFFECTS.Bolstered)&&(e+=this.getCombatEffect(CEFFECTS.Bolstered).values[0])';
  const count = looseCount(source, oldBolstered);
  if (count) source = replaceLooseCode(source, oldBolstered, safeBolstered, { expected: count, label: "505 Bolstered guard", fatal: true, all: true });
  const perkLookup = 'e.getPerk("Arcane Strike")';
  const perkLookupByClass = 'e.getPerk(PERKS.ArcaneStrike)';
  if (source.includes(perkLookup)) source = source.replace(perkLookup, perkLookupByClass);
  return source;
}

function patch673PerkDisplayLabels(source) {
  const map = displayMapping("cnPerkText");
  const inject = 'globalThis.cnPerkText=globalThis.cnPerkText||function(e){var t=String(e),m=globalThis.cnPerkText.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnPerkText.map=Object.assign(globalThis.cnPerkText.map||{},' + JSON.stringify(map) + ');';
  if (!source.includes("globalThis.cnPerkText=globalThis.cnPerkText||function")) source = inject + source;
  const text = '"Permanent bonuses based on starting race, class, and background."';
  const candidates = [];
  for (let at = source.indexOf(text); at >= 0; at = source.indexOf(text, at + text.length)) {
    if (source.slice(at, at + 1200).includes("this.values.forEach")) candidates.push(at);
  }
  if (candidates.length !== 1) throw new Error(`673 Starting Bonuses generator candidate count ${candidates.length}, expected 1`);
  const start = candidates[0];
  const end = source.indexOf('set: function', start);
  if (end < 0 || end - start > 1500) throw new Error("673 Starting Bonuses generator bounds not found");
  let region = source.slice(start, end);
  region = region.replace(text, `globalThis.cnPerkText(${text})`);
  const affinity = 'GLOBALS.AFFINITY[n]';
  if (region.split(affinity).length - 1 !== 1) throw new Error("673 Starting Bonuses affinity value not found uniquely");
  region = region.replace(affinity, 'globalThis.cnPerkText(GLOBALS.AFFINITY[n])');
  return source.slice(0, start) + region + source.slice(end);
}


function patch103DirectionLabels(source) {
  const map = displayMapping("cnDirectionLabel");
  const inject = 'globalThis.cnDirectionLabel=globalThis.cnDirectionLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnDirectionLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnDirectionLabel.map=Object.assign(globalThis.cnDirectionLabel.map||{},' + JSON.stringify(map) + ');';
  if (!source.includes("globalThis.cnDirectionLabel=globalThis.cnDirectionLabel||function")) source = inject + source;
  // Keep North/East/South/West arrays untouched: they are used for input matching.
  const titlePattern = /dangerouslySetInnerHTML:\s*\{\s*__html:\s*this\.props\.title\s*,?\s*\}/g;
  const titleMatches = [...source.matchAll(titlePattern)].length;
  if (titleMatches !== 1) throw new Error("103 direction display title count " + titleMatches + ", expected 1");
  source = source.replace(titlePattern, 'dangerouslySetInnerHTML: { __html: globalThis.cnDirectionLabel ? globalThis.cnDirectionLabel(this.props.title) : this.props.title }');
  const tipPattern = /ttH:\s*this\.props\.ttH\s*\?\s*this\.props\.ttH\s*:\s*this\.props\.title/g;
  const tipMatches = [...source.matchAll(tipPattern)].length;
  if (tipMatches !== 1) throw new Error("103 direction tooltip title count " + tipMatches + ", expected 1");
  source = source.replace(tipPattern, 'ttH: this.props.ttH ? this.props.ttH : (globalThis.cnDirectionLabel ? globalThis.cnDirectionLabel(this.props.title) : this.props.title)');
  return source;
}


function patch673DirectionLabels(source) {
  // Literal direction buttons are handled by patchMappedLiteralButtonLabels.
  // Internal direction keys remain English.
  return source;
}

function patch505CharacterPanelLabels(source) {
  const map = displayMapping("cnCharacterPanelLabel");
  const inject = 'globalThis.cnCharacterPanelLabel=globalThis.cnCharacterPanelLabel||function(e){var t=String(e),m=globalThis.cnCharacterPanelLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnCharacterPanelLabel.map=Object.assign(globalThis.cnCharacterPanelLabel.map||{},' + JSON.stringify(map) + ');';
  if (!source.includes("globalThis.cnCharacterPanelLabel=globalThis.cnCharacterPanelLabel||function")) source = inject + source;
  const likes = '"Likes: ".concat(';
  const dislikes = '"Dislikes: ".concat(';
  if ((source.split(likes).length - 1) !== 1 || (source.split(dislikes).length - 1) !== 1) {
    console.warn("505: Likes/Dislikes display labels not found uniquely");
    return source;
  }
  return source.replace(likes, 'globalThis.cnCharacterPanelLabel("Likes: ").concat(').replace(dislikes, 'globalThis.cnCharacterPanelLabel("Dislikes: ").concat(');
}

function patch673CombatMenuLabels(source) {
  const map = displayMapping("cnCombatMenuLabel");
  if (!Object.keys(map).length) {
    console.warn("673: combat menu map is empty");
    return source;
  }
  const inject = 'globalThis.cnCombatMenuLabel=globalThis.cnCombatMenuLabel||function(e){var t=String(e),m=globalThis.cnCombatMenuLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnCombatMenuLabel.map=Object.assign(globalThis.cnCombatMenuLabel.map||{},' + JSON.stringify(map) + ');';
  if (!source.includes("globalThis.cnCombatMenuLabel=globalThis.cnCombatMenuLabel||function")) source = inject + source;
  // Literal combat buttons are mapped earlier by patchMappedLiteralButtonLabels.
  // Only the computed Flow label still needs this specialized display wrapper.
  const flowOriginal = 'addButton(11,"Flow:".concat(["Player","Manual","Auto"][CombatManager.combatFlow]),';
  const flowPatched = 'addButton(11,globalThis.cnCombatMenuLabel("Flow:".concat(["Player","Manual","Auto"][CombatManager.combatFlow])),';
  const flowBefore = looseCount(source, flowOriginal);
  if (flowBefore) source = replaceLooseCode(source, flowOriginal, flowPatched, { expected: flowBefore, label: "673 combat flow label", fatal: true });
  return source;
}


function patch673GemPuzzleLabels(source) {
  const map = displayMapping("cnGemPuzzleLabel");
  if (!Object.keys(map).length) throw new Error("673: gem puzzle display map is empty");
  const inject = 'globalThis.cnGemPuzzleLabel=globalThis.cnGemPuzzleLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnGemPuzzleLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnGemPuzzleLabel.map=Object.assign(globalThis.cnGemPuzzleLabel.map||{},' + JSON.stringify(map) + ');';
  if (!source.includes("globalThis.cnGemPuzzleLabel=globalThis.cnGemPuzzleLabel||function")) source = inject + source;
  const replacements = [
    ['var r=e.gemType(n),a=G[r],i=e.gemPlaced(n)', 'var r=e.gemType(n),a=globalThis.cnGemPuzzleLabel(G[r]),i=e.gemPlaced(n)'],
    ['.concat(G[u]||"empty")', '.concat(G[u]?globalThis.cnGemPuzzleLabel(G[u]):"空")'],
    ['.concat(G[t+1],": ")', '.concat(globalThis.cnGemPuzzleLabel(G[t+1]),": ")'],
  ];
  for (const [from, to] of replacements) {
    source = replaceLooseCode(source, from, to, {
      expected: 1,
      label: `673 gem puzzle display: ${from}`,
      fatal: true,
    });
  }
  return source;
}


function patch673UiLabels(source) {
  // Mapping helpers only. All visible prose/templates live in translated_json.
  const tattooMap = displayMapping("cnTattooLabel");
  const injectTattoo = 'globalThis.cnTattooLabel=globalThis.cnTattooLabel||function(e){var t=String(e||"");var n=t.toLowerCase();return Object.prototype.hasOwnProperty.call(globalThis.cnTattooLabel.map,n)?globalThis.cnTattooLabel.map[n]:t};globalThis.cnTattooLabel.map=Object.assign(globalThis.cnTattooLabel.map||{},' + JSON.stringify(tattooMap) + ');';
  if (!source.includes("globalThis.cnTattooLabel=globalThis.cnTattooLabel||function")) source = injectTattoo + source;

  const attrMap = displayMapping("cnAttributeLabel673");
  const injectAttr = 'globalThis.cnAttrLabel=globalThis.cnAttrLabel||function(e){var t=String(e==null?"":e),n=t.toLowerCase(),m=globalThis.cnAttrLabel.map||{};return Object.prototype.hasOwnProperty.call(m,n)?m[n]:t};globalThis.cnAttrLabel.map=Object.assign(globalThis.cnAttrLabel.map||{},' + JSON.stringify(attrMap) + ');';
  if (!source.includes("globalThis.cnAttrLabel=globalThis.cnAttrLabel||function")) source = injectAttr + source;

  // Dynamic values inside formatted Appearance text are display-only.
  const appearanceFaceAnchor = source.indexOf("capitalize(e.eyeColor)");
  const appearanceLegAnchor = source.indexOf("capitalize(num2Text(e.legCount))", appearanceFaceAnchor);
  if (appearanceFaceAnchor < 0 || appearanceLegAnchor < 0) throw new Error("673 formatted face/leg Appearance code anchors not found");
  const faceRegionStart = Math.max(0, appearanceFaceAnchor - 500);
  const faceRegionEnd = Math.min(source.length, appearanceLegAnchor + 500);
  let faceRegion = source.slice(faceRegionStart, faceRegionEnd);
  faceRegion = faceRegion
    .replace(/\be\.eyeColor\b/g, "globalThis.cnAttrLabel(e.eyeColor)")
    .replace(/capitalize\(globalThis\.cnAttrLabel\(e\.eyeColor\)\)/g, "globalThis.cnAttrLabel(e.eyeColor)")
    .replace(/capitalize\(num2Text\(e\.legCount\)\)/g, "globalThis.cnAttrLabel(num2Text(e.legCount))");
  source = source.slice(0, faceRegionStart) + faceRegion + source.slice(faceRegionEnd);

  const generalAppearanceEyeAnchor = source.indexOf("capitalize(r.eyeColor)");
  const generalAppearanceLegAnchor = source.indexOf("capitalize(num2Text(r.legCount))", generalAppearanceEyeAnchor);
  if (generalAppearanceEyeAnchor < 0 || generalAppearanceLegAnchor < 0) throw new Error("673 general Appearance code anchors not found");
  const generalAppearanceStart = Math.max(0, generalAppearanceEyeAnchor - 900);
  const generalAppearanceEnd = Math.min(source.length, generalAppearanceLegAnchor + 1400);
  let generalAppearanceRegion = source.slice(generalAppearanceStart, generalAppearanceEnd);
  generalAppearanceRegion = generalAppearanceRegion
    .replace(/\br\.eyeColor\b/g, "globalThis.cnAttrLabel(r.eyeColor)")
    .replace(/capitalize\(globalThis\.cnAttrLabel\(r\.eyeColor\)\)/g, "globalThis.cnAttrLabel(r.eyeColor)")
    .replace(/capitalize\(num2Text\(r\.legCount\)\)/g, "globalThis.cnAttrLabel(num2Text(r.legCount))")
    .replace(/\br\.mouthDesc\(([^)]*)\)/g, "globalThis.cnBodyLabel(r.mouthDesc($1))")
    .replace(/\br\.legs\(([^)]*)\)/g, "globalThis.cnBodyLabel(r.legs($1))")
    .replace(/\br\.leg\(([^)]*)\)/g, "globalThis.cnBodyLabel(r.leg($1))")
    .replace(/\br\.feetDesc\(([^)]*)\)/g, "globalThis.cnBodyLabel(r.feetDesc($1))")
    .replace(/\br\.foot\(([^)]*)\)/g, "globalThis.cnBodyLabel(r.foot($1))");
  source = source.slice(0, generalAppearanceStart) + generalAppearanceRegion + source.slice(generalAppearanceEnd);

  // Catfolk Appearance uses a separate local variable and therefore needs its own
  // display-only wrappers. Stored colors and descriptors remain unchanged.
  const catAppearanceStart = source.indexOf("你的双眼有着竖直的狭缝状瞳孔");
  const catAppearanceEnd = source.indexOf("case 8:", catAppearanceStart);
  if (catAppearanceStart < 0 || catAppearanceEnd < 0) throw new Error("673 catfolk Appearance anchors not found");
  let catAppearanceRegion = source.slice(catAppearanceStart, catAppearanceEnd);
  catAppearanceRegion = catAppearanceRegion
    .replace(/\br\.eyeColor\b/g, "globalThis.cnAttrLabel(r.eyeColor)")
    .replace(/\br\.furColor\b/g, "globalThis.cnAttrLabel(r.furColor)")
    .replace(/\br\.scaleColor\b/g, "globalThis.cnAttrLabel(r.scaleColor)")
    .replace(/\br\.hairDesc\(!0,\s*!0\)/g, "globalThis.cnBodyLabel(r.hairDesc(!0,!0))")
    .replace(/\br\.buttDesc\(\)/g, "globalThis.cnBodyLabel(r.buttDesc())")
    .replace(/capitalize\(num2Text\(r\.numTails\)\)/g, 'globalThis.cnAttrLabel(num2Text(r.numTails)) + "条"')
    .replace(/" "\s*\+\s*globalThis\.cnAttrLabel\(num2Text\(r\.numTails\)\)\s*\+\s*"条"/g, 'globalThis.cnAttrLabel(num2Text(r.numTails)) + "条"');
  source = source.slice(0, catAppearanceStart) + catAppearanceRegion + source.slice(catAppearanceEnd);

  // Equine and fox tail descriptions are assembled from translated literal fragments
  // plus dynamic colors/body descriptors. Map only those values at display time.
  const equineTailColorAnchor = source.indexOf("t.hairColor");
  const equineTailEnd = source.indexOf("case 8:", equineTailColorAnchor);
  if (equineTailColorAnchor < 0 || equineTailEnd < 0) throw new Error("673 equine tail Appearance anchors not found");
  const equineTailStart = Math.max(0, equineTailColorAnchor - 180);
  let equineTailRegion = source.slice(equineTailStart, equineTailEnd);
  if ((equineTailRegion.match(/t\.hairColor/g) ?? []).length !== 1 || (equineTailRegion.match(/t\.buttDesc\(\)/g) ?? []).length !== 1)
    throw new Error("673 equine tail dynamic value counts changed");
  equineTailRegion = equineTailRegion
    .replace(/t\.hairColor/g, "globalThis.cnAttrLabel(t.hairColor)")
    .replace(/t\.buttDesc\(\)/g, "globalThis.cnBodyLabel(t.buttDesc())");
  source = source.slice(0, equineTailStart) + equineTailRegion + source.slice(equineTailEnd);

  const foxTailNumberAnchor = source.indexOf("capitalize(num2Text(t.numTails))", equineTailEnd);
  const foxTailStart = source.lastIndexOf("case 7:", foxTailNumberAnchor);
  const foxTailEnd = source.indexOf("case 8:", foxTailNumberAnchor);
  if (foxTailNumberAnchor < 0 || foxTailStart < 0 || foxTailEnd < 0) throw new Error("673 fox tail Appearance anchors not found");
  let foxTailRegion = source.slice(foxTailStart, foxTailEnd);
  const foxCounts = {
    fur: (foxTailRegion.match(/t\.furColor/g) ?? []).length,
    butt: (foxTailRegion.match(/t\.buttDesc\(\)/g) ?? []).length,
    count: (foxTailRegion.match(/capitalize\(num2Text\(t\.numTails\)\)/g) ?? []).length,
  };
  if (foxCounts.fur !== 2 || foxCounts.butt !== 4 || foxCounts.count !== 2)
    throw new Error("673 fox tail dynamic value counts changed: " + JSON.stringify(foxCounts));
  foxTailRegion = foxTailRegion
    .replace(/t\.furColor/g, "globalThis.cnAttrLabel(t.furColor)")
    .replace(/t\.buttDesc\(\)/g, "globalThis.cnBodyLabel(t.buttDesc())")
    .replace(/capitalize\(num2Text\(t\.numTails\)\)/g, "globalThis.cnAttrLabel(num2Text(t.numTails))");
  source = source.slice(0, foxTailStart) + foxTailRegion + source.slice(foxTailEnd);

  // Cow-tail prose is translated as JSON fragments. Map only the dynamic count
  // shown between those fragments; the stored tail count remains untouched.
  const cowTailTextAnchor = source.indexOf("一条长长的牛尾，末端有一簇");
  const cowTailEnd = source.indexOf("case 8:", cowTailTextAnchor);
  if (cowTailTextAnchor < 0 || cowTailEnd < 0) throw new Error("673 cow-tail Appearance anchors not found");
  const cowTailStart = Math.max(0, cowTailTextAnchor - 180);
  let cowTailRegion = source.slice(cowTailStart, cowTailEnd);
  const cowTailCount = (cowTailRegion.match(/capitalize\(num2Text\(e\.numTails\)\)/g) ?? []).length;
  if (cowTailCount !== 1) throw new Error("673 cow-tail dynamic count changed: " + cowTailCount);
  cowTailRegion = cowTailRegion
    .replace(/capitalize\(num2Text\(e\.numTails\)\)/g, "globalThis.cnAttrLabel(num2Text(e.numTails))")
    .replace(/" "\s*\+\s*globalThis\.cnAttrLabel\(num2Text\(e\.numTails\)\)/g, "globalThis.cnAttrLabel(num2Text(e.numTails))");
  source = source.slice(0, cowTailStart) + cowTailRegion + source.slice(cowTailEnd);

  // Elven ears use a dynamic head noun. Translate only that visible return value.
  const elfAppearanceStart = source.indexOf("几乎遮住了那对略带尖角、近似人类的耳朵");
  const elfAppearanceLast = source.indexOf("附近还有两根触角从你的头顶伸出。", elfAppearanceStart);
  if (elfAppearanceStart < 0 || elfAppearanceLast < elfAppearanceStart) throw new Error("673 elven Appearance anchors not found");
  const elfAppearanceEnd = Math.min(source.length, elfAppearanceLast + 250);
  let elfAppearanceRegion = source.slice(elfAppearanceStart, elfAppearanceEnd);
  elfAppearanceRegion = elfAppearanceRegion.replace(/\bu\(e\)/g, "globalThis.cnBodyLabel(u(e))");
  source = source.slice(0, elfAppearanceStart) + elfAppearanceRegion + source.slice(elfAppearanceEnd);

  // 673 face-intro spacing anchor: Chinese does not need a separator before the dynamic skin description.
  const faceIntroPattern = /("human" !== e\.race\(\)\s*\?\s*"并且你有"\s*:\s*"有着",)\s*" ",/g;
  const faceIntroCount = [...source.matchAll(faceIntroPattern)].length;
  if (faceIntroCount !== 1) throw new Error("673 face-intro spacing pattern count " + faceIntroCount + ", expected 1");
  source = source.replace(faceIntroPattern, '$1 "",');

  const chestStart = source.indexOf("num2Text(e.breastRows[0].breasts)");
  const chestLast = source.lastIndexOf("num2Text(e.nipplesPerBreast)");
  if (chestStart < 0 || chestLast < chestStart) throw new Error("673 formatted chest Appearance code anchors not found");
  const chestRegionEnd = Math.min(source.length, chestLast + 1200);
  let chestRegion = source.slice(chestStart, chestRegionEnd);
  chestRegion = chestRegion
    .replace(/num2Text\(e\.breastRows\[0\]\.breasts\)/g, "globalThis.cnAttrLabel(num2Text(e.breastRows[0].breasts))")
    .replace(/num2Text\(e\.breastRows\[n\]\.breasts\)/g, "globalThis.cnAttrLabel(num2Text(e.breastRows[n].breasts))")
    .replace(/num2Text\(e\.nipplesPerBreast\)/g, "globalThis.cnAttrLabel(num2Text(e.nipplesPerBreast))")
    .replace(/\be\.breastDesc\(([^)]*)\)/g, "globalThis.cnBodyLabel(e.breastDesc($1))")
    .replace(/(globalThis\.cnAttrLabel\(num2Text\(e\.breastRows\[(?:0|n)\]\.breasts\)\))\s*\+\s*" "\s*\+\s*(globalThis\.cnBodyLabel\(e\.breastDesc\([^)]*\)\))/g, "$1 + \"只\" + $2")
    .replace(/\be\.nippleDesc\(([^)]*)\)/g, "globalThis.cnBodyLabel(e.nippleDesc($1))")
    .replace(/\be\.areolaSizeDesc\(\)/g, "globalThis.cnAttrLabel(e.areolaSizeDesc())")
    .replace(/\be\.nippleColor\b/g, "globalThis.cnAttrLabel(e.nippleColor)");
  source = source.slice(0, chestStart) + chestRegion + source.slice(chestRegionEnd);

  // Map dynamic genital/anal descriptors only inside the formatted Appearance generator.
  const genitalStart = source.indexOf("e.hasBushel()");
  const genitalLast = genitalStart < 0 ? -1 : source.indexOf("e.assholeDesc(!0)", genitalStart);
  if (genitalStart < 0 || genitalLast < genitalStart) throw new Error("673 formatted genital Appearance anchors not found");
  const genitalEnd = Math.min(source.length, genitalLast + 300);
  let genitalRegion = source.slice(genitalStart, genitalEnd);
  genitalRegion = genitalRegion
    .replace(/\be\.simpleCockNoun\(([^)]*)\)/g, "globalThis.cnBodyLabel(e.simpleCockNoun($1))")
    .replace(/\be\.multiCockDesc\(([^)]*)\)/g, "globalThis.cnBodyLabel(e.multiCockDesc($1))")
    .replace(/\be\.assholeDesc\(([^)]*)\)/g, "globalThis.cnBodyLabel(e.assholeDesc($1))")
    .replace(/\be\.vaginaDesc\(([^)]*)\)/g, "globalThis.cnBodyLabel(e.vaginaDesc($1))")
    .replace(/num2Text\(e\.vagina\.clits\)/g, "globalThis.cnAttrLabel(num2Text(e.vagina.clits))")
    .replace(/e\.vagina\.clits > 1 && \(t \+= "s"\)/g, 'e.vagina.clits > 1 && (t += "")');
  source = source.slice(0, genitalStart) + genitalRegion + source.slice(genitalEnd);

  // The mottled-color comparison remains English; only the fallback color value is mapped for display.
  const mottledAnchor = source.indexOf('"mottled pink and black" === t.cocks[r].color');
  if (mottledAnchor < 0) throw new Error("673 mottled cock-color Appearance anchor not found");
  const mottledEnd = Math.min(source.length, mottledAnchor + 500);
  let mottledRegion = source.slice(mottledAnchor, mottledEnd);
  const colorMatches = [...mottledRegion.matchAll(/(?<!=== )t\.cocks\[r\]\.color/g)].length;
  if (colorMatches !== 1) throw new Error("673 mottled fallback color display count " + colorMatches + ", expected 1");
  mottledRegion = mottledRegion.replace(/(?<!=== )t\.cocks\[r\]\.color/, "globalThis.cnAttrLabel(t.cocks[r].color)");
  source = source.slice(0, mottledAnchor) + mottledRegion + source.slice(mottledEnd);

  // DEMON_HUE is an internal flag value; map only the value passed to the visible template.
  const demonHueAnchor = source.indexOf("一抹淡淡的");
  if (demonHueAnchor < 0) throw new Error("673 demon hue display anchor not found");
  const demonHueValue = source.indexOf("flags.DEMON_HUE", demonHueAnchor);
  if (demonHueValue < 0 || demonHueValue - demonHueAnchor > 1800)
    throw new Error("673 visible demon hue value not found near translated template");
  source =
    source.slice(0, demonHueValue) +
    "globalThis.cnAttrLabel(flags.DEMON_HUE)" +
    source.slice(demonHueValue + "flags.DEMON_HUE".length);

  // Apply word-level mappings only to descriptor values as they are displayed
  // by the formatted Appearance generator; never change stored attributes.
  const wrappers = [
    [/\be\.hairDesc\(!0,\s*!0\)/g, '(globalThis.cnBodyLabel?globalThis.cnBodyLabel(e.hairDesc(!0,!0)):e.hairDesc(!0,!0))'],
    [/\be\.faceDesc\(\)/g, '(globalThis.cnBodyLabel?globalThis.cnBodyLabel(e.faceDesc()):e.faceDesc())'],
    [/\be\.hipDesc\(!0\)/g, '(globalThis.cnBodyLabel?globalThis.cnBodyLabel(e.hipDesc(!0)):e.hipDesc(!0))'],
    [/\be\.buttDesc\(\)/g, '(globalThis.cnBodyLabel?globalThis.cnBodyLabel(e.buttDesc()):e.buttDesc())'],
  ];
  for (const [pattern, replacement] of wrappers) source = source.replace(pattern, (whole, offset, full) => full.slice(Math.max(0, offset - 35), offset).includes("globalThis.cnBodyLabel") ? whole : replacement);
  return source;
}

function patchContentOtherCreationUi(source) {
  // All creation attributes remain English internally. Only values passed to
  // visible buttons/dropdowns are mapped here.
  const labelMap = displayMapping("cnCreationLabel");
  const inject = "window.cnCreateLabel=window.cnCreateLabel||function(e){var t=String(e==null?\"\":e),m=window.cnCreateLabel.map||{},k=t.toLowerCase();return Object.prototype.hasOwnProperty.call(m,k)?m[k]:t};window.cnCreateLabel.map=Object.assign(window.cnCreateLabel.map||{}," + JSON.stringify(labelMap) + ");";
  if (!source.includes("window.cnCreateLabel=window.cnCreateLabel||function")) source = inject + source;
  const exampleInject = 'globalThis.cnBodyExampleLabel=globalThis.cnBodyExampleLabel||function(e){return String(e==null?"":e).split(/;\\s*/).map(function(x){return globalThis.cnBodyLabel?globalThis.cnBodyLabel(x):x}).join("；")};';
  if (!source.includes("globalThis.cnBodyExampleLabel=globalThis.cnBodyExampleLabel||function")) source = exampleInject + source;
  for (const expression of ["M.belly.desc", "M.hips.desc", "M.butt.desc", "W.cock.desc", "W.breast.desc"]) {
    const count = source.split(expression).length - 1;
    if (count !== 1) throw new Error("Content_Other body example expression count " + count + ", expected 1: " + expression);
    source = source.replace(expression, "globalThis.cnBodyExampleLabel(" + expression + ")");
  }

  const callbacks = ["ChooseHairColor", "ChooseEyeColor", "ChooseHeight"];
  for (const callback of callbacks) {
    const pattern = new RegExp("capitalize\\(e\\)(?=,\\s*function\\s*\\(\\)\\s*\\{\\s*return\\s+" + callback + "\\(e\\);?\\s*\\})", "g");
    let count = 0;
    source = source.replace(pattern, () => { count++; return "window.cnCreateLabel(e)"; });
    if (count !== 1) throw new Error("Content_Other dynamic creation label " + callback + " count " + count + ", expected 1");
  }

  let dropdownCount = 0;
  source = source.replace(
    /(addDropdown\(\s*(?:"Hairstyles:"|"发型：")\s*,\s*i\.map\(function \(e\) \{\s*return\s+)e\.style(;\s*\}\)\s*,\s*)s\.style(\s*,)/g,
    (_, prefix, middle, suffix) => { dropdownCount++; return prefix + "window.cnCreateLabel(e.style)" + middle + "window.cnCreateLabel(s.style)" + suffix; },
  );
  if (dropdownCount !== 1) throw new Error("Content_Other hairstyle dropdown mapping count " + dropdownCount + ", expected 1");

  // Literal race/background/class/sex buttons are display text only.
  const startMatch = /window\.ChooseRace\s*=\s*function/.exec(source);
  const tail = startMatch ? source.slice(startMatch.index) : "";
  const endMatch = /window\.ChooseGender\s*=\s*function/.exec(tail);
  if (startMatch && endMatch) {
    const start = startMatch.index;
    const end = start + endMatch.index;
    const region = source.slice(start, end).replace(
      /(addButton\(\s*[^,]+,\s*)"([^"]+)"/g,
      (full, prefix, label) => Object.prototype.hasOwnProperty.call(labelMap, label.toLowerCase())
        ? prefix + "window.cnCreateLabel(" + JSON.stringify(label) + ")"
        : full,
    );
    source = source.slice(0, start) + region + source.slice(end);
  }
  return source;
}

function patch505ParserPronouns(source) {
  // English possessives are display-only parser forms; Chinese names do not take 's.
  const namePossessive = 'case"names":case"name\'s":return"".concat(this.name,"\'").concat("s"===this.name.slice(-1)?"":"s")';
  const nameDisplay = 'case"names":case"name\'s":return this.name';
  source = replaceLooseCode(source, namePossessive, nameDisplay, { label: "505 name possessive parser", fatal: true });
  const combatPossessive = 'return this.isPC()?"".concat(r).concat(i("r")):"".concat(r).concat(i("\'".concat("s"===r.slice(-1)?"":"s")))';
  const combatDisplay = 'return this.isPC()?"你的":"".concat(r).concat(i("的"))';
  source = replaceLooseCode(source, combatPossessive, combatDisplay, { label: "505 combat name possessive parser", fatal: true });
  source = replaceLooseAny(source,
    'case"his":case"hisHer":return this.mf("his","her");case"hisHers":return this.mf("his","hers");case"combatHis":case"combatHisHer":return this.pcplmf("your","their","his","her");case"combatHisHers":return this.pcplmf("yours","theirs","his","hers");',
    'case"his":case"hisHer":return this.mf("他的","她的");case"hisHers":return this.mf("他的","她的");case"combatHis":case"combatHisHer":return this.pcplmf("你的","他们的","他的","她的");case"combatHisHers":return this.pcplmf("你的","他们的","他的","她的");'
  );
  source = replaceLooseAny(source,
    'case"man":case"woman":case"manWoman":return this.mf("man","woman");',
    'case"man":case"woman":case"manWoman":var __cnmw=this.mf("man","woman");return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnmw):__cnmw;'
  );
  source = replaceLooseAny(source,
    'case"him":case"himHer":return this.mf("him","her");case"boy":case"girl":case"boyGirl":return this.mf("boy","girl");case"master":case"mistress":return this.mf("master","mistress");case"combatHim":case"combatHimHer":return this.pcplmf("you","them","him","her");case"combatHimself":case"combatHerself":case"combatHimselfHerself":return this.pcplmf("yourself","themselves","himself","herself");case"himself":case"herself":case"himselfHerself":return this.mf("himself","herself");case"he":case"she":case"heShe":return this.mf("he","she");case"hes":case"shes":case"hesShes":return this.mf("he\'s","she\'s");case"combatHe":case"combatShe":case"combatHeShe":return this.pcplmf("you","they","he","she");case"combatHe\'s":case"combatShe\'s":case"combatHe\'sShe\'s":case"combatHes":case"combatShes":case"combatHesShes":return this.pcplmf("you\'re","they\'re","he\'s","she\'s");',
    'case"him":case"himHer":return this.mf("他","她");case"boy":case"girl":case"boyGirl":return this.mf("男孩","女孩");case"master":case"mistress":return this.mf("主人","女主人");case"combatHim":case"combatHimHer":return this.pcplmf("你","他们","他","她");case"combatHimself":case"combatHerself":case"combatHimselfHerself":return this.pcplmf("你自己","他们自己","他自己","她自己");case"himself":case"herself":case"himselfHerself":return this.mf("他自己","她自己");case"he":case"she":case"heShe":return this.mf("他","她");case"hes":case"shes":case"hesShes":return this.mf("他","她");case"combatHe":case"combatShe":case"combatHeShe":return this.pcplmf("你","他们","他","她");case"combatHe\'s":case"combatShe\'s":case"combatHe\'sShe\'s":case"combatHes":case"combatShes":case"combatHesShes":return this.pcplmf("你","他们","他","她");'
  );
  return source;
}


function patch505DynamicAttributeLabels(source) {
  const attrMap = displayMapping("cnAttributeLabel");
  const injectAttr = 'globalThis.cnAttrLabel=globalThis.cnAttrLabel||function(e){var t=String(e==null?"":e),n=t.toLowerCase(),m=globalThis.cnAttrLabel.map||{};return Object.prototype.hasOwnProperty.call(m,n)?m[n]:t};globalThis.cnAttrLabel.map=Object.assign(globalThis.cnAttrLabel.map||{},' + JSON.stringify(attrMap) + ');';
  if (!source.includes("globalThis.cnAttrLabel=globalThis.cnAttrLabel||function")) source = injectAttr + source;
  const bodyMap = displayMapping("cnBodyLabel");
  const injectBody = 'globalThis.cnBodyLabel=globalThis.cnBodyLabel||function(e){var bm=globalThis.cnBodyLabel.map||{},am=globalThis.cnAttrLabel&&globalThis.cnAttrLabel.map||{},all=Object.assign({},am,bm),parts=String(e==null?"":e).split(/([,，]\\s*)/),out="";for(var p=0;p<parts.length;p++){var part=parts[p];if(/^[,，]\\s*$/.test(part))continue;var core=part.trim();if(!core){out+=part;continue}var exact=core.toLowerCase();if(Object.prototype.hasOwnProperty.call(all,exact)){out+=all[exact];continue}var words=core.split(/\\s+/),vals=[];for(var i=0;i<words.length;){var hit=null,take=0;for(var len=Math.min(4,words.length-i);len>0;len--){var key=words.slice(i,i+len).join(" ").toLowerCase();if(Object.prototype.hasOwnProperty.call(all,key)){hit=all[key];take=len;break}}if(hit===null){hit=words[i];take=1}vals.push(hit);i+=take}out+=vals.join("")}if(all.lips)out=out.replace(/(^|[^A-Za-z])lips(?=$|[^A-Za-z])/gi,function(_,pre){return pre+all.lips});if(all.lip)out=out.replace(/(^|[^A-Za-z])lip(?=$|[^A-Za-z])/gi,function(_,pre){return pre+all.lip});return out.replace(/([\\u4e00-\\u9fff])\\s+([\\u4e00-\\u9fff])/g,"$1$2")};globalThis.cnBodyLabel.map=Object.assign(globalThis.cnBodyLabel.map||{},' + JSON.stringify(bodyMap) + ');';
  if (!source.includes("globalThis.cnBodyLabel=globalThis.cnBodyLabel||function")) source = injectBody + source;
  const fluidMap = displayMapping("cnFluidLabel");
  const injectFluid = 'globalThis.cnFluidLabel=globalThis.cnFluidLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnFluidLabel.map||{},words=t.trim().split(/\s+/),out=[];for(var i=0;i<words.length;){var hit=null,take=0;for(var len=Math.min(3,words.length-i);len>0;len--){var key=words.slice(i,i+len).join(" ").toLowerCase();if(Object.prototype.hasOwnProperty.call(m,key)){hit=m[key];take=len;break}}if(hit===null){hit=words[i];take=1}out.push(hit);i+=take}return out.join("")};globalThis.cnFluidLabel.map=Object.assign(globalThis.cnFluidLabel.map||{},' + JSON.stringify(fluidMap) + ');';
  if (!source.includes("globalThis.cnFluidLabel=globalThis.cnFluidLabel||function")) source = injectFluid + source;

  const parserMappings = [
    [/case\s+"skinColor":\s*return\s+this\.skinColor\s*;/g, 'case "skinColor": return globalThis.cnAttrLabel ? globalThis.cnAttrLabel(this.skinColor) : this.skinColor;'],
    [/case\s+"class":\s*return\s+this\.getClassName\(\)\s*;/g, 'case "class": { const __v=this.getClassName(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"background":\s*return\s+this\.getBackgroundName\(\)\s*;/g, 'case "background": { const __v=this.getBackgroundName(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"race":\s*return\s+this\.race\(\)\s*;/g, 'case "race": { const __v=this.race(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"raceAdjective":\s*case\s+"raceAdj":\s*case\s+"raceish":\s*return\s+this\.raceAdj\(\)\s*;/g, 'case "raceAdjective": case "raceAdj": case "raceish": { const __v=this.raceAdj(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"raceCute":\s*return\s+this\.raceCute\(\)\s*;/g, 'case "raceCute": { const __v=this.raceCute(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"raceShort":\s*return\s+this\.raceShort\(\)\s*;/g, 'case "raceShort": { const __v=this.raceShort(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"gender":\s*case\s+"sex":\s*return\s+this\.sex\(\)\s*;/g, 'case "gender": case "sex": { const __v=this.sex(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"hairColor":\s*return\s+this\.hairColor\s*;/g, 'case "hairColor": return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.hairColor):this.hairColor;'],
    [/case\s+"cum":\s*return\s+this\.cumDesc\(\)\s*;/g, 'case "cum": { const __v=this.cumDesc(); return globalThis.cnFluidLabel?globalThis.cnFluidLabel(__v):__v; }'],
    [/case\s+"cumColor":\s*return\s+this\.fluidColor\(this\.cumType\)\s*;/g, 'case "cumColor": { const __v=this.fluidColor(this.cumType); return globalThis.cnFluidLabel?globalThis.cnFluidLabel(__v):__v; }'],
    [/case\s+"cumType":\s*case\s+"cumNoun":\s*return\s+this\.fluidNoun\(this\.cumType\)\s*;/g, 'case "cumType": case "cumNoun": { const __v=this.fluidNoun(this.cumType); return globalThis.cnFluidLabel?globalThis.cnFluidLabel(__v):__v; }'],
    [/case\s+"milk":\s*return\s+this\.milkDesc\(\)\s*;/g, 'case "milk": { const __v=this.milkDesc(); return globalThis.cnFluidLabel?globalThis.cnFluidLabel(__v):__v; }'],
    [/case\s+"milkColor":\s*return\s+this\.fluidColor\(this\.milkType\)\s*;/g, 'case "milkColor": { const __v=this.fluidColor(this.milkType); return globalThis.cnFluidLabel?globalThis.cnFluidLabel(__v):__v; }'],
    [/case\s+"milkNoun":\s*case\s+"milkType":\s*return\s+this\.fluidNoun\(this\.milkType\)\s*;/g, 'case "milkNoun": case "milkType": { const __v=this.fluidNoun(this.milkType); return globalThis.cnFluidLabel?globalThis.cnFluidLabel(__v):__v; }'],
    [/case\s+"hair":\s*return\s+this\.hairDesc\(\)\s*;/g, 'case "hair": { const __v=this.hairDesc(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"eye":/g, 'case "eyeColor": return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.eyeColor):this.eyeColor; case "eye":'],
    [/case\s+"skinFurScalesColor":\s*return\s+this\.skinFurScalesColor\(\)\s*;/g, 'case "furColor": return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.furColor):this.furColor; case "scaleColor": return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.scaleColor):this.scaleColor; case "skinFurScalesColor": { const __v=this.skinFurScalesColor(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"beard":\s*return\s+this\.beardDesc\(\)\s*;/g, 'case "beard": { const __v=this.beardDesc(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"lipColor":\s*return\s+this\.lipColor\s*;/g, 'case "lipColor": return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.lipColor):this.lipColor;'],
    [/case\s+"lips":\s*return\s+this\.lipsDesc\(\)\s*;/g, 'case "lips": { const __v=this.lipsDesc(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"lipsChaste":\s*return\s+this\.lipsDesc\(!1,\s*!0\)\s*;/g, 'case "lipsChaste": { const __v=this.lipsDesc(!1,!0); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"lip":\s*return\s+this\.lipDesc\(\)\s*;/g, 'case "lip": { const __v=this.lipDesc(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"lipChaste":\s*return\s+this\.lipDesc\(!1,\s*!0\)\s*;/g, 'case "lipChaste": { const __v=this.lipDesc(!1,!0); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"femcum":\s*case\s+"femCum":\s*case\s+"girlCum":\s*case\s+"girlcum":\s*return\s+this\.girlCumDesc\(\)\s*;/g, 'case "femcum": case "femCum": case "girlCum": case "girlcum": { const __v=this.girlCumDesc(); return globalThis.cnFluidLabel?globalThis.cnFluidLabel(__v):__v; }'],
    [/case\s+"stomach":\s*case\s+"tummy":\s*case\s+"belly":\s*return\s+this\.bellyDesc\(\)\s*;/g, 'case "stomach": case "tummy": case "belly": { const __v=this.bellyDesc(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"bellySize":\s*return\s+this\.bellyDesc\(!0\)\s*;/g, 'case "bellySize": { const __v=this.bellyDesc(!0); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"dick":\s*case\s+"cock":\s*return\s+this\.cockDesc\(t\[0\]\)\s*;/g, 'case "dick": case "cock": { const __v=this.cockDesc(t[0]); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"cockNoun":\s*return\s+this\.simpleCockNoun\(t\[0\]\)\s*;/g, 'case "cockNoun": { const __v=this.simpleCockNoun(t[0]); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"anus":\s*case\s+"assholeDesc":\s*case\s+"asshole":\s*return\s+this\.assholeDesc\(\)\s*;/g, 'case "anus": case "assholeDesc": case "asshole": { const __v=this.assholeDesc(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"anusSimple":\s*case\s+"assholeSimple":\s*case\s+"anusNoun":\s*case\s+"assholeNoun":\s*return\s+this\.assholeDesc\(!0\)\s*;/g, 'case "anusSimple": case "assholeSimple": case "anusNoun": case "assholeNoun": { const __v=this.assholeDesc(!0); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"startingRace":\s*case\s+"originalRace":\s*return\s+this\.originalRace\s*;/g, 'case "startingRace": case "originalRace": return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.originalRace):this.originalRace;'],
    [/case\s+"bodyType":\s*case\s+"bodyShape":\s*case\s+"physique":\s*return\s+this\.bodyShape\(\)\s*;/g, 'case "bodyType": case "bodyShape": case "physique": { const __v=this.bodyShape(); return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__v):__v; }'],
    [/case\s+"tongue":\s*return\s+this\.tongueDesc\(\)\s*;/g, 'case "tongue": { const __v=this.tongueDesc(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"tongueNoun":\s*return\s+this\.tongueNoun\(\)\s*;/g, 'case "tongueNoun": { const __v=this.tongueNoun(); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"tongueNounSimple":\s*return\s+this\.tongueNoun\(!0\)\s*;/g, 'case "tongueNounSimple": { const __v=this.tongueNoun(!0); return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__v):__v; }'],
    [/case\s+"backTattoo":\s*return\s+this\.getBackTattoo\(\)\s*;/g, 'case "backTattoo": { const __v=this.getBackTattoo(); return globalThis.cnTattooLabel?globalThis.cnTattooLabel(__v):__v; }'],
    [/case\s+"collarTattoo":\s*return\s+this\.getCollarTattoo\(\)\s*;/g, 'case "collarTattoo": { const __v=this.getCollarTattoo(); return globalThis.cnTattooLabel?globalThis.cnTattooLabel(__v):__v; }'],
    [/case\s+"shoulderTattoo":\s*return\s+this\.getShoulderTattoo\(\)\s*;/g, 'case "shoulderTattoo": { const __v=this.getShoulderTattoo(); return globalThis.cnTattooLabel?globalThis.cnTattooLabel(__v):__v; }'],
    [/case\s+"sleeveTattoo":\s*return\s+this\.getSleeveTattoo\(\)\s*;/g, 'case "sleeveTattoo": { const __v=this.getSleeveTattoo(); return globalThis.cnTattooLabel?globalThis.cnTattooLabel(__v):__v; }'],
    [/case\s+"legTattoo":\s*return\s+this\.getLegTattoo\(\)\s*;/g, 'case "legTattoo": { const __v=this.getLegTattoo(); return globalThis.cnTattooLabel?globalThis.cnTattooLabel(__v):__v; }'],
    [/case\s+"chestTattoo":\s*return\s+this\.getChestTattoo\(\)\s*;/g, 'case "chestTattoo": { const __v=this.getChestTattoo(); return globalThis.cnTattooLabel?globalThis.cnTattooLabel(__v):__v; }'],
  ];
  for (const [pattern, replacement] of parserMappings) {
    const count = [...source.matchAll(pattern)].length;
    if (count > 1) throw new Error("505 attribute mapping matched " + count + " times: " + pattern);
    if (count === 1) source = source.replace(pattern, replacement);
  }
  source = source.replace(/(?<!cnBodyLabel\()this\.beardDesc\(\)/g, "globalThis.cnBodyLabel(this.beardDesc())");
  source = replaceLooseCode(source, 'case"eyes":return plural(this.eyeDesc());', 'case"eyes":var __cnEyeDesc=plural(this.eyeDesc());return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__cnEyeDesc):__cnEyeDesc;', { label: "505 eye-description display", fatal: true });
  source = replaceLooseCode(source, '1===this.balls||a||(r+="s"),r', '1===this.balls||a||(r+="s"),globalThis.cnBodyLabel?globalThis.cnBodyLabel(r):r', { label: "505 balls description display" });
  source = replaceLooseCode(source, 'i+this.skinNoun(a,n)', '(globalThis.cnBodyLabel?globalThis.cnBodyLabel(i+this.skinNoun(a,n)):i+this.skinNoun(a,n))', { label: "505 skin description display" });
  const __cnDynamicHookCounts = {
    attribute: source.split("globalThis.cnAttrLabel?globalThis.cnAttrLabel").length - 1,
    body: source.split("globalThis.cnBodyLabel?globalThis.cnBodyLabel").length - 1,
    fluid: source.split("globalThis.cnFluidLabel?globalThis.cnFluidLabel").length - 1,
    tattoo: source.split("globalThis.cnTattooLabel?globalThis.cnTattooLabel").length - 1,
  };
  if (__cnDynamicHookCounts.attribute < 15 || __cnDynamicHookCounts.body < 18 || __cnDynamicHookCounts.fluid < 7 || __cnDynamicHookCounts.tattoo < 6)
    throw new Error("505 dynamic placeholder mapping hooks incomplete: " + JSON.stringify(__cnDynamicHookCounts));
  return source;
}

function patchHawkethorneRiverTitleDialogue(source, appName) {
  if (!appName.startsWith("Content_Hawkethorne.")) return source;
  // RiverChangeTitle is one valid JS string, but the extractor split it at
  // apostrophes in It's / You'd / I've / that's / I'm / don't / haven't.
  // Replace only the visible prose; never translate the surrounding code.
  const replacements = [
    [String.raw`\"Like I told you when we first met, if anyone wants people around Hawkethorne and the Marches to know something, all they have to do is come to me. It's not just the locals who get their news from me — it's practically everyone passing through town, and <b>they</b> will spread that word further into the Marches.\"`, String.raw`\"就像我初次见你时说的那样，如果有人想让霍克索恩和边疆的人知道些什么，只需来找我。镇上不只是本地人会从我这里听到消息——几乎所有经过镇子的人都会如此，而<b>他们</b>还会把消息进一步传遍边疆。\"`],
    [String.raw`Right. You'd like to spread the word of your deeds out in the Marches, and let everyone know how they should address you in light of what you've accomplished during your adventures.`, String.raw`没错。你想让自己的事迹传遍边疆，也想让所有人根据你在冒险中取得的成就，知道今后该如何称呼你。`],
    [String.raw`\"Of course, of course.\" River waggles a finger at you. \"I've been keeping eyes and ears out for the exploits of our latest rising star — I know what you've been doing, because that's my job, after all. That being said, I'm not going to risk my reputation by spreading deceptions... so don't try claiming titles you haven't earned. Quite important, that. And there's the matter of the fee...\"`, String.raw`\"当然，当然。\"里弗朝你晃了晃手指。\"我一直在留意我们这位新晋明星的种种壮举——我知道你都做过些什么，毕竟这就是我的工作。不过，我可不会冒着砸掉招牌的风险替人散播假话……所以别试图冒领你尚未获得的头衔。这一点非常重要。另外，还有费用的问题……\"`]
  ];
  for (const [from, to] of replacements) source = source.split(from).join(to);
  return source;
}


function injectPlaceDisplayLabels(source) {
  const placeMap = displayMapping("cnPlaceLabel");
  const inject = 'globalThis.cnPlaceLabel=globalThis.cnPlaceLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnPlaceLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnPlaceLabel.map=Object.assign(globalThis.cnPlaceLabel.map||{},' + JSON.stringify(placeMap) + ');';
  if (!source.includes("globalThis.cnPlaceLabel=globalThis.cnPlaceLabel||function")) source = inject + source;
  return source;
}

function patch103PlaceDisplayLabels(source, appName) {
  if (!appName.startsWith("103.")) return source;
  source = injectPlaceDisplayLabels(source);
  const replacements = [
    ['i="Location:\\n".concat(currentRoom.map)', 'i="Location:\\n".concat(globalThis.cnPlaceLabel?globalThis.cnPlaceLabel(currentRoom.map):currentRoom.map)'],
    ['if(currentRoom.name)return currentRoom.name;', 'if(currentRoom.name)return globalThis.cnPlaceLabel?globalThis.cnPlaceLabel(currentRoom.name):currentRoom.name;'],
    ['if(void 0===t)return currentRoom.map;', 'if(void 0===t)return globalThis.cnPlaceLabel?globalThis.cnPlaceLabel(currentRoom.map):currentRoom.map;'],
    ['return"".concat(currentRoom.map," ").concat(colorText(n,"Zone ".concat(t+1)))', 'return"".concat(globalThis.cnPlaceLabel?globalThis.cnPlaceLabel(currentRoom.map):currentRoom.map," ").concat(colorText(n,"Zone ".concat(t+1)))'],
  ];
  for (const [original, patched] of replacements) {
    source = replaceLooseCode(source, original, patched, { expected: 1, label: appName + ": currentRoom map display path", fatal: true });
  }
  return source;
}

function patchGlacialRiftPlaceDisplayLabels(source, appName) {
  if (!appName.startsWith("Content_GlacialRift.")) return source;
  source = injectPlaceDisplayLabels(source);
  const original = "function(){return currentMap;}";
  const patched = "function(){return globalThis.cnPlaceLabel?globalThis.cnPlaceLabel(currentMap):currentMap}";
  return replaceLooseCode(source, original, patched, { expected: 2, label: appName + ": currentMap display placeholder", fatal: true });
}

function patchMiscPlaceDisplayLabels(source, appName) {
  if (!appName.startsWith("Content_Misc.")) return source;
  source = injectPlaceDisplayLabels(source);
  const aisling = /return\s+"the "\.concat\(\s*currentMap\s*,?\s*\);/g;
  const aislingMatches = [...source.matchAll(aisling)];
  if (aislingMatches.length !== 1) throw new Error(`${appName}: Aisling currentMap display pattern count ${aislingMatches.length}, expected 1`);
  source = source.replace(aisling, 'return globalThis.cnPlaceLabel?globalThis.cnPlaceLabel(currentMap):currentMap;');
  const outdoors = /return\s+"(?:the |那个)"\.concat\(\s*currentMap\s*\?\s*currentMap\.toLowerCase\(\)\s*:\s*"outdoors"\s*,?\s*\);/g;
  const outdoorsMatches = [...source.matchAll(outdoors)];
  if (outdoorsMatches.length !== 1) throw new Error(`${appName}: outdoor currentMap display pattern count ${outdoorsMatches.length}, expected 1`);
  source = source.replace(outdoors, 'var e=currentMap||"outdoors";return globalThis.cnPlaceLabel?globalThis.cnPlaceLabel(e):e;');
  return source;
}

function patch673NormalAttackItemLabels(source, appName) {
  if (!appName.startsWith("673.")) return source;
  const itemMap = displayMapping("cnItemLabel");
  const inject = "globalThis.cnItemLabel=globalThis.cnItemLabel||function(e){var t=String(e||\"\");return Object.prototype.hasOwnProperty.call(globalThis.cnItemLabel.map,t)?globalThis.cnItemLabel.map[t]:t};globalThis.cnItemLabel.map=Object.assign(globalThis.cnItemLabel.map||{}," + JSON.stringify(itemMap) + ");";
  if (!source.includes("globalThis.cnItemLabel=globalThis.cnItemLabel||function")) source = inject + source;
  const attackMarker = /\)\.name\s*=\s*"Attack"\s*\)\s*,\s*\(o\.short\s*=\s*"攻击"\s*\)\s*,\s*\(o\.desc\s*=\s*function\s*\(\)/g;
  const markerMatches = [...source.matchAll(attackMarker)];
  const markerIndex = markerMatches.length === 1 ? markerMatches[0].index : -1;
  if (markerIndex < 0) {
    console.warn(appName + ": normal Attack description marker not found uniquely; item display mapping was not applied.");
    return source;
  }
  const startMatch = /o\.desc\s*=\s*function\s*\(\)/g;
  startMatch.lastIndex = markerIndex;
  const startFound = startMatch.exec(source);
  const start = startFound ? startFound.index : -1;
  const endMatch = /o\.tags\s*=/g;
  endMatch.lastIndex = start >= 0 ? start : markerIndex;
  const endFound = endMatch.exec(source);
  const end = endFound ? endFound.index : -1;
  if (start < 0 || end < 0) {
    console.warn(appName + ": normal Attack description bounds not found; item display mapping was not applied.");
    return source;
  }
  let region = source.slice(start, end);
  const weapon = 'o.owner.getDescription("weapon")';
  const offhand = 'o.owner.getDescription("offhand")';
  if ((region.split(weapon).length - 1) !== 1 || (region.split(offhand).length - 1) !== 1) {
    console.warn(appName + ": normal Attack weapon/offhand display values not found uniquely; item mapping was not applied.");
    return source;
  }
  region = region.replace(weapon, 'globalThis.cnItemLabel?globalThis.cnItemLabel(o.owner.getDescription("weapon")):o.owner.getDescription("weapon")');
  region = region.replace(offhand, 'globalThis.cnItemLabel?globalThis.cnItemLabel(o.owner.getDescription("offhand")):o.owner.getDescription("offhand")');
  return source.slice(0, start) + region + source.slice(end);
}

function patch505CombatNamePrefix(source) {
  // Keep soloCombatPrefix unchanged in game data; omit only its Chinese display prefix.
  const mapping = displayMapping("cnCombatPrefix");
  if (!Object.prototype.hasOwnProperty.call(mapping, "the ")) throw new Error("cnCombatPrefix mapping is missing");
  const original = 'e.soloCombatPrefix?r(e.soloCombatPrefix+s(e.name)):s(r(e.name))';
  const replacement = 'e.soloCombatPrefix?r((Object.prototype.hasOwnProperty.call(' + JSON.stringify(mapping) + ',e.soloCombatPrefix)?' + JSON.stringify(mapping) + '[e.soloCombatPrefix]:e.soloCombatPrefix)+s(e.name)):s(r(e.name))';
  return replaceLooseCode(source, original, replacement, { label: "505 combat name prefix", fatal: true });
}


function patchMappedLiteralButtonLabels(source, appName) {
  const groups = ["cnDirectionLabel","cnCombatMenuLabel","cnPowerUiLabel","cnCreationLabel","cnHairLabel","cnMakeupLabel","cnTattooLabel","cnGeneralButtonLabel"];
  const merged = {};
  const conflicts = new Set();
  for (const group of groups) for (const [key, value] of Object.entries(displayMapping(group))) {
    if (Object.prototype.hasOwnProperty.call(merged, key) && merged[key] !== value) conflicts.add(key);
    else merged[key] = value;
  }
  for (const key of conflicts) delete merged[key];
  const inject = 'globalThis.cnButtonLabel=globalThis.cnButtonLabel||function(e){var t=String(e==null?"":e),m=globalThis.cnButtonLabel.map||{};return Object.prototype.hasOwnProperty.call(m,t)?m[t]:t};globalThis.cnButtonLabel.map=Object.assign(globalThis.cnButtonLabel.map||{},' + JSON.stringify(merged) + ');';
  let mapped = 0;
  const pattern = /\b(add(?:Gated|Disabled)?Button\(\s*[^,\r\n]+,\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  source = source.replace(pattern, (whole, prefix, label) => {
    if (!Object.prototype.hasOwnProperty.call(merged, label)) return whole;
    mapped++;
    return prefix + 'globalThis.cnButtonLabel(' + JSON.stringify(label) + ')';
  });
  if (mapped && !source.includes("globalThis.cnButtonLabel=globalThis.cnButtonLabel||function")) source = inject + source;
  return source;
}

function patchRuntimeHelpers(source, appName) {
  source = patchMappedLiteralButtonLabels(source, appName);
  source = patch103PlaceDisplayLabels(source, appName);
  source = patchGlacialRiftPlaceDisplayLabels(source, appName);
  source = patchMiscPlaceDisplayLabels(source, appName);
  source = patch673NormalAttackItemLabels(source, appName);
  source = patchSelectItemShortLabels(source, appName);
  if (appName.startsWith("103.")) { source = patch103QuestDisplayLabels(source); source = patch103DirectionLabels(source); source = patch103PowerUiLabels(source); source = patch103EffectDisplayLabels(source); }
  if (appName.startsWith("673.")) { source = patch673QuestDisplayLabels(source); source = patch673QuestCharacterLabels(source); source = patch673CompanionAffinityLabels(source); }
  if (appName.startsWith("505.")) {
    source = patch505CombatNamePrefix(source);
    source = patch505CharacterNameLabels(source);
    source = patch505ItemDisplayLabels(source);
    source = patch505StatDisplayLabels(source);
    source = patch505EquipmentInfoLabels(source);
    source = patch505CharacterPanelLabels(source);
    source = patch505PowerDisplayLabels(source);
    source = patch505EffectDisplayLabels(source);
    source = patch505InterruptPowerLabel(source);
    source = patch505PowerUiLabels(source);
    source = patch505DamageTypeLabels(source);
    source = patch505CombatPhrases(source);
    source = patch505ParserPronouns(source);
    source = patch505DynamicAttributeLabels(source);
  }
  if (appName.startsWith("673.")) {
    source = patch673EviscerateDynamicCount(source);
    source = patch673GemPuzzleLabels(source);
    source = patch673UiLabels(source);
    source = patch673DirectionLabels(source);
    source = patch673PerkDisplayLabels(source);
    source = patch673CombatMenuLabels(source);
  }
  if (appName.startsWith("Content_Other.")) source = patchContentOtherCreationUi(source);
  if (!appName.startsWith("673.")) return source;
  if (source.includes('if(/[\\u4e00-\\u9fff]/.test(e))return e;')) return source;
  const pluralStart = /(window\.plural\s*=\s*function\s*\(e\)\s*\{)/;
  const matches = [...source.matchAll(new RegExp(pluralStart.source, "g"))];
  if (matches.length !== 1) throw new Error(`${appName}: plural helper pattern count ${matches.length}, expected 1`);
  return source.replace(pluralStart, '$1if(/[\\u4e00-\\u9fff]/.test(e))return e;');
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
  const rebased = rebaseRowsToSource(doc.rows || [], source, appName);
  const candidates = rebased.rows
    .filter((row) => row.translation && row.translation.trim() && row.translationStatus !== "failed" && row.translationStatus !== "needs_manual_review")
    .filter((row) => typeof row.start === "number" && typeof row.end === "number")
    .filter((row) => row.manualTextOverlay ? isSafeManualTextOverlay(row, source) : isSafeReplacementRow(row, source));
  const translatedLiterals = candidates.filter((row) => !row.manualTextOverlay);
  const rows = candidates
    // A complete translated literal supersedes any legacy overlay inside it.
    // This lets old hand-split fragments disappear naturally once the newly
    // formatted full string receives a translation.
    .filter((row) => !row.manualTextOverlay || !translatedLiterals.some((literal) => literal.start <= row.start && literal.end >= row.end))
    .sort((a, b) => b.start - a.start);

  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    const currentRaw = source.slice(row.start, row.end);
    if (row.raw && currentRaw !== row.raw) {
      skipped += 1;
      continue;
    }
    const replacement = row.manualTextOverlay ? jsStringContent(row.translation, row.overlayContainerQuote || '"') : jsStringLiteral(row.translation);
    source = source.slice(0, row.start) + replacement + source.slice(row.end);
    applied += 1;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  source = patchRuntimeHelpers(source, appName);
  fs.writeFileSync(outputPath, source, "utf8");
  return { jsonName, outputPath, applied, skipped, rebase: rebased.stats };
}

function copyUntranslatedJsFiles(summaries) {
  const generated = new Set(
    summaries
      .filter((item) => item.outputPath)
      .map((item) => path.normalize(path.relative(TRANSLATED_APP_DIR, item.outputPath)))
  );
  let copiedOriginalJs = 0;
  let generatedTranslatedJs = generated.size;

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const sourcePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(sourcePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const relativePath = path.normalize(path.relative(ORIGINAL_APP_DIR, sourcePath));
      if (generated.has(relativePath)) continue;
      const destinationPath = path.join(TRANSLATED_APP_DIR, relativePath);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      copiedOriginalJs += 1;
    }
  }

  if (fs.existsSync(ORIGINAL_APP_DIR)) walk(ORIGINAL_APP_DIR);
  return { copiedOriginalJs, generatedTranslatedJs, totalJsOutput: copiedOriginalJs + generatedTranslatedJs };
}
function main() {
  const summaries = collectJsonFiles().map(applyOne);
  let totalApplied = 0;
  let totalSkipped = 0;
  for (const item of summaries) {
    totalApplied += item.applied || 0;
    totalSkipped += item.skipped || 0;
    const rebase = item.rebase ? `, rebased=${item.rebase.matched}/${item.rebase.total}, unmatched=${item.rebase.unmatched}` : "";
    console.log(`${item.jsonName}: applied=${item.applied || 0}, skipped=${item.skipped || 0}${rebase}${item.reason ? `, ${item.reason}` : ""}`);
  }
  const jsOutput = copyUntranslatedJsFiles(summaries);
  const summary = { generatedAt: new Date().toISOString(), totalApplied, totalSkipped, ...jsOutput, files: summaries };
  fs.writeFileSync(path.resolve("translator", "apply_translations_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nTotal applied=${totalApplied}, skipped=${totalSkipped}`);
  console.log(`JS output: translated=${jsOutput.generatedTranslatedJs}, copied original=${jsOutput.copiedOriginalJs}, total=${jsOutput.totalJsOutput}`);
}

main();
