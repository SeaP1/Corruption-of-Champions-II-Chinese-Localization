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

function replaceStringLiterals(source, replacements) {
  for (const [from, to] of replacements) {
    source = source.split(JSON.stringify(from)).join(JSON.stringify(to));
  }
  return source;
}

function patchSelectItemShortLabels(source, appName) {
  const hairMap = {
    "Bob": "波波头", "Braided": "编辫", "Curls": "卷发", "Ponytail": "马尾", "Rugged": "粗犷发型", "Shaggy": "蓬乱短发",
    "Short": "短发", "Dreadlocks": "脏辫", "Dread Ponytail": "脏辫马尾", "Side-Cut Dreads": "侧削脏辫",
    "Afro": "爆炸头", "Afro Ponytail": "爆炸头马尾", "Afro Puffs": "爆炸头蓬蓬发", "Straight": "直发",
    "Side-Cut": "侧削发", "Unkempt": "蓬乱", "Twintails": "双马尾", "Bun": "发髻", "Flattop": "平顶头",
    "Mohawk": "莫霍克", "Spiky": "尖刺发", "Top Knot Dreadlocks": "顶髻脏辫", "Obfuscating Afro": "遮脸爆炸头",
    "Fade": "渐层短发", "Box Braids": "盒形辫", "Braid Pompadour": "辫子蓬巴杜", "Pompadour": "蓬巴杜",
    "Spiky with Bangs": "带刘海尖刺发", "Shave It": "剃光", "Trim": "修剪", "Long": "长须", "Bushman": "浓密胡须"
  };
  const mapExpr = JSON.stringify(hairMap);
  const inject = "var __cnSelectLabelMap=" + mapExpr + ",__cnSelectLabel=function(e){return __cnSelectLabelMap[e]||e},__cnPatchSelectShort=function(e){return e&&e.name&&__cnSelectLabelMap[e.name]&&(e.short=__cnSelectLabelMap[e.name]),e};";
  if (!source.includes("__cnPatchSelectShort=function")) {
    if (appName.startsWith("Content_Hawkethorne.") || appName.startsWith("Content_MarefolkVillage.")) {
      source = source.replace(/(window\.[A-Za-z0-9_$]+Hairdressing=function\(\)\{)/, "$1" + inject);
      source = source.replace(/(window\.[A-Za-z0-9_$]+Beard=function\(\)\{)/, "$1" + inject);
    }
  }
  if (appName.startsWith("Content_Hawkethorne.") || appName.startsWith("Content_MarefolkVillage.")) {
    source = source.replace(/(\b[a-zA-Z_$][\w$]*\.c\.stubItemForSelect\("([^"]+)","[^"]*",GLOBALS\.ITEM_MISC,[a-zA-Z_$][\w$]*(?:\)|\),\{canSelect:function\(\)\{return [^}]+\}\}))/g, "__cnPatchSelectShort($1)");
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
  // appearance_elegant_source_templates
  // Source-level Appearance templates. Word choices come from cnAttrLabel/cnBodyLabel;
  // these patches only adjust Chinese sentence glue where English word order cannot work.
  for (const [from, to] of [
    [
      't="\n\nYou have a humanoid upper body with the usual torso, arms, hands, and fingers"',
      't="\n\n你有类人的上半身，拥有常见的躯干、手臂、双手和手指"'
    ],
    [
      'return" "+capitalize(num2Text(e.legCount))+" "+(["furred","gooey"][e.legTag(GLOBALS.BODY_TAG_FURRED,GLOBALS.BODY_TAG_GOOEY)]||"normal")+" human legs extend below your waist, ending in normal human feet."',
      'return" 你的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.legCount)):num2Text(e.legCount))+"条普通的人类双腿从你的腰部向下延伸，末端是普通的人类双脚。"'
    ],
    [
      'i+=" Your "+e.hairDesc(!0,!0)+" looks good on you, accentuating your features well."',
      'i+=" 你的"+(globalThis.cnBodyLabel?globalThis.cnBodyLabel(e.hairDesc(!0,!0)):e.hairDesc(!0,!0))+"很适合你，也很好地衬托出你的五官。"'
    ],
    [
      'a+" eyes allow you to take in your surroundings without trouble."',
      'a+"眼睛让你能够毫无困难地观察周围。"'
    ],
    [
      'case 10:return" 你的口中有一条舌头。"',
      'case 10:return" 你的口中有一条舌头。"'
    ],
    [
      'case 10:return" 你的口中有一条舌头。"',
      'case 10:return" 你的口中有一条舌头。"'
    ],
    [
      't+="Your sexual equipment is located at your","human"===e.race()&&e.isHalfHuman()||(t+=" humanoid"),t+=" waist. "',
      't+="你的性器位于你的","human"===e.race()&&e.isHalfHuman()||(t+=(globalThis.cnAttrLabel?globalThis.cnAttrLabel("humanoid"):"humanoid")),t+="腰部。 "'
    ]
  ]) source = source.split(from).join(to);

  // appearance_dynamic_673_round2
  source = source.split('t<6?e+=", and":pc.femininity>50?').join('t<6?e+="，而":pc.femininity>50?');
  source = source.replace(
    '1===e.numTails?(i+=" A long cow tail with a",e.hasTailTags(GLOBALS.BODY_TAG_GOOEY)?i+=" voluminous":i+=" puffy",i+=" tip swishes back and forth as if swatting at flies."):(i+=" "+capitalize(num2Text(e.numTails))+" long cow tails with",e.hasTailTags(GLOBALS.BODY_TAG_GOOEY)?i+=" voluminous":i+=" puffy",i+=" tips swish back and forth as if swatting at flies.")',
    '1===e.numTails?(i+=" 一条长长的牛尾有着",e.hasTailTags(GLOBALS.BODY_TAG_GOOEY)?i+="丰厚的":i+="蓬松的",i+="尾尖，像在驱赶苍蝇般来回甩动。"):(i+=" "+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.numTails)):num2Text(e.numTails))+"条长长的牛尾有着",e.hasTailTags(GLOBALS.BODY_TAG_GOOEY)?i+="丰厚的":i+="蓬松的",i+="尾尖，像在驱赶苍蝇般来回甩动。")'
  );

  // appearance_source_gear_templates
  // Translate dynamic gear-description templates at source.
  for (const [from, to] of [
    [
      'l=s?"You\'re wearing "+(i?"":"[a] ")+"[pc.armor]":"Your [pc.armor] "',
      'l=s?"你穿着[pc.armor]":"你的[pc.armor]"'
    ],
    [
      'l+=s?", "+(i?"their":"its")+" weight causing "+(i?"them":"it")+" to clank with every step.":"clank"+(i?"":"s")+" and jingle"+(i?"":"s")+" with every step you take."',
      'l+=s?"，"+(i?"它们的":"其")+"重量让"+(i?"它们":"它")+"随着每一步发出铿锵声。":"随着你的每一步发出铿锵碰撞声。"'
    ],
    [
      'l+=s?", taking full advantage of the freedom of movement provided by the light armor.":(i?"are":"is")+" incredibly light, leaving you with greater freedom of movement than heavier apparel would allow."',
      'l+=s?"，充分利用轻甲带来的行动自由。":"十分轻便，让你比穿着更沉重的装备时拥有更大的行动自由。"'
    ],
    [
      'l+=oe()?" Your "+e.shoulders.name+" flows behind you, billowing in the cold wind.":" Your "+e.shoulders.name+" rest comfortably on your top, "+(e.shoulders.tags.includes(GLOBALS.ITEM_TAG_CLOTH)?"the cloth falling to fit you perfectly.":e.shoulders.tags.includes(GLOBALS.ITEM_TAG_LEATHER)?"the leather fitting your form surprisingly well.":"though the weight can be inconvenient at times.")',
      'l+=oe()?" 你的"+e.shoulders.name+"在身后飘动，在寒风中翻卷。":" 你的"+e.shoulders.name+"舒适地披在你的上身，"+(e.shoulders.tags.includes(GLOBALS.ITEM_TAG_CLOTH)?"布料垂落得恰到好处，完美贴合你的身形。":e.shoulders.tags.includes(GLOBALS.ITEM_TAG_LEATHER)?"皮革意外地贴合你的身形。":"只是重量偶尔会有些碍事。")'
    ]
  ]) source = source.split(from).join(to);

  // appearance_673_attr_label_inject
  // 673 owns most Appearance templates, so inject a small display-label map here too.
  const attrLabelMap673 = {
    "pale": "苍白", "fair": "白皙", "tanned": "晒黑", "olive": "橄榄色", "bronze": "古铜色", "dusky": "暗褐色", "dark": "深色",
    "black": "黑色", "brown": "棕色", "blue": "蓝色", "pink": "粉色", "purple": "紫色", "red": "红色", "white": "白色",
    "gray": "灰色", "green": "绿色", "gold": "金色", "silver": "银色", "humanoid": "类人型",
    "short": "短", "slightly long": "略长的", "moderately long": "略长的", "medium-length": "中等长度", "shoulder-length": "齐肩的", "neck-length": "及颈的", "butt-length": "齐臀长",
    "straight": "直发", "unkempt": "蓬乱的", "shaggy": "蓬乱的", "ponytail": "马尾", "one": "一", "two": "两", "three": "三", "four": "四"
  };
  const injectAttr673 = `globalThis.cnAttrLabel=globalThis.cnAttrLabel||function(e){var t=String(e);var n=t.toLowerCase();return Object.prototype.hasOwnProperty.call(globalThis.cnAttrLabel.map,n)?globalThis.cnAttrLabel.map[n]:t};globalThis.cnAttrLabel.map=Object.assign(globalThis.cnAttrLabel.map||{},${JSON.stringify(attrLabelMap673)});`;
  if (!source.includes("globalThis.cnAttrLabel=globalThis.cnAttrLabel||function")) source = source.includes('"use strict";') ? source.replace('"use strict";', '"use strict";' + injectAttr673) : injectAttr673 + source;

  // appearance_source_templates_cleanup
  // Prefer source template replacement over mixed Chinese/English output cleanup.
  for (const [from, to] of [
    [
      'a+" eyes allow you to take in your surroundings without trouble."',
      'a+"眼睛让你能够毫无困难地观察周围。"'
    ],
    [
      '0===rand(10)?a+=" Fairly unremarkable "+e.eyeColor:0===rand(3)?a+=" Regular "+e.eyeColor:0===rand(2)?a+=" Normal-looking "+e.eyeColor:a+=" "+capitalize(e.eyeColor)+"-colored"',
      '0===rand(10)?a+=" 相当普通的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.eyeColor):e.eyeColor):0===rand(3)?a+=" 普通的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.eyeColor):e.eyeColor):0===rand(2)?a+=" 看起来普通的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.eyeColor):e.eyeColor):a+=" "+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.eyeColor):capitalize(e.eyeColor))'
    ],
    [
      'i+=" Your "+e.hairDesc(!0,!0)+" looks good on you, accentuating your features well."',
      'i+=" 你的"+(globalThis.cnBodyLabel?globalThis.cnBodyLabel(e.hairDesc(!0,!0)):e.hairDesc(!0,!0))+"很适合你，也很好地衬托出你的五官。"'
    ],
    [
      'return" "+capitalize(num2Text(e.legCount))+" "+(["furred","gooey"][e.legTag(GLOBALS.BODY_TAG_FURRED,GLOBALS.BODY_TAG_GOOEY)]||"normal")+" human legs extend below your waist, ending in normal human feet."',
      'return" 你的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.legCount)):num2Text(e.legCount))+"条普通的人类双腿从你的腰部向下延伸，末端是普通的人类双脚。"'
    ],
    [
      't+="You have a fuck-off six pack, bulging with heavy muscle. Above it, you have a broad chest":0===rand(2)?t+="You\'re ripped as hell, sporting the kind of muscle guys want and girls want around them. Much can be said about your pecs":t+="You have remarkably well defined, heavyweight abs, rounded and beefy. Above it, you have a muscled chest"',
      't+="你拥有一副夸张结实、肌肉隆起的六块腹肌；其上方是宽阔的胸膛":0===rand(2)?t+="你浑身肌肉结实，拥有让男性羡慕、让女性渴望亲近的体格。你的胸肌同样值得称道":t+="你拥有轮廓分明、厚实有力的腹肌；其上方是肌肉结实的胸膛"'
    ],
    [
      't+="Your sexual equipment is located at your","human"===e.race()&&e.isHalfHuman()||(t+=" humanoid"),t+=" waist. "',
      't+="你的性器位于你的","human"===e.race()&&e.isHalfHuman()||(t+=(globalThis.cnAttrLabel?globalThis.cnAttrLabel("humanoid"):"humanoid")),t+="腰部。 "'
    ]
  ]) source = source.split(from).join(to);

  for (const [from, to] of [["t+=\"Your \"+e.simpleCockNoun(0)+\" is \"+","t+=\"你的\"+e.simpleCockNoun(0)+\"长\"+"]]) source = source.split(from).join(to);
  // appearance_round3_673_dynamic_fragments
  for (const [from, to] of [[" The \"+e.hairDesc(!0,!0)+\" on your head nearly conceals a pair of mostly-human ears with slightly pointed tips, just like an elf's."," 你头上的\"+e.hairDesc(!0,!0)+\"几乎遮住了一对近似人类、耳尖微尖的耳朵，看起来就像精灵的耳朵。"],[" The \"+e.hairDesc(!0,!0)+\" on your head can't hide a pair of triangular, elven ears. They stick out a full "," 你头上的\"+e.hairDesc(!0,!0)+\"遮不住那对三角形的精灵耳。它们从你头部两侧伸出足足"],[" The \"+e.hairDesc(!0,!0)+\" atop your head can't possibly hide a pair of exquisitely long, elven ears. They extend a full "," 你头上的\"+e.hairDesc(!0,!0)+\"完全遮不住那对精致修长的精灵耳。它们从你头部两侧伸出足足"],[" inches from the sides of your head. Small extra muscles let them twitch or droop expressively.","英寸。细小的额外肌肉让它们能富有表情地抖动或垂下。"],[" inches from the sides of your head, triangular in shape with a bit of downward curve along their length. A thought is all it takes for them to change their angle to suit your expression, letting even the most rugged face pull off a cutesy pout with ease.","英寸，呈三角形，长度方向略微下弯。只要一个念头，它们就会配合你的表情改变角度，让再粗犷的面孔也能摆出可爱的噘嘴。"],["e+=\" You have \"+pc.hipDesc(!0)","e+=\" 你有\"+pc.hipDesc(!0)"],[" that blend into your pillar-like waist, and","，与你柱状般的腰身融为一体，而"],[" that match your trim, lithe body, and","，与你修长轻盈的身形相称，而"],[" that sway to and fro, emphasized by your trim body, and","，在修长身形的衬托下来回摇曳，而"],[" that draw the attention of those around you, and","，吸引着周围人的目光，而"],[" that give you a graceful stride, and","，让你的步伐显得优雅，而"],["e+=\" your \"+pc.buttDesc()","e+=\"你的\"+pc.buttDesc()"],[" looks great under your gear.","在装备下显得很好看。"],[" molds closely against your form.","紧贴着你的身形。"],[" fills out your clothing nicely.","把你的衣物撑得恰到好处。"],[" contracts with every motion, displaying the detailed curves of its lean musculature.","随着每个动作收紧，展现出精瘦肌肉的细致曲线。"],["\", taking full advantage of the freedom of movement provided by the light armor.","\"，充分利用轻甲带来的行动自由。"],["\"+\" incredibly light, leaving you with greater freedom of movement than heavier apparel would allow.","\"+\"十分轻便，让你比穿着更沉重的装备时拥有更大的行动自由。"],[" Your \"+e.shoulders.name+\" rest comfortably on your top, "," 你的\"+e.shoulders.name+\"舒适地披在你的上身，"],["You have two 乳房, capped with one 乳头 each.","你有两只乳房，每侧有一枚乳头。"],["You have two 乳房, capped with one 内陷的 乳头 each.","你有两只乳房，每侧有一枚内陷的乳头。"],["你拥有轮廓分明、厚实有力的腹肌；其上方是肌肉结实的胸膛, capped with one 0.3-inch 乳头 each.","你拥有轮廓分明、厚实有力的腹肌；其上方是肌肉结实的胸膛，每侧有一枚 0.3 英寸的乳头。"],["你拥有轮廓分明、厚实有力的腹肌；其上方是肌肉结实的胸膛, capped with one 0.3-inch 芽 each.","你拥有轮廓分明、厚实有力的腹肌；其上方是肌肉结实的胸膛，每侧有一枚 0.3 英寸的小乳头。"],["When you're aroused enough, your 0.4-inch nipples pop out, ready for action.","当你足够兴奋时，0.4 英寸的乳头会挺立出来，蓄势待发。"],["You could easily fill a DD bra.","你可以轻松撑满一件 DD 罩杯胸罩。"],["Your 工具 is ","你的阴茎长"],["Your 茎身 is ","你的阴茎长"],["Your 阳具 is ","你的阳具长"],["英寸，宽1.5英寸宽。","英寸，宽1.5英寸。"],["英寸，宽1.8英寸宽。","英寸，宽1.8英寸。"],["英寸，宽2.3英寸宽。","英寸，宽2.3英寸。"],["未受破坏的 肛门肛门","处女肛门"],["处女 肛门肛门","处女肛门"],["肛门肛门","肛门"],["屁眼肛门","肛门"]]) source = source.split(from).join(to);

  // appearance_round2_dynamic_template_and_fragments
  source = source.replace(
    't="You are [pc.name], [a] [pc.raceAdj] [pc.class] and [pc.title].\\n    \\n    You ".concat(e.ra(e.originalRace)?"are [an] [pc.startingRace] [pc.sex] [pc.background]":"started your journey as [a] [pc.startingRace] [pc.background], but have become [an] [pc.race] during the course of your travels. You are a [pc.sex]",", standing [pc.height] tall with [a] [pc.bodyShape] physique. ");',
    't="[pc.name]，你是一名[pc.raceAdj][pc.class]，同时也是[pc.title]。\\n    \\n    你".concat(e.ra(e.originalRace)?"是一名[pc.startingRace][pc.sex][pc.background]":"最初是一名[pc.startingRace][pc.background]，但在旅途中变成了[pc.race]。你现在是[pc.sex]","，身高[pc.height]，体型[pc.bodyShape]。 ");'
  );
  source = source.replace(
    'r+=" The "+e.hairDesc(!0,!0)+" on your head can\'t hide a pair of triangular, elven ears. They stick out a full "+e.earLength+" inches from the sides of your head. Small extra muscles let them twitch or droop expressively."',
    'r+=" 你头上的"+e.hairDesc(!0,!0)+"遮不住那对三角形的精灵耳。它们从你头部两侧伸出足足"+e.earLength+"英寸。细小的额外肌肉让它们能富有表情地抖动或垂下。"'
  );
  source = source.replace(
    'h+=" A long "+t.hairColor+" horsetail hangs from your "+t.buttDesc()+", smooth and shiny."',
    'h+=" 一条长长的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(t.hairColor):t.hairColor)+"马尾从你的"+t.buttDesc()+"垂下，光滑而闪亮。"'
  );
  source = source.replace(
    'c+=" A swishing, "+t.furColor+" fox tail extends from your "+t.buttDesc()+", curling around your body — the soft fur feels lovely."',
    'c+=" 一条摇摆的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(t.furColor):t.furColor)+"狐尾从你的"+t.buttDesc()+"伸出，卷绕在你的身体周围——柔软的毛发摸起来很舒服。"'
  );
  for (const [from, to] of [
    ["灵活的 lip", "灵巧的嘴唇"],
    ["棱角分明的下颌线, and 蓬乱的, 黑色胡须", "棱角分明的下颌线和蓬乱的黑色胡须"],
    ["方形的下巴, chiseled jawline, and 蓬乱的, black 胡须", "方形的下巴、棱角分明的下颌线和蓬乱的黑色胡须"],
    ["an androgynous 脸 which leaves a subtle girly印象 with 灵活的 lip", "一张中性的脸庞，带着微妙的少女气质和灵巧的嘴唇"],
    ["You have two 乳房", "你有两只乳房"],
    ["You could easily fill a DD bra.", "你可以轻松撑满一件 DD 罩杯胸罩。"],
    ["You could easily fill an A bra.", "你可以轻松撑满一件 A 罩杯胸罩。"],
    ["肛门肛门", "肛门"],
    ["屁眼肛门", "肛门"],
    ["无人认领 肛门", "未经使用的肛门"],
    ["处女 肛门", "处女肛门"],
    ["a 舒适的衣服", "一套舒适的衣服"],
    ["Your 征服者胸甲 clanks and jingles with every step you take.", "你的征服者胸甲随着每一步发出铿锵碰撞声。"],
    ["The average-sized areolae are", "平均大小的乳晕呈"],
    [" inches around and ", "英寸周长，"],
  ]) source = source.split(from).join(to);

  // appearance_round1_exact_templates
  source = source.replace(
    'e.hands&&e.feet?l+=" Meanwhile, your hands and feet are clad in "+e.hands.name+" and "+e.feet.name+" respectively.":e.hands?l+=" Elsewhere, your hands are covered by your "+e.hands.name+".":e.feet&&(l+=" Meanwhile, your feet are garbed in your "+e.feet.name+".")',
    'e.hands&&e.feet?l+=" 与此同时，你的双手和双脚分别穿戴着"+e.hands.name+"和"+e.feet.name+"。":e.hands?l+=" 此外，你的双手戴着"+e.hands.name+"。":e.feet&&(l+=" 与此同时，你的双脚穿着"+e.feet.name+"。")'
  );
  source = source.replace(
    'e.head&&(l+=u?" Further up, your "+(rand(2)?e.head.name:"helm")+" sits atop your head, helping protect your skull from enemy attacks[silly| and motorcycle accidents].":" Further up, your "+e.head.name+" sits on your head, helping shield your eyes from the sun[silly| and keeping you looking stylish].")',
    'e.head&&(l+=u?" 再往上，你的"+(rand(2)?e.head.name:"头盔")+"戴在头上，保护你的头颅免受敌人攻击[silly|以及摩托车事故]。":" 再往上，你的"+e.head.name+"戴在头上，帮助你的眼睛遮挡阳光[silly|同时让你看起来很时髦]。")'
  );
  source = source.replace(
    'e.shoulders&&(l+=oe()?" Your "+e.shoulders.name+" flows behind you, billowing in the cold wind.":" Your "+e.shoulders.name+" rest comfortably on your top, "+(e.shoulders.tags.includes(GLOBALS.ITEM_TAG_CLOTH)?"the cloth falling to fit you perfectly.":e.shoulders.tags.includes(GLOBALS.ITEM_TAG_LEATHER)?"the leather fitting your form surprisingly well.":"though the weight can be inconvenient at times."))',
    'e.shoulders&&(l+=oe()?" 你的"+e.shoulders.name+"在你身后飘动，在寒风中翻卷。":" 你的"+e.shoulders.name+"舒适地披在你的上身，"+(e.shoulders.tags.includes(GLOBALS.ITEM_TAG_CLOTH)?"布料垂落得恰到好处，完美贴合你的身形。":e.shoulders.tags.includes(GLOBALS.ITEM_TAG_LEATHER)?"皮革意外地贴合你的身形。":"只是重量偶尔会有些碍事。"))'
  );
  source = source.replace(
    'else if(1===e.cockTotal())t+="Your "+e.simpleCockNoun(0)+" is "+Math.floor(10*e.cocks[0].length())/10+" inches long and ",Math.floor(10*e.cocks[0].thickness())/10<2&&Math.floor(10*e.cocks[0].thickness())/10==1?t+=Math.round(10*e.cocks[0].thickness())/10+" inch thick.":t+=Math.round(10*e.cocks[0].thickness())/10+" inches across.",t+=ce(e,0);',
    'else if(1===e.cockTotal())t+="你的"+e.simpleCockNoun(0)+"长"+Math.floor(10*e.cocks[0].length())/10+"英寸，宽",Math.floor(10*e.cocks[0].thickness())/10<2&&Math.floor(10*e.cocks[0].thickness())/10==1?t+=Math.round(10*e.cocks[0].thickness())/10+"英寸。":t+=Math.round(10*e.cocks[0].thickness())/10+"英寸。",t+=ce(e,0);'
  );

  // appearance_round1b_exact_generated_fragments
  source = source.replace(
    'r+="Your face is ".concat("human"!==e.race()?"[rand|mostly|largely] ":"","human in form, ").concat("human"!==e.race()?"though you have":"with"," ")+e.skin(!0,!0,!0)+"."',
    'r+="你的面容".concat("human"!==e.race()?"[rand|大体上|基本上] ":"","呈人类形态，").concat("human"!==e.race()?"不过你有":"有着","")+e.skin(!0,!0,!0)+"。"'
  );
  source = source.replace(
    'r+="Your face is ".concat("human"!==e.race()?"[rand|mostly|largely] ":"","human in form, ").concat("human"!==e.race()?"and you have":"with"," ")+e.skin(!0,!0,!0)+"."',
    'r+="你的面容".concat("human"!==e.race()?"[rand|大体上|基本上] ":"","呈人类形态，").concat("human"!==e.race()?"并且你有":"有着","")+e.skin(!0,!0,!0)+"。"'
  );
  source = source.replace(
    't+="\\n\\nYou have one "+e.assholeDesc(!0)+", placed between your cheeks where it belongs"',
    't+="\\n\\n你有一个"+e.assholeDesc(!0)+"，位于双臀之间本该在的位置"'
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

  // remaining_user_reported_round3: safe display names and final combat wording fixes.
  source = replaceStringLiterals(source, [
    ["Defending", "防御中"],
  ]);

  // remaining_user_reported_round2: fix exact misses from compressed dynamic strings.
  source = source
    .split("You can't flee from this encounter.").join("你无法从这场遭遇中逃跑。")
    .split("You've been Disarmed and can't Attack.").join("你已被缴械，无法攻击。")
    .split("[pc.CombatName] concentrate on [target.combatName], trying to get a sense for where [target.combatHisHer] attention is focusing — how [target.combatHeShe]'s trying to defend [target.combatHimHer]self and which of your body's movements catch [target.combatHisHer] attention.").join("[pc.CombatName]集中注意力观察[target.combatName]，试着判断[target.combatHisHer]的注意力集中在哪里——[target.combatHeShe]会如何防御[target.combatHimHer]自己，以及你身体的哪些动作会吸引[target.combatHisHer]注意。")
    .split("[pc.CombatName] gather the following information about [target.combatName] from your brief analysis:").join("[pc.CombatName]通过短暂分析，获得了以下关于[target.combatName]的信息：")
    .split("[pc.CombatName] fail to gain any particular insights!").join("[pc.CombatName]没能获得任何特别有用的洞察！")
    .split("You're not sure if anything really happens, but you have to admit, you feel a little more sexy, a little more bangable... <b>a little more breedable</b>.").join("你不确定是否真的发生了什么，但你不得不承认，自己感觉更性感、更诱人……<b>也更适合被繁育了</b>。");

  source = source
    .replace("attacker.isPC()?\"There is\":\"You can see\",silly?\"OwO what's\":\"这到底是\"", "attacker.isPC()?\"可以看到\":\"你可以看到\",silly?\"OwO这是\":\"这到底是\"")
    .replace("attacker.isPC()?\"There is\":\"You can see\",silly?\"OwO what's\":\"这是什么魔法\"", "attacker.isPC()?\"可以看到\":\"你可以看到\",silly?\"OwO这是\":\"这到底是\"")
    .replace("attacker.isPC()?\"There is\":\"You can see\",silly?\"OwO what's\":\"What kind of magic is\"", "attacker.isPC()?\"可以看到\":\"你可以看到\",silly?\"OwO这是\":\"这到底是\"");

  // remaining_user_reported_round1: safe display-only replacements for dynamic combat/menu fragments.
  source = replaceStringLiterals(source, [
    ["The last blow lands on ", "最后一击结结实实地落在"],
    [" with authority, sending the cat-girl teetering back. She yelps with alarm and then falls on her ass, legs splayed to reveal her silky white panties to the world. Her head flops back on the ground a moment after, the fight completely gone out of her.", "身上，打得这位猫女踉跄后退。她惊叫一声，跌坐在地，双腿摊开，丝滑的白色内裤暴露无遗。片刻后，她的脑袋也垂落到地面，彻底失去了战意。"],
    ["Try and suss out an opponent's weaknesses and resistances. Applies to lustful, magical, and martial combat alike.", "尝试看穿对手的弱点与抗性。对欲望、魔法和武技战斗都适用。"],
    ["You've already sensed all the enemies. Click the three dots on their Character Card to view details.", "你已经感知过所有敌人。点击角色卡上的三个点即可查看详情。"],
    ["There are no targets that you can sense!", "没有可以感知的目标！"],
    ["[pc.CombatName] concentrate on [target.combatName], trying to get a sense for where [target.combatHisHer] attention is focusing — how [target.combatHeShe] is trying to defend [target.combatHimHer]self and which of your body's movements catch [target.combatHisHer] attention.", "[pc.CombatName]集中注意力观察[target.combatName]，试着判断[target.combatHisHer]的注意力集中在哪里——[target.combatHeShe]会如何防御[target.combatHimHer]自己，以及你身体的哪些动作会吸引[target.combatHisHer]注意。"],
    ["[pc.CombatName] gather the following information about [target.combatName] from your brief analysis:", "[pc.CombatName]通过短暂分析，获得了以下关于[target.combatName]的信息："],
    ["[pc.CombatName] fail to gain any particular insights!", "[pc.CombatName]没能获得任何特别有用的洞察！"],
    ["Make an attack with your ", "使用你的"],
    ["Make use of your weapons and magic to finish a foe off. Make an attack with each weapon, gaining +", "运用你的武器和魔法终结敌人。用每件武器发动一次攻击，获得+"],
    ["Have the game's AI automatically take action.", "让游戏的 AI 自动采取行动。"],
    ["You feel a pleasant tightness in your balls, like they're being lovingly caressed, hefting up and held together in a partner's hands. You shiver, letting the sensation carry you to its inevitable end, just short of climax.\n\n    When the sensation passes, you reach down to feel yourself, acting entirely on instinct. When your fingers brush across your balls, you find that they're a little more compact, held together by taut, supple flesh... <b>you've got a trap pouch now!</b>", "你感觉睾丸上传来一种令人愉悦的紧致感，像是正被伴侣的双手温柔地托起、合拢并爱抚。你轻轻颤抖，任由这种感觉将你带向它不可避免的终点，只差一点便要达到高潮。\n\n    当这种感觉退去后，你本能地伸手摸向自己。当手指掠过睾丸时，你发现它们变得更紧凑了，被紧致而柔韧的皮肉收拢在一起……<b>你现在有了一个陷阱袋！</b>"],
    ["The sway of your step feels odd, like there's more meat kicking around down there. Taking a few more steps, you notice that your gait is wider than before. <b>Your hips have definitely widened.</b>", "你的步伐摇摆得有些奇怪，像是下面多了些肉在晃动。又走了几步后，你发现自己的步态比以前更宽了。<b>你的臀胯确实变宽了。</b>"],
    ["You're not sure if anything really happens, but you have to admit, you feel a little more sexy, a little more bangable... <b>a little more breedable</b>.", "你不确定是否真的发生了什么，但你不得不承认，自己感觉更性感、更诱人……<b>也更适合被繁育了</b>。"],
  ]);

  // round3_673_raw_fragment_replacements
  for (const [from, to] of [
    [", capped with one ", "，每侧有一枚"],
    [" nipple each.", "乳头。"],
    [" inches long and ", "英寸，宽"],
    [" inches across.", "英寸。"],
    [" inch thick.", "英寸粗。"],
    [" inches wide.", "英寸宽。"],
    ["one inch wide.", "一英寸宽。"],
    [" scrotum with ", "阴囊，里面有"],
    [" swings heavily beneath your ", "沉甸甸地悬在你的"],
    ["You estimate each testicle to be about ", "你估计每颗睾丸大约"],
    ["You estimate the testicle to be about ", "你估计这颗睾丸大约"],
    [" inches around and ", "英寸周长，"],
    ["You have one ", "你有一个"],
    [" asshole, placed between your cheeks where it belongs.", "肛门，位于双臀之间本该在的位置。"],
    [" backdoor, placed between your cheeks where it belongs.", "后庭，位于双臀之间本该在的位置。"],
    ["Blue-colored", "蓝色的"],
    ["blue-colored", "蓝色的"],
    ["bronze skin", "古铜色皮肤"],
    ["black hair", "黑色头发"],
    ["shoulder-length, black hair", "齐肩的黑色头发"],
    ["shoulder-length, black 头发", "齐肩的黑色头发"],
    ["chiseled jawline", "棱角分明的下颌线"],
    ["facial hair", "面部毛发"],

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
    ["A cat-tail sprouts just above your backside, curling and twisting with every step to maintain perfect balance.", "一条猫尾从你臀部上方伸出，随着每一步卷曲摆动，帮助你保持完美的平衡。"],
    ["Your middle is fairly well-toned.", "你的腹部线条相当紧致。"],
    ["You have A-cup breasts, ", "你有 A 罩杯的乳房，"],
    [" small, pert", "小巧而挺翘的"],
    [" boobs that almost vanish under anything thicker than spandex", "乳房，穿上比氨纶更厚的衣物时几乎会消失不见"],
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
    ["a 舒适的衣服", "一套舒适的衣服"]
  ]) source = source.split(from).join(to);
  // appearance_getdescribe_robust_source_patches
  // Robust source-level fixes for Appearance/getDescribe strings. These are template fixes, not final-output cleanup.
  source = source.replace(/t="\\n\\nYou have a humanoid upper body with the usual torso, arms, hands, and fingers"/g,
    't="\\n\\n你有类人的上半身，拥有常见的躯干、手臂、双手和手指"');
  source = source.replace(/return" "+capitalize(num2Text(e.legCount))+"条普通的人类双腿从你的腰部向下延伸，末端是普通的人类双脚。"/g,
    'return" 你的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.legCount)):num2Text(e.legCount))+"条普通的人类双腿从你的腰部向下延伸，末端是普通的人类双脚。"');
  source = source.replace(/return" "+capitalize(num2Text(e.legCount))+" "+(["furred","gooey"][e.legTag(GLOBALS.BODY_TAG_FURRED,GLOBALS.BODY_TAG_GOOEY)]||"normal")+" human legs extend below your waist, ending in normal human feet."/g,
    'return" 你的"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.legCount)):num2Text(e.legCount))+"条普通的人类双腿从你的腰部向下延伸，末端是普通的人类双脚。"');
  source = source.replace(/case 10:return" Your (?:maw|mouth) contains a tongue."/g,
    'case 10:return" 你的口中有一条舌头。"');
  source = source.replace(/t+=" The "+e.areolaSizeDesc()+" areolae are "+e.nippleColor+"."/g,
    't+=" "+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.areolaSizeDesc()):e.areolaSizeDesc())+"乳晕呈"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.nippleColor):e.nippleColor)+"。"');
  source = source.replace(/t+=" The "+e.areolaSizeDesc()+" areolae are "+e.nippleColor()+"."/g,
    't+=" "+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.areolaSizeDesc()):e.areolaSizeDesc())+"乳晕呈"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.nippleColor()):e.nippleColor())+"。"');
  source = source.split('t+=Math.round(10*e.cocks[0].thickness())/10+"英寸宽。"').join('t+=Math.round(10*e.cocks[0].thickness())/10+"英寸。"');


  // appearance_word_mapping_fixed_glue
  source = source.split('a+" eyes allow you to take in your surroundings without trouble."').join('a+"眼睛让你能够毫无困难地观察周围。"');
  source = source.split('i+=" Your "+e.hairDesc(!0,!0)+" looks good on you, accentuating your features well."').join('i+=" 你的"+(globalThis.cnBodyLabel?globalThis.cnBodyLabel(e.hairDesc(!0,!0)):e.hairDesc(!0,!0))+"很适合你，也很好地衬托出你的五官。"');
  source = source.split('" Your mouth contains a tongue."').join('" 你的口中有一条舌头。"');
  source = source.split('" Your maw contains a tongue."').join('" 你的口中有一条舌头。"');
  source = source.split('r.hasTongueTags(GLOBALS.BODY_TAG_LONG)?" Your "+r.mouthDesc(!0)+" contains a lengthy tongue.":" Your "+r.mouthDesc(!0)+" contains [a] [pc.tongue]."').join('r.hasTongueTags(GLOBALS.BODY_TAG_LONG)?" 你的"+(globalThis.cnBodyLabel?globalThis.cnBodyLabel(r.mouthDesc(!0)):r.mouthDesc(!0))+"里有一条修长的舌头。":" 你的"+(globalThis.cnBodyLabel?globalThis.cnBodyLabel(r.mouthDesc(!0)):r.mouthDesc(!0))+"里有一条[pc.tongue]。"');
  source = source.split('" Your "+randCollection("belly","midriff","middle","six pack")+" is rock-hard, shaped by a good diet, steady conditioning, or both."').join('" 你的"+(globalThis.cnBodyLabel?globalThis.cnBodyLabel(randCollection("belly","midriff","middle","six pack")):randCollection("belly","midriff","middle","six pack"))+"坚硬结实，显然得益于良好的饮食、稳定的锻炼，或两者兼有。"');
  source = source.split('" Your "+randCollection("belly","midriff","middle","six pack")+" is fairly well-toned."').join('" 你的"+(globalThis.cnBodyLabel?globalThis.cnBodyLabel(randCollection("belly","midriff","middle","six pack")):randCollection("belly","midriff","middle","six pack"))+"线条相当紧致。"');
  source = source.split('" Your [pc.belly] is nice and smooth."').join('" 你的[pc.belly]光滑平坦。"');
  source = source.split('return t}(e)+".";return e.hasWings()').join('return t}(e)+"。";return e.hasWings()');
  source = source.split('return t+=" 总体而言，你的容貌有着"+e.faceDesc()+".",').join('return t+=" 总体而言，你的容貌有着"+e.faceDesc()+"。",');

  // appearance_breast_source_templates
  for (const [from, to] of [
    [
      'e.biggestTitSize()>1?t+="You have "+num2Text(e.breastRows[0].breasts)+" "+e.breastDesc(0,!0)+", capped with "',
      'e.biggestTitSize()>1?t+="你有"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.breastRows[0].breasts)):num2Text(e.breastRows[0].breasts))+"只"+e.breastDesc(0,!0)+"，每侧有"'
    ],
    [
      't+=", capped with "',
      't+="，每侧有"'
    ],
    [
      '1===e.nipplesPerBreast?t+=num2Text(e.nipplesPerBreast)+" "+Math.round(10*e.nippleLength(0))/10+"-inch "+e.nippleDesc(0)+" each.":t+=num2Text(e.nipplesPerBreast)+" "+Math.round(10*e.nippleLength(0))/10+"-inch "+plural(e.nippleDesc(0))+" each."',
      '1===e.nipplesPerBreast?t+=(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.nipplesPerBreast)):num2Text(e.nipplesPerBreast))+"枚"+Math.round(10*e.nippleLength(0))/10+"英寸的"+e.nippleDesc(0)+"。":t+=(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.nipplesPerBreast)):num2Text(e.nipplesPerBreast))+"枚"+Math.round(10*e.nippleLength(0))/10+"英寸的"+plural(e.nippleDesc(0))+"。"'
    ],
    [
      '1===e.nipplesPerBreast?t+=num2Text(e.nipplesPerBreast)+" "+e.nippleDesc(0)+" each.":t+=num2Text(e.nipplesPerBreast)+" "+plural(e.nippleDesc(0))+" each."',
      '1===e.nipplesPerBreast?t+=(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.nipplesPerBreast)):num2Text(e.nipplesPerBreast))+"枚"+e.nippleDesc(0)+"。":t+=(globalThis.cnAttrLabel?globalThis.cnAttrLabel(num2Text(e.nipplesPerBreast)):num2Text(e.nipplesPerBreast))+"枚"+plural(e.nippleDesc(0))+"。"'
    ],
    [
      't+=" When you\'re aroused enough, your "+Math.round(10*e.nippleLength(0))/10+"-inch nipples pop out, ready for action."',
      't+=" 当你足够兴奋时，"+Math.round(10*e.nippleLength(0))/10+"英寸的乳头会挺立出来，蓄势待发。"'
    ],
    [
      't+=" You could easily fill [a] "+breastSizeToCup(e.breastRows[0].size())+" bra."',
      't+=" 你可以轻松撑满一件"+breastSizeToCup(e.breastRows[0].size())+"罩杯胸罩。"'
    ]
  ]) source = source.split(from).join(to);

  // appearance_getdescribe_split_fallbacks
  // Exact split/join fallbacks for minified source fragments containing regex-special chars.
  for (const [from, to] of [
    [
      't="\\n\\nYou have a humanoid upper body with the usual torso, arms, hands, and fingers"',
      't="\\n\\n你有类人的上半身，拥有常见的躯干、手臂、双手和手指"'
    ],
    [
      't+=" The "+e.areolaSizeDesc()+" areolae are "+e.nippleColor+"."',
      't+=" "+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.areolaSizeDesc()):e.areolaSizeDesc())+"乳晕呈"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.nippleColor):e.nippleColor)+"。"'
    ],
    [
      't+=" The "+e.areolaSizeDesc()+" areolae are "+e.nippleColor()+"."',
      't+=" "+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.areolaSizeDesc()):e.areolaSizeDesc())+"乳晕呈"+(globalThis.cnAttrLabel?globalThis.cnAttrLabel(e.nippleColor()):e.nippleColor())+"。"'
    ],
    [
      't+=Math.round(10*e.cocks[0].thickness())/10+"英寸宽。"',
      't+=Math.round(10*e.cocks[0].thickness())/10+"英寸。"'
    ]
  ]) source = source.split(from).join(to);

  return source;
}

function patchContentOtherCreationUi(source) {

  const labelMap = {
    pale: "苍白", fair: "白皙", tanned: "晒黑", olive: "橄榄色", bronze: "古铜色", dusky: "暗褐色", dark: "深色", black: "黑色",
    "dark green": "深绿色", green: "绿色", "light green": "浅绿色", gray: "灰色",
    brown: "棕色", red: "红色", blonde: "金发", blue: "蓝色", silver: "银色", orange: "橙色", gold: "金色", white: "白色", purple: "紫色",
    hazel: "榛色", amber: "琥珀色", golden: "金色",
    unkempt: "蓬乱", afro: "爆炸头", "afro ponytail": "爆炸头马尾", "afro puffs": "爆炸头蓬蓬发",
    bald: "光头", bob: "波波头", "box braids": "盒形辫", braided: "编辫", "braid pompadour": "辫子蓬巴杜",
    bun: "发髻", curls: "卷发", dreadlocks: "脏辫", "dread ponytail": "脏辫马尾", fade: "渐层短发",
    flattop: "平顶头", mohawk: "莫霍克", "obfuscating afro": "遮脸爆炸头", ponytail: "马尾",
    rugged: "粗犷发型", shaggy: "蓬乱短发", short: "短发", "side-cut": "侧削发", "side-cut dreads": "侧削脏辫",
    spiky: "尖刺发", "spiky with bangs": "带刘海尖刺发", straight: "直发", "top knot dreadlocks": "顶髻脏辫", twintails: "双马尾"
  };
  const inject = "window.cnCreateLabel=function(e){var t=String(e);return Object.prototype.hasOwnProperty.call(window.cnCreateLabel.map,t.toLowerCase())?window.cnCreateLabel.map[t.toLowerCase()]:capitalize(t)},window.cnCreateLabel.map=" + JSON.stringify(labelMap) + ",";
  if (!source.includes("window.cnCreateLabel=function")) {
    source = source.replace("window.ChooseSkinColor=function", inject + "window.ChooseSkinColor=function");
  }
  source = source
    .replace('output("And skin color?")', 'output("那肤色呢？")')
    .replace('addButton(t,capitalize(e),(function(){return ChooseHairColor(e)}),"","")', 'addButton(t,window.cnCreateLabel(e),(function(){return ChooseHairColor(e)}),"","")')
    .replace('addDropdown("Hairstyles:",i.map((function(e){return e.style})),s.style,', 'addDropdown("发型：",i.map((function(e){return window.cnCreateLabel(e.style)})),window.cnCreateLabel(s.style),')
    .replace('addDropdown("发型：",i.map((function(e){return e.style})),s.style,', 'addDropdown("发型：",i.map((function(e){return window.cnCreateLabel(e.style)})),window.cnCreateLabel(s.style),')
    .replace('addSliderInput("Hair Length: ".concat(pc.hairLength,', 'addSliderInput("头发长度：".concat(pc.hairLength,')
    .replace('addButton(t,capitalize(e),(function(){return ChooseEyeColor(e)}),"","")', 'addButton(t,window.cnCreateLabel(e),(function(){return ChooseEyeColor(e)}),"","")')
    .replace('output("And your eye color?")', 'output("那眼睛颜色呢？")')
    .replace('addButton(t,capitalize(e),(function(){return ChooseHeight(e)}),"","")', 'addButton(t,window.cnCreateLabel(e),(function(){return ChooseHeight(e)}),"","")');
  return source;
}

function patch505ParserPronouns(source) {
  source = source.replace(
    'case"his":case"hisHer":return this.mf("his","her");case"hisHers":return this.mf("his","hers");case"combatHis":case"combatHisHer":return this.pcplmf("your","their","his","her");case"combatHisHers":return this.pcplmf("yours","theirs","his","hers");',
    'case"his":case"hisHer":return this.mf("他的","她的");case"hisHers":return this.mf("他的","她的");case"combatHis":case"combatHisHer":return this.pcplmf("你的","他们的","他的","她的");case"combatHisHers":return this.pcplmf("你的","他们的","他的","她的");'
  );
  source = source.replace(
    'case"him":case"himHer":return this.mf("him","her");case"boy":case"girl":case"boyGirl":return this.mf("boy","girl");case"master":case"mistress":return this.mf("master","mistress");case"combatHim":case"combatHimHer":return this.pcplmf("you","them","him","her");case"combatHimself":case"combatHerself":case"combatHimselfHerself":return this.pcplmf("yourself","themselves","himself","herself");case"himself":case"herself":case"himselfHerself":return this.mf("himself","herself");case"he":case"she":case"heShe":return this.mf("he","she");case"hes":case"shes":case"hesShes":return this.mf("he\'s","she\'s");case"combatHe":case"combatShe":case"combatHeShe":return this.pcplmf("you","they","he","she");case"combatHe\'s":case"combatShe\'s":case"combatHe\'sShe\'s":case"combatHes":case"combatShes":case"combatHesShes":return this.pcplmf("you\'re","they\'re","he\'s","she\'s");',
    'case"him":case"himHer":return this.mf("他","她");case"boy":case"girl":case"boyGirl":return this.mf("男孩","女孩");case"master":case"mistress":return this.mf("主人","女主人");case"combatHim":case"combatHimHer":return this.pcplmf("你","他们","他","她");case"combatHimself":case"combatHerself":case"combatHimselfHerself":return this.pcplmf("你自己","他们自己","他自己","她自己");case"himself":case"herself":case"himselfHerself":return this.mf("他自己","她自己");case"he":case"she":case"heShe":return this.mf("他","她");case"hes":case"shes":case"hesShes":return this.mf("他","她");case"combatHe":case"combatShe":case"combatHeShe":return this.pcplmf("你","他们","他","她");case"combatHe\'s":case"combatShe\'s":case"combatHe\'sShe\'s":case"combatHes":case"combatShes":case"combatHesShes":return this.pcplmf("你","他们","他","她");'
  );
  return source;
}

function patch505DynamicAttributeLabels(source) {
  // appearance_source_skin_color_noun
  // Make skin()/skinFurScales() return localized display labels without changing stored color keys.
  source = source.replace(
    'i+this.skinNoun(a,n)}},{key:"skinFurScalesColor"',
    '(globalThis.cnBodyLabel?globalThis.cnBodyLabel(i+this.skinNoun(a,n)):i+this.skinNoun(a,n))}},{key:"skinFurScalesColor"'
  );

  // appearance_505_getdescribe_label_returns
  // Map dynamic descriptor fragments at their source-return points.
  source = source.split('return n+"head"}if(!t').join('return (globalThis.cnBodyLabel?globalThis.cnBodyLabel(n+"head"):n+"head")}if(!t');
  source = source.split('return n+"face"}return(t||0===rand(4))').join('return (globalThis.cnBodyLabel?globalThis.cnBodyLabel(n+"face"):n+"face")}return(t||0===rand(4))');
  source = source.split('rand(2)?n+="facial hair":n+="beard",n}},{key:"skinNoun"').join('rand(2)?n+="facial hair":n+="beard",globalThis.cnBodyLabel?globalThis.cnBodyLabel(n):n}},{key:"skinNoun"');
  source = source.split('rand(2)?n+="面部毛发":n+="胡须",n}},{key:"skinNoun"').join('rand(2)?n+="面部毛发":n+="胡须",globalThis.cnBodyLabel?globalThis.cnBodyLabel(n):n}},{key:"skinNoun"');
  source = source.split('else n+="头发";return n}},{key:"hairSimpleNoun"').join('else n+="头发";return globalThis.cnBodyLabel?globalThis.cnBodyLabel(n):n}},{key:"hairSimpleNoun"');
  // appearance_word_level_descriptor_returns
  source = source.split('else n+="hair";return n}},{key:"hairSimpleNoun"').join('else n+="hair";return globalThis.cnBodyLabel?globalThis.cnBodyLabel(n):n}},{key:"hairSimpleNoun"');
  source = source.split('rand(2)?n+="facial hair":n+="beard",n}},{key:"skinNoun"').join('rand(2)?n+="facial hair":n+="beard",globalThis.cnBodyLabel?globalThis.cnBodyLabel(n):n}},{key:"skinNoun"');
  source = source.split('""!==n&&(n+=" "),n+r[rand(r.length)]}},{key:"tongueDesc"').join('""!==n&&(n+=" "),globalThis.cnBodyLabel?globalThis.cnBodyLabel(n+r[rand(r.length)]):n+r[rand(r.length)]}},{key:"tongueDesc"');

  // source_body_label_asshole_desc
  // Narrow source-level mapping for assholeDesc() display output only.
  // This avoids translating internal keys while preventing mixed strings such as "tailhole肛门".
  const bodyLabelMap = {
    "asshole": "肛门",
    "anus": "肛门",
    "pucker": "菊口",
    "butthole": "后穴",
    "sphincter": "括约口",
    "backdoor": "后庭",
    "tailhole": "尾下后庭",
    "donut": "环口",
    "skin": "皮肤",
    "fur": "毛皮",
    "scales": "鳞片",
    "lip": "嘴唇",
    "lips": "嘴唇",
    "hair": "头发",
    "head": "头部",
    "face": "面部",
    "head-fur": "头部毛发",
    "head-feathers": "头部羽毛",
    "maw": "口腔",
    "mouth": "口腔",
    "tongue": "舌头",
    "belly": "腹部",
    "midriff": "腰腹",
    "middle": "腰腹",
    "six": "六",
    "pack": "块腹肌",
    "nipple": "乳头",
    "nipples": "乳头",
    "areola": "乳晕",
    "areolae": "乳晕",
    "puffy": "微肿的",
    "plump": "饱满的",
    "fat": "丰厚的",
    "crinkly": "皱褶的",
    "soft": "柔软的",
    "spongy": "绵软的",
    "huge": "巨大的",
    "bloated": "鼓胀的",
    "pillowy": "枕垫般柔软的",
    "slutty": "淫荡的",
    "fuck-hungry": "渴求交合的",
    "cock-hungry": "渴求肉棒的",
    "fuckable": "诱人的",
    "puckered": "收紧的",
    "eager": "渴望的",
    "greedy": "贪婪的",
    "ravenous": "饥渴的",
    "insatiable": "难以满足的", "无人认领": "处子", "未受破坏的": "处子", "smooth": "光滑的", "sleek": "光滑的", "supple": "柔软的", "succulent": "饱满诱人的", "nice": "秀气的", "petite": "小巧的", "shapely": "优美的", "playful": "俏皮的", "moderately long": "略长的", "shoulder-length": "齐肩的", "ass-length": "齐臀长的", "brown": "棕色", "black": "黑色", "blue": "蓝色", "fair": "白皙的", "bronze": "古铜色", "humanoid": "类人型"
  };
  const injectBody = `globalThis.cnBodyLabel=globalThis.cnBodyLabel||function(e){var bm=globalThis.cnBodyLabel.map||{},am=globalThis.cnAttrLabel&&globalThis.cnAttrLabel.map||{},all=Object.assign({},am,bm),parts=String(e).split(/([,，]\\s*)/),out="";for(var p=0;p<parts.length;p++){var part=parts[p];if(/^[,，]\\s*$/.test(part))continue;var lead=(part.match(/^\\s+/)||[""])[0],trail=(part.match(/\\s+$/)||[""])[0],core=part.trim();if(!core){out+=part;continue}var exact=core.toLowerCase();if(Object.prototype.hasOwnProperty.call(all,exact)){out+=all[exact];continue}var words=core.split(/\\s+/),vals=[];for(var i=0;i<words.length;){var hit=null,take=0;for(var len=Math.min(4,words.length-i);len>0;len--){var key=words.slice(i,i+len).join(" ").toLowerCase();if(Object.prototype.hasOwnProperty.call(all,key)){hit=all[key];take=len;break}}if(null===hit){hit=words[i];take=1}if(vals.length&&/[A-Za-z0-9]$/.test(vals[vals.length-1])&&/^[A-Za-z0-9]/.test(hit))vals.push(" ");vals.push(hit);i+=take}out+=lead+vals.join("")+trail}return out.replace(/([\u4e00-\u9fff])\\s+([\u4e00-\u9fff])/g,"$1$2")};globalThis.cnBodyLabel.map=Object.assign(globalThis.cnBodyLabel.map||{},${JSON.stringify(bodyLabelMap)});`;
  if (!source.includes("globalThis.cnBodyLabel=globalThis.cnBodyLabel||function")) source = source.includes('"use strict";') ? source.replace('"use strict";', '"use strict";' + injectBody) : injectBody + source;
  source = source.replace('t+="donut",t}}],a&&h(t.prototype,a)', 't+="donut",globalThis.cnBodyLabel?globalThis.cnBodyLabel(t):t}}],a&&h(t.prototype,a)');

  // appearance_round3_505_face_and_body_fragments
  for (const [from, to] of [["e=\"an androgynous \"+this.face(),e+=\" which leaves a subtle \"+this.mf(\"孩子气十足的\",\"girly\",!0)+\"印象\"","e=\"一张中性的\"+this.face(),e+=\"，带着微妙的\"+this.mf(\"少年感\",\"少女感\",!0)"],["this.hasBeard()?e+=\", chiseled jawline, and \"+this.beardDesc():e+=\"以及轮廓分明的下颌线\"","this.hasBeard()?e+=\"、棱角分明的下颌线和\"+this.beardDesc():e+=\"以及轮廓分明的下颌线\""],["e+=\", a pair of \"+plural(this.lipDesc(!0))+\"，以及颇具男性气质的侧脸轮廓\"","e+=\"、\"+plural(this.lipDesc(!0))+\"，以及颇具男性气质的侧脸轮廓\""],["\"succulent\"","\"饱满诱人的\""],["\"多肉植物\"","\"饱满诱人的\""],["\"supple\"","\"柔软的\""],["\"灵活的\"","\"柔软的\""],["\"工具\"","\"阴茎\""],["\"茎身\"","\"阴茎\""],["\"成员\"","\"阴茎\""],["\"下装\"","\"臀部\""]]) source = source.split(from).join(to);
  // appearance_dynamic_505_round2
  // Repair fixed Chinese glue and mistranslated random display choices at their generators.
  for (const [from, to] of [
    ['this.lipRating()>1&&(e+=" with "+plural(this.lipDesc(!0)))', 'this.lipRating()>1&&(e+="和"+plural(this.lipDesc(!0)))'],
    ['this.hasBeard()&&(e+=" in addition to your "+this.beardDesc())', 'this.hasBeard()&&(e+="，此外还有"+this.beardDesc())'],
    ['a+=randCollection(["髋部","髋部","髋部","侧腰"])', 'a+=randCollection(["髋部","髋部","髋部","髋部"])'],
    ['randCollection(["尾部","臀部",this.mf("屁股","屁股"),"追尾"])', 'randCollection(["臀部","臀部",this.mf("屁股","屁股"),"臀部"])'],
    ['o.push("紧致得令人难以置信，充满弹性")', 'o.push("紧致而富有弹性的")'],
    ['o.push("小巧却柔软","小巧却柔软","很小但柔软的","精致而柔软")', 'o.push("小巧柔软的","小巧柔软的","很小但柔软的","精致而柔软的")'],
    ['o.push("小小的","小小的","很小的","精致细腻")', 'o.push("小小的","小小的","很小的","精致小巧的")'],
    ['o.push("柔软、紧凑")', 'o.push("柔软紧致的")']
  ]) source = source.split(from).join(to);

  const labelMap = {
    "human": "人类", "humanoid": "类人型", "catfolk": "猫人", "orc": "兽人", "elf": "精灵", "elven": "精灵", "wyld elf": "野精灵", "lupine": "狼族", "minotaur": "弥诺陶洛斯", "kitsune": "狐妖", "harpy": "鹰身女妖",
    "male": "男性", "female": "女性", "man": "男性", "woman": "女性", "shemale": "双性人", "trap": "双性人",
    "warrior": "战士", "thief": "盗贼", "black mage": "黑魔法师", "white mage": "白魔法师", "charmer": "魅惑者", "arcanist": "奥术师",
    "soldier": "士兵", "noble scion": "贵族后裔", "acolyte": "侍僧", "barbarian": "野蛮人", "hunter": "猎人",
    "skinny": "瘦削", "thin": "纤瘦", "slender": "苗条", "average": "普通", "thick": "厚实", "bodybuilder": "健美", "well-built": "健壮", "thinly muscled": "肌肉单薄",
    "pale": "苍白", "fair": "白皙", "tanned": "晒黑", "olive": "橄榄色", "bronze": "古铜色", "dusky": "暗褐色", "dark": "深色", "black": "黑色", "regular": "普通的", "average-sized": "平均大小的",
    "dark green": "深绿色", "green": "绿色", "light green": "浅绿色", "gray": "灰色", "brown": "棕色", "red": "红色", "blonde": "金发", "blue": "蓝色", "silver": "银色", "orange": "橙色", "gold": "金色", "white": "白色", "pink": "粉色", "purple": "紫色", "hazel": "榛色", "amber": "琥珀色", "golden": "金色",
    "shoulder-length": "齐肩的", "neck-length": "及颈的", "butt-length": "齐臀长", "slightly long": "略长的", "moderately long": "略长的", "medium-length": "中等长度", "short": "短", "long": "长",
    "unkempt": "蓬乱的", "shaggy": "蓬乱的", "facial hair": "胡须", "beard": "胡须",
    "afro": "爆炸头", "afro ponytail": "爆炸头马尾", "afro puffs": "爆炸头蓬蓬发", "bald": "光头", "bob": "波波头", "box braids": "盒形辫", "braided": "编辫", "braid pompadour": "辫子蓬巴杜", "bun": "发髻", "curls": "卷发", "dreadlocks": "脏辫", "dread ponytail": "脏辫马尾", "fade": "渐层短发", "flattop": "平顶头", "mohawk": "莫霍克", "obfuscating afro": "遮脸爆炸头", "ponytail": "马尾", "rugged": "粗犷发型", "shaggy": "蓬乱短发", "side-cut": "侧削发", "side-cut dreads": "侧削脏辫", "spiky": "尖刺发", "spiky with bangs": "带刘海尖刺发", "straight": "直发", "top knot dreadlocks": "顶髻脏辫", "twintails": "双马尾"
  };
  const inject = "globalThis.cnAttrLabel=globalThis.cnAttrLabel||function(e){var t=String(e);var n=t.toLowerCase();return Object.prototype.hasOwnProperty.call(globalThis.cnAttrLabel.map,n)?globalThis.cnAttrLabel.map[n]:t};globalThis.cnAttrLabel.map=Object.assign(globalThis.cnAttrLabel.map||{}," + JSON.stringify(labelMap) + ");";
  if (!source.includes("globalThis.cnAttrLabel=globalThis.cnAttrLabel||function")) source = source.includes('"use strict";') ? source.replace('"use strict";', '"use strict";' + inject) : inject + source;
  for (const [from, to] of [
    ['case"skinColor":return this.skinColor;', 'case"skinColor":return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.skinColor):this.skinColor;'],
    ['case"skinFurScalesColor":return this.skinFurScalesColor();', 'case"skinFurScalesColor":var __cnv=this.skinFurScalesColor();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnv):__cnv;'],
    ['case"class":return this.getClassName();', 'case"class":var __cnc=this.getClassName();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnc):__cnc;'],
    ['case"background":return this.getBackgroundName();', 'case"background":var __cnb=this.getBackgroundName();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnb):__cnb;'],
    ['case"race":return this.race();', 'case"race":var __cnr=this.race();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnr):__cnr;'],
    ['case"raceAdjective":case"raceAdj":case"raceish":return this.raceAdj();', 'case"raceAdjective":case"raceAdj":case"raceish":var __cnra=this.raceAdj();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnra):__cnra;'],
    ['case"raceCute":return this.raceCute();', 'case"raceCute":var __cnrc=this.raceCute();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnrc):__cnrc;'],
    ['case"raceShort":return this.raceShort();', 'case"raceShort":var __cnrs=this.raceShort();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnrs):__cnrs;'],
    ['case"gender":case"sex":return this.sex();', 'case"gender":case"sex":var __cns=this.sex();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cns):__cns;'],
    ['case"hairColor":return this.hairColor;', 'case"hairColor":return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.hairColor):this.hairColor;'],
    ['case"lipColor":return this.lipColor;', 'case"lipColor":return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.lipColor):this.lipColor;'],
    ['case"startingRace":case"originalRace":return this.originalRace;', 'case"startingRace":case"originalRace":return globalThis.cnAttrLabel?globalThis.cnAttrLabel(this.originalRace):this.originalRace;'],
    ['case"bodyType":case"bodyShape":case"physique":return this.bodyShape();', 'case"bodyType":case"bodyShape":case"physique":var __cnbs=this.bodyShape();return globalThis.cnAttrLabel?globalThis.cnAttrLabel(__cnbs):__cnbs;'],
    ['case"tongue":return this.tongueDesc();', 'case"tongue":var __cnt=this.tongueDesc();return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__cnt):__cnt;'],
    ['case"tongueNoun":return this.tongueNoun();', 'case"tongueNoun":var __cntn=this.tongueNoun();return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__cntn):__cntn;'],
    ['case"tongueNounSimple":return this.tongueNoun(!0);', 'case"tongueNounSimple":var __cnts=this.tongueNoun(!0);return globalThis.cnBodyLabel?globalThis.cnBodyLabel(__cnts):__cnts;']
  ]) source = source.replace(from, to);

  return source;
}

function patchRuntimeHelpers(source, appName) {
  source = patchSelectItemShortLabels(source, appName);
  if (appName.startsWith("505.")) {
    source = patch505CombatPhrases(source);
    source = patch505ParserPronouns(source);
    source = patch505DynamicAttributeLabels(source);
  }
  if (appName.startsWith("673.")) source = patch673UiLabels(source);
  if (appName.startsWith("Content_Other.")) source = patchContentOtherCreationUi(source);
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

