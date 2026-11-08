# COC2 自动更新不怎么靠谱小程序

包内已提供大多数所需求环境/代码。但仍需自行准备Node.Js 24或更新版本

小程序里有:

- `Updater.exe`
- 最小化的迁移/应用脚本
- Prettier 3.6.2
- `defaults/glossary/mapping_apply.json`
- `defaults/glossary/coc2_glossary_en_zh_structured.json`

如果你先前用过自动更新，你的translator里应该具有<b>mapping_apply和coc2_glossary_en_zh_structured</b>

如果未用过，会自动从defaults里拷贝过去，不用担心 :D

双击运行Updater.exe，先选择检测环境，再选择更新，输入旧/新目录即可自动更新

旧目录需<b>具有translated_json</b>，否则无法更新（没汉化文本没法更新）

注意，更新无法完美迁移文本，可自行通过GPT/Claude/DS/豆包（真会有人用吗）补全剩余文本

[]~(￣▽￣)~*



# COC2 AutoUpdate

This package is self-contained except for Node.js 24 or newer

It includes:

- `Updater.exe`
- the minimum migration/apply scripts
- Prettier 3.6.2
- `defaults/glossary/mapping_apply.json`
- `defaults/glossary/coc2_glossary_en_zh_structured.json`

If you have previously used automatic updates, your translator should already have <b>mapping_apply and coc2_glossary_en_zh_structured</b> in it

If you haven't used it before, it will automatically copy from defaults. DW :D

Double-click to run Updater.exe. First, select the detection environment, then select the update, and enter the old/new directories to automatically update

The old directory must <b>have translated_json</b>, Otherwise, the update cannot be carried out

Note that the update cannot perfectly transfer the text. You can manually complete the remaining text by using GPT/Claude/DS

Cheers!
