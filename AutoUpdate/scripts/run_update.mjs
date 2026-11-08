import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {read,write,list,key,target,sha,stamp,versions} from './migration_common.mjs';
const scriptDir=path.dirname(fileURLToPath(import.meta.url)),bundle=path.dirname(scriptDir);
const argv=process.argv.slice(2),has=k=>argv.includes(k),arg=(k,d)=>has(k)?argv[argv.indexOf(k)+1]:d;
const defaultGlossaryDir=path.join(bundle,'defaults','glossary');
const runtimeGlossaryFiles=['mapping_apply.json','coc2_glossary_en_zh_structured.json'];
function run(script,args,cwd){console.log(`\n>>> ${script}`);const r=spawnSync(process.execPath,[path.join(scriptDir,script),...args],{cwd,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)throw Error(`${script}: exit ${r.status}`);}
function copyFiles(src,dst,predicate){fs.mkdirSync(dst,{recursive:true});for(const n of fs.readdirSync(src)){const p=path.join(src,n);if(fs.statSync(p).isFile()&&predicate(n))fs.copyFileSync(p,path.join(dst,n));}}
function mustDir(p){if(!fs.statSync(p).isDirectory())throw Error('Not a directory: '+p);}
function installRuntimeGlossary(newRoot,oldRoot=null){
 const dst=path.join(newRoot,'translator','glossary');fs.mkdirSync(dst,{recursive:true});
 for(const name of runtimeGlossaryFiles){
  const oldPath=oldRoot?path.join(oldRoot,'translator','glossary',name):null;
  const target=path.join(dst,name),fallback=path.join(defaultGlossaryDir,name);
  const source=oldPath&&fs.existsSync(oldPath)?oldPath:fs.existsSync(target)?target:fallback;
  if(!fs.existsSync(source))throw Error('Missing bundled runtime glossary file: '+fallback);
  if(path.resolve(source)!==path.resolve(target))fs.copyFileSync(source,target);
  console.log(`Runtime glossary: ${name} <- ${oldPath&&source===oldPath?'old game':source===target?'existing new game':'bundled default'}`);
 }
}
async function environment(){if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js >=24 required');const pkg=read(path.join(bundle,'node_modules/prettier/package.json'));const prettier=await import(pathToFileURL(path.join(bundle,'node_modules/prettier/index.mjs')));if(typeof prettier.format!=='function')throw Error('Invalid Prettier package');console.log(JSON.stringify({node:process.version,prettier:pkg.version,root:bundle}));return prettier;}
async function applyOnly(newRoot){
 installRuntimeGlossary(newRoot);
 const tr=path.join(newRoot,'translator'),mapping=path.join(tr,'glossary/mapping_apply.json');
 if(!fs.existsSync(mapping))throw Error('Missing runtime mapping: '+mapping);
 run('apply_translations_to_app.mjs',[],newRoot);
 const app=path.join(newRoot,'resources/app'),out=path.join(tr,'translated_app');let count=0;
 for(const n of fs.readdirSync(app).filter(n=>n.endsWith('.js'))){const p=path.join(out,n);if(!fs.existsSync(p))throw Error('Missing output '+p);const r=spawnSync(process.execPath,['--check',p],{stdio:'pipe',windowsHide:true});if(r.status!==0)throw Error(n+': '+String(r.stderr));count++;}
 const summary=read(path.join(tr,'apply_translations_summary.json'));
 if(summary.totalSkipped||summary.files.some(f=>f.reason||f.rebase?.unmatched))throw Error('Apply skipped or unmatched rows; inspect apply_translations_summary.json');
 write(path.join(tr,'reports/apply_validation.json'),{allJsSyntaxValid:true,files:count,applied:summary.totalApplied,skipped:summary.totalSkipped});
 console.log(`All ${count} JS syntax checks passed.`);
}
try{
 const prettier=await environment();if(has('--check'))process.exit(0);
 const newRoot=fs.realpathSync(path.resolve(arg('--new',process.cwd())));mustDir(path.join(newRoot,'resources/app'));
 if(has('--apply-only')){await applyOnly(newRoot);process.exit(0);}
 const oldRoot=fs.realpathSync(path.resolve(arg('--old','')));mustDir(path.join(oldRoot,'resources/app'));
 const a=oldRoot.toLowerCase(),b=newRoot.toLowerCase();if(a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep))throw Error('Old/new roots cannot overlap');
 const oldVersion=versions(oldRoot),version=versions(newRoot),tr=path.join(newRoot,'translator');
 const baseline=path.join(bundle,'translated_json'),baselineExtracted=path.join(bundle,'extracted_json'),baselineInfo=path.join(bundle,'baseline_manifest.json');
 const sourceFiles=list(path.join(oldRoot,'translator/translated_json'));
 const fingerprint=sha(sourceFiles.map(n=>n+'\0'+sha(fs.readFileSync(path.join(oldRoot,'translator/translated_json',n),'utf8'))).join('\n'));
 if(fs.existsSync(baselineInfo)){
  const info=read(baselineInfo);if(info.sourceFingerprint!==fingerprint)throw Error('Old translation data differs from bundled baseline. Preserve the bundle and create a new baseline explicitly.');
 }else{
  if(fs.existsSync(baseline)&&list(baseline).length)throw Error('Baseline directory exists without manifest; refusing overwrite');
  for(const n of sourceFiles){const doc=read(path.join(oldRoot,'translator/translated_json',n));doc.rows=doc.rows.map((r,i)=>stamp(r,oldVersion,key(n),i));doc.version=oldVersion;doc.rowOrder='baseline_original_order';write(path.join(baseline,n),doc);
   const ep=path.join(oldRoot,'translator/extracted_json',n);if(fs.existsSync(ep)){const ed=read(ep);ed.rows=ed.rows.map((r,i)=>stamp(r,oldVersion,key(n),i));ed.version=oldVersion;write(path.join(baselineExtracted,n),ed);}
  }
  write(baselineInfo,{oldVersion,oldRoot,sourceFingerprint:fingerprint,generatedAt:new Date().toISOString(),sourceMjsHashes:Object.fromEntries(fs.readdirSync(path.join(oldRoot,'translator')).filter(n=>n.endsWith('.mjs')).map(n=>[n,sha(fs.readFileSync(path.join(oldRoot,'translator',n),'utf8'))]))});
 }
 if(has('--seed-only'))process.exit(0);
 if(fs.existsSync(path.join(tr,'translated_json'))&&list(path.join(tr,'translated_json')).length&&!has('--resume'))throw Error('New game already has translated_json; use --resume only for this same migration');
 fs.mkdirSync(path.join(tr,'reports'),{recursive:true});
 // Install only the two runtime glossary files. Prefer an old-game copy when
 // available, otherwise fall back to the self-contained package defaults.
 installRuntimeGlossary(newRoot,oldRoot);
 const app=path.join(newRoot,'resources/app'),names=fs.readdirSync(app).filter(target).sort(),keys=new Set();
 for(const n of names){if(keys.has(key(n)))throw Error('Multiple JS hashes for module '+key(n));keys.add(key(n));}
 for(const n of sourceFiles)if(!keys.has(key(n)))console.warn('Old module absent: '+key(n));
 const backup=path.join(tr,'backups/original_js'),formatInfo=path.join(tr,'reports/format_manifest.json');
 const oldManifest=fs.existsSync(formatInfo)?read(formatInfo):null;
 if(oldManifest&&oldManifest.prettier!==read(path.join(bundle,'node_modules/prettier/package.json')).version)throw Error('Prettier version changed during migration');
 const formatFiles=[];
 for(const n of names){const p=path.join(app,n),back=path.join(backup,n);fs.mkdirSync(backup,{recursive:true});if(!fs.existsSync(back))fs.copyFileSync(p,back);
  const source=fs.readFileSync(p,'utf8'),formatted=await prettier.format(source,{parser:'babel',endOfLine:'lf',embeddedLanguageFormatting:'off',printWidth:80,tabWidth:2,useTabs:false,semi:true,singleQuote:false,trailingComma:'all',arrowParens:'always'});
  if(formatted!==source)fs.writeFileSync(p,formatted);formatFiles.push({file:n,sha1:sha(formatted),originalBackup:back});console.log('Formatted '+n);
 }
 write(formatInfo,{prettier:read(path.join(bundle,'node_modules/prettier/package.json')).version,version,files:formatFiles});
 // Keep package scripts usable for a later manual apply from the game root.
 copyFiles(scriptDir,tr,n=>n.endsWith('.mjs'));
 run('extract_text.mjs',['--all','--version',version],newRoot);
 for(const s of ['build_103_curated.mjs','build_505_curated.mjs','build_673_fullcopy_curated.mjs'])run(s,[],newRoot);
 run('merge_update_texts.mjs',['--old-root',oldRoot,'--old-dir',baseline,'--new-root',newRoot,'--version',version,...(has('--resume')?['--overwrite']:[])],newRoot);
 // Mark baseline records not present in new source only in reports; do not append stale ranges.
 if(!has('--migration-only')){
  await applyOnly(newRoot);
  for(const n of ['COC2 CN.exe','COC2 CN NoSandbox.exe']){const src=path.join(oldRoot,n);if(!fs.existsSync(src))throw Error('Missing launcher '+src);const dst=path.join(newRoot,n);if(!fs.existsSync(dst))fs.copyFileSync(src,dst);}
  for(const n of ['launch_cn.ps1','launch_cn_nosandbox.ps1']){const src=path.join(oldRoot,'translator',n),dst=path.join(tr,n);if(!fs.existsSync(src))throw Error('Missing PS1 '+src);if(!fs.existsSync(dst))fs.copyFileSync(src,dst);}
 }
 console.log('Migration complete. Reports: '+path.join(tr,'reports'));
}catch(error){console.error(error.stack||error);process.exitCode=1;}
