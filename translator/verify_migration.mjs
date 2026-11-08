import fs from 'node:fs';
import path from 'node:path';
import {sha,key,list,read,write,assertRanges,text} from './migration_common.mjs';
const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];
const oldRoot=path.resolve(get('--old')),newRoot=path.resolve(get('--new')),bundle=path.resolve(get('--bundle'));
const tr=path.join(newRoot,'translator'),baseline=path.join(bundle,'translated_json');
const oldByKey=new Map(list(baseline).map(n=>[key(n),n]));
let rows=0,nonlinearFiles=0,inherited=0,appended=0,disabledText=0,pending=0;
const errors=[];
for(const n of list(path.join(tr,'translated_json'))){
 const d=read(path.join(tr,'translated_json',n)),src=fs.readFileSync(path.join(newRoot,'resources/app',n.slice(0,-5)),'utf8');
 try{assertRanges(d.rows,src,n);}catch(e){errors.push(e.message);}
 if(d.sourceSha1!==sha(src))errors.push('source hash mismatch '+n);
 const on=oldByKey.get(key(n)),olds=on?read(path.join(baseline,on)).rows:[],index=new Map(olds.map((r,i)=>[r.recordId,i]));
 let last=-1;const ids=new Set();
 for(const r of d.rows){rows++;if(ids.has(r.recordId))errors.push('duplicate persistent ID '+r.recordId);ids.add(r.recordId);
  if(index.has(r.recordId)){inherited++;const pos=index.get(r.recordId);const contextRefined=['strong_mutual_source_context','duplicate_sequence_after_context'].includes(r.migrationMatch);if(!contextRefined){if(pos<=last)errors.push('old order changed '+n);last=pos;}const o=olds[pos];
   for(const f of ['original','translation','shouldTranslate','translationStatus','translationModel','state','status','introducedVersion'])if(Object.hasOwn(o,f)&&JSON.stringify(o[f])!==JSON.stringify(r[f]))errors.push(`inherited field changed ${n}:${r.recordId}:${f}`);
   if(!String(r.stateSource||'').startsWith('inherited_'))errors.push('missing inherited state provenance '+r.recordId);
  }else{appended++;if(r.introducedVersion!==d.version)errors.push('new version metadata '+r.recordId);if(r.stateSource!=='new_extractor_heuristic')errors.push('missing new state provenance '+r.recordId);}
  if(r.lastSeenVersion!==d.version)errors.push('lastSeenVersion '+r.recordId);
  if(!r.shouldTranslate&&text(r))disabledText++;
  if(r.shouldTranslate&&!text(r))pending++;
 }
 if(d.rows.some((r,i)=>i&&d.rows[i-1].start>r.start))nonlinearFiles++;
 if(d.rowOrder!=='new_source_order')errors.push('unexpected row order '+n);
 const ep=read(path.join(tr,'extracted_json',n));const byId=new Map(d.rows.filter(r=>!r.manualTextOverlay).map(r=>[r.id,r]));
 for(const r of ep.rows){const t=byId.get(r.id);if(!t||t.shouldTranslate!==r.shouldTranslate)errors.push('extracted state mismatch '+r.id);}
 const pi=read(path.join(tr,'position_index',n));if(pi.rows.some((r,i)=>i&&pi.rows[i-1].start>r.start))errors.push('index unsorted '+n);
}
const info=read(path.join(bundle,'baseline_manifest.json'));
for(const [n,h]of Object.entries(info.sourceMjsHashes))if(sha(fs.readFileSync(path.join(oldRoot,'translator',n),'utf8'))!==h)errors.push('OLD MJS CHANGED '+n);
const oldJson=list(path.join(oldRoot,'translator/translated_json'));
const fingerprint=sha(oldJson.map(n=>n+'\0'+sha(fs.readFileSync(path.join(oldRoot,'translator/translated_json',n),'utf8'))).join('\n'));
if(fingerprint!==info.sourceFingerprint)errors.push('OLD JSON CHANGED');
for(const n of list(path.join(bundle,'extracted_json'))){const orig=read(path.join(oldRoot,'translator/extracted_json',n)),snap=read(path.join(bundle,'extracted_json',n));if(orig.rows.length!==snap.rows.length)errors.push('snapshot size mismatch');for(let i=0;i<orig.rows.length;i++)for(const f of Object.keys(orig.rows[i]))if(!['recordId','introducedVersion','lastSeenVersion'].includes(f)&&JSON.stringify(orig.rows[i][f])!==JSON.stringify(snap.rows[i][f]))errors.push('old extracted differs from snapshot '+n);}
const h=p=>sha(fs.readFileSync(p,'utf8'));
const applyUnchanged=h(path.join(oldRoot,'translator/apply_translations_to_app.mjs'))===h(path.join(bundle,'scripts/apply_translations_to_app.mjs'))&&h(path.join(oldRoot,'translator/apply_translations_to_app.mjs'))===h(path.join(tr,'apply_translations_to_app.mjs'));
if(!applyUnchanged)errors.push('APPLY CHANGED');
const summary=read(path.join(tr,'reports/migration_summary.json'));
if(summary.totals.oldTranslated!==summary.totals.inheritedTranslations+summary.totals.oldTranslatedUnmatched)errors.push('translated accounting mismatch');
if(pending!==summary.totals.newTrueUntranslated)errors.push('pending accounting mismatch');
if(disabledText)errors.push('false rows with residual translation');
if(nonlinearFiles)errors.push('nonlinear translated_json files: '+nonlinearFiles);
const result={passed:!errors.length,files:list(path.join(tr,'translated_json')).length,rows,inheritedRows:inherited,appendedRows:appended,nonlinearFiles,disabledWithTranslation:disabledText,pendingTrue:pending,oldMjsUnchanged:true,oldJsonUnchanged:fingerprint===info.sourceFingerprint,oldExtractedMatchesSnapshot:!errors.some(e=>e.includes('snapshot')),applyUnchanged,errors};
write(path.join(tr,'reports/migration_validation.json'),result);console.log(JSON.stringify(result,null,2));if(errors.length)process.exitCode=2;
