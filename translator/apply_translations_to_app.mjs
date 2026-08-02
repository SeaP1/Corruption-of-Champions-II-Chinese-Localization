import fs from "node:fs";
import path from "node:path";

const TRANSLATED_JSON_DIR = path.resolve("translator", "translated_json");
const TRANSLATED_APP_DIR = path.resolve("translator", "translated_app");
const ORIGINAL_APP_DIR = path.resolve("resources", "app");
const includeAll = process.argv.includes("--all");

function jsStringLiteral(value) {
  return JSON.stringify(value);
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
  return /\.test\(|\.includes\(|\.toLowerCase\(|function\s*\(|processTime\(|addButton\(|NameKiddo\(|return["A-Za-z_$]|var\s+[A-Za-z_$]|const\s+[A-Za-z_$]|let\s+[A-Za-z_$]|\}\);|=>/.test(text);
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

function replaceStringLiterals(source, replacements) {
  for (const [from, to] of replacements) {
    source = source.split(JSON.stringify(from)).join(JSON.stringify(to));
  }
  return source;
}

function patch505CombatPhrases(source) {
  source = source.replace(
    'var e="".concat(this.getDescription("CombatName")," ").concat(this.pcplmf("are","are","is","is")," ");return this.HP()<=0?e+="out cold and out of commission":this.resolve()<=0?e+="squirming and panting with desire":this.HPQ()<.5?e+="身上带着多处割伤和瘀伤，不过 ".concat(this.pcplmf("you\'re","they\'re","he\'s","she\'s"),"仍凭着坚强的意志支撑着"):this.RQ()<.5?e+="shivering with the telltale signs of arousal":e+="仍在战斗中",e+"."',
    'var e="".concat(this.getDescription("CombatName"));return this.HP()<=0?e+="已经失去意识，无法继续行动":this.resolve()<=0?e+="欲火缠身，喘息着无法继续行动":this.HPQ()<.5?e+="身上带着多处割伤和瘀伤，但仍凭着坚强的意志支撑着":this.RQ()<.5?e+="因难以掩饰的欲望而颤抖":e+="仍在战斗中",e+"。"'
  );
  source = source.replace(
    'defeatedText",value:function(e){return"".concat(this.getDescription("CombatName")," ").concat(this.pcplmf("are","are","is","is")," too ").concat(e?"horny":"hurt"," to keep fighting!")}',
    'defeatedText",value:function(e){return"".concat(this.getDescription("CombatName")).concat(e?"欲望过盛，无法继续战斗！":"伤势过重，无法继续战斗！")}'
  );
  // round3_505_literal_phrases
  source = replaceStringLiterals(source, [
    ["quarterstaff", "长棍"],
    ["blade staff", "刃杖"],
    ["Critical Hit!", "致命一击！"],
    ["Arcane Strike", "奥术打击"],
  ]);
  return source;
}

function patch673UiLabels(source) {

  // appearance_round1b_exact_generated_fragments
  source = source.replace(
    'r+="Your face is ".concat("human"!==e.race()?"[rand|mostly|largely] ":"","human in form, ").concat("human"!==e.race()?"though you have":"with"," ")+e.skin(!0,!0,!0)+"."',
    'r+="你的面容".concat("human"!==e.race()?"[rand|大体上|基本上] ":"","呈人类形态，").concat("human"!==e.race()?"不过你有":"有着"," ")+e.skin(!0,!0,!0)+"。"'
  );
  source = source.replace(
    'r+="Your face is ".concat("human"!==e.race()?"[rand|mostly|largely] ":"","human in form, ").concat("human"!==e.race()?"and you have":"with"," ")+e.skin(!0,!0,!0)+"."',
    'r+="你的面容".concat("human"!==e.race()?"[rand|大体上|基本上] ":"","呈人类形态，").concat("human"!==e.race()?"并且你有":"有着"," ")+e.skin(!0,!0,!0)+"。"'
  );
  source = source.replace(
    't+="\\n\\nYou have one "+e.assholeDesc(!0)+", placed between your cheeks where it belongs"',
    't+="\\n\\n你有一个"+e.assholeDesc(!0)+"肛门，位于双臀之间本该在的位置"'
  );
  source = replaceStringLiterals(source, [
    ["Attack", "攻击"],
    ["Powers", "能力"],
    ["Tease", "挑逗"],
    ["Sense", "感知"],
    ["Defend", "防御"],
    ["Auto", "自动"],
    ["Flow: Player", "流程：玩家"],
    ["Inventory", "物品"],
    ["Flee", "逃跑"],
    ["Surrender", "投降"],
    ["Critical Hit!", "致命一击！"],
    ["standing strong", "状态良好"],
    ["having a hard time remaining on her feet", "快要站不稳了"],
    ["standing firm, relatively unscathed", "站得很稳，几乎毫发无伤"],
    ["lying face-down in the dirt, barely moving", "脸朝下倒在泥地里，几乎一动不动"],
    ["completely flushed red, obviously on the brink of collapse", "满脸通红，显然已经濒临崩溃"],
    ["breathing heavily, looking pretty beat up", "呼吸沉重，看上去伤得不轻"],
    ["panting with mounting arousal", "随着欲望升高而喘息不止"],
    ["The storm surges!", "风暴涌动！"],
    ["With an unearthly wail like popping wood and crackling leaves, ", "伴随着仿佛木头爆裂、树叶噼啪作响的超自然哀嚎，"],
    ["vaguely make out the dark walls of a temple sitting high on the peak", "隐约看见一座坐落在峰顶的神殿黑墙"],
    ["comfortable clothes", "舒适的衣服"],
    ["Arcane Strike", "奥术打击"],
    ["Stretchy", "柔韧"],
    ["Starting Bonuses", "初始加成"],
    ["Vaginal Wetness", "阴道湿润度"],
    ["Vaginal Looseness", "阴道松弛度"],
    ["Vaginal Capacity", "阴道容量"],
    ["Fertility", "生育力"],
    ["You conjure a bolt of lightning and hurl it at a foe. The target is always struck for ", "你召唤一道闪电并掷向敌人。目标必定会受到"],
    ["You conjure a bolt of lightning that strikes a target enemy for ", "你召唤一道闪电，击中一个目标敌人并造成"],
    ["You blast a target with dark magic. On a hit against the target's Magic Resistance, the target takes ", "你用黑暗魔法轰击目标。若命中目标的魔法抗性，目标会受到"],
    ["demonic blade staff", "恶魔刃杖"],
    ["Give up without a fight.", "不再抵抗，放弃战斗。"],
    ["Surrendering now would be suicide.", "现在投降无异于自杀。"],
    ["Attack Power", "攻击力"],
    ["Armor Penetration", "护甲穿透"],
    ["Spellpower", "法术强度"],
    ["Spell Penetration", "法术穿透"],
    ["Sexiness", "性感"],
    ["Temptation", "诱惑"],
    ["Accuracy", "命中"],
    ["Critical Chance", "暴击率"],
    ["Armor", "护甲"],
    ["Physical Resist", "物理抗性"],
    ["Warding", "守护"],
    ["Magic Resist", "魔法抗性"],
    ["Focus", "专注"],
    ["Mental Resist", "精神抗性"],
    ["Evasion", "闪避"],
    ["Acid Resist", "酸蚀抗性"],
    ["Blight Resist", "枯萎抗性"],
    ["Crushing Resist", "粉碎抗性"],
    ["Fire Resist", "火焰抗性"],
    ["Frost Resist", "冰霜抗性"],
    ["Holy Resist", "神圣抗性"],
    ["Penetrating Resist", "穿刺抗性"],
    ["Storm Resist", "风暴抗性"],
    ["Tease Resist", "挑逗抗性"],
    ["Drug Resist", "药物抗性"],
    ["Pheromone Resist", "信息素抗性"],
    ["Fatigue Resist", "疲劳抗性"],
    ["Mind Resist", "心灵抗性"],
    ["Likes: ", "喜好："],
    ["Dislikes: ", "厌恶："],
    ["Stealable Powers: ", "可偷取能力："],
    ["Damage Reduction: ", "伤害减免："],
    ["Info", "信息"],
    ["None", "无"],
    ["Attack: ", "攻击："],
    ["Offhand", "副手"],
    ["Halfsword", "半剑"],
    ["\n        \n        [attacker.CombatName] regenerate[tps|s] some health.", "\n        \n        [attacker.CombatName][tps|恢复|恢复]了一些生命值。"],
  ]);

  // round3_673_raw_fragment_replacements
  for (const [from, to] of [
    ["quarterstaff", "长棍"],
    ["blade staff", "刃杖"],
    ["standing strong, unfazed by your battle thus far.", "状态良好，至今未受你的攻势影响。"],
    ["standing strong.", "状态良好。"],
    ["lusty tentacles", "淫欲触手"],
    ["Your face is mostly human in form, and you have ", "你的面容大体上仍是人形，你有"],
    ["Your face is mostly human in shape, decorated with ", "你的面容大体上仍是人形，其上点缀着"],
    ["Your face is mostly human in shape, with hints of ", "你的面容大体上仍是人形，并带有些许"],
    ["Overall, your visage has ", "总体而言，你的容貌有着"],
    ["that's sure to draw attention, and ", "足以吸引他人注意，还有"],
    ["Your eyes bear a vertical slit instead of rounded pupils, ", "你的眼睛不是圆形瞳孔，而是竖瞳，"],
    ["Your mouth contains a tongue.", "你的口中有一条舌头。"],
    ["You have a humanoid upper body with the usual torso, arms, hands, and fingers.", "你有类人的上半身，拥有常见的躯干、手臂、双手和手指。"],
    ["A cat-tail sprouts just above your backside, curling and twisting with every step to maintain perfect balance.", "一条猫尾从你臀部上方伸出，随着每一步卷曲摆动，帮助你保持完美的平衡。"],
    ["Two normal human legs extend below your waist, ending in normal human feet.", "两条普通的人类双腿从你的腰部向下延伸，末端是普通的人类双脚。"],
    ["Your middle is fairly well-toned.", "你的腹部线条相当紧致。"],
    ["Your sexual equipment is located at your", "你的性器位于你的"],
    [" waist. ", "腰间。"],
    ["You have A-cup breasts, ", "你有 A 罩杯的乳房，"],
    [" small, pert", "小巧而挺翘的"],
    [" boobs that almost vanish under anything thicker than spandex", "乳房，穿上比氨纶更厚的衣物时几乎会消失不见"],
    ["The average-sized areolae are pink.", "平均大小的乳晕呈粉色。"],
    ["You could easily fill an A bra.", "你可以轻松撑满一件 A 罩杯胸罩。"],
    ["No moisture presently escapes your pussy.", "目前没有液体从你的阴部渗出。"],
    ["n average chest with ", "个大小适中的胸膛，"],
    [" pectoral muscles", "胸肌"],
    ["Fairly unremarkable", "相当普通的"],
    ["Normal-looking ", "普通的"],
    ["Regular ", "普通的"],
    ["You're wearing ", "你穿着"],
    [", taking full advantage of the freedom of movement provided by the light armor.", "，充分利用轻甲带来的行动自由。"],
    ["Meanwhile, your feet are garbed in ", "与此同时，你的双脚穿着"],
    ["Your face is human in form, with ", "你的面容是人类形态，有着"],
    ["Fairly unremarkable ", "相当普通的"],
    [" eyes allow you to take in your surroundings without trouble.", "眼睛让你能够毫无困难地观察周围。"],
    [" looks good on you, accentuating your features well.", "很适合你，也很好地衬托出你的五官。"],
    ["Your maw contains a tongue.", "你的口中有一条舌头。"],
    ["You have an average chest with toned pectoral muscles, capped with one ", "你的胸膛大小适中，胸肌线条紧致，每侧有一枚"],
    [" nipple each.", "乳头。"],
    ["Your cock is ", "你的阳具长"],
    [" inches long and ", "英寸，宽"],
    ["A cum-packed scrotum with ", "一个饱含精液的阴囊，里面有"],
    [" testicles swings heavily beneath your dick.", "睾丸，沉甸甸地悬在你的阳具下方。"],
    ["You estimate each testicle to be about ", "你估计每颗睾丸大约"],
    ["You estimate the testicle to be about ", "你估计这颗睾丸大约"],
    [" around and ", "周长，"],
    ["You have one ", "你有一个"],
    [" asshole, placed between your cheeks where it belongs.", "肛门，位于双臀之间本该在的位置。"],
    [" backdoor, placed between your cheeks where it belongs.", "后庭，位于双臀之间本该在的位置。"],
    ["humanoid腰间", "类人腰部"],
    ["a 舒适的衣服", "一套舒适的衣服"]
  ]) source = source.split(from).join(to);
  return source;
}

function patchRuntimeHelpers(source, appName) {
  if (appName.startsWith("505.")) source = patch505CombatPhrases(source);
  if (appName.startsWith("673.")) source = patch673UiLabels(source);
  if (!appName.startsWith("673.")) return source;
  const original = 'window.plural=function(e){var t=e.slice(-1),n=e.slice(-2,-1);return"s"===t||"s"===n&&"h"===t||"c"===n&&"h"===t?e+="es":"z"!==n&&"z"===t?e+="zes":"x"===t||"z"===t?e+="es":"y"===t&&"e"!==n&&"a"!==n&&"u"!==n&&"o"!==n&&"i"!==n?e=e.slice(0,-1)+"ies":e+="s",e}';
  const patched = 'window.plural=function(e){if(/[\\u4e00-\\u9fff]/.test(e))return e;var t=e.slice(-1),n=e.slice(-2,-1);return"s"===t||"s"===n&&"h"===t||"c"===n&&"h"===t?e+="es":"z"!==n&&"z"===t?e+="zes":"x"===t||"z"===t?e+="es":"y"===t&&"e"!==n&&"a"!==n&&"u"!==n&&"o"!==n&&"i"!==n?e=e.slice(0,-1)+"ies":e+="s",e}';
  if (!source.includes(original) && !source.includes(patched)) {
    console.warn(`${appName}: plural helper pattern not found; Chinese plural patch was not applied.`);
    return source;
  }
  return source.replace(original, patched);
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
  const rows = (doc.rows || [])
    .filter((row) => row.translation && row.translation.trim() && row.translationStatus !== "failed")
    .filter((row) => typeof row.start === "number" && typeof row.end === "number")
    .filter((row) => isSafeReplacementRow(row, source))
    .sort((a, b) => b.start - a.start);

  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    const currentRaw = source.slice(row.start, row.end);
    if (row.raw && currentRaw !== row.raw) {
      skipped += 1;
      continue;
    }
    source = source.slice(0, row.start) + jsStringLiteral(row.translation) + source.slice(row.end);
    applied += 1;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  source = patchRuntimeHelpers(source, appName);
  fs.writeFileSync(outputPath, source, "utf8");
  return { jsonName, outputPath, applied, skipped };
}

function main() {
  const summaries = collectJsonFiles().map(applyOne);
  let totalApplied = 0;
  let totalSkipped = 0;
  for (const item of summaries) {
    totalApplied += item.applied || 0;
    totalSkipped += item.skipped || 0;
    console.log(`${item.jsonName}: applied=${item.applied || 0}, skipped=${item.skipped || 0}${item.reason ? `, ${item.reason}` : ""}`);
  }
  const summary = { generatedAt: new Date().toISOString(), totalApplied, totalSkipped, files: summaries };
  fs.writeFileSync(path.resolve("translator", "apply_translations_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nTotal applied=${totalApplied}, skipped=${totalSkipped}`);
}

main();







