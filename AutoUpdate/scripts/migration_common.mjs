import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const sha=s=>crypto.createHash('sha1').update(String(s)).digest('hex');
export const key=n=>path.basename(n).replace(/\.json$/i,'').replace(/\.[a-f0-9]{8,}\.js$/i,'').replace(/\.js$/i,'');
export const target=n=>/^(?:103|505|673)\.[^.]+\.js$/.test(n)||/^Content_[^.]+\.[^.]+\.js$/.test(n);
export const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
export function write(p,d){fs.mkdirSync(path.dirname(p),{recursive:true});const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(d,null,2)+'\n');fs.renameSync(t,p);}
export const list=d=>fs.existsSync(d)?fs.readdirSync(d).filter(n=>n.endsWith('.js.json')).sort():[];
export const text=r=>typeof r.translation==='string'&&Boolean(r.translation.trim());
export function stamp(r,version,module,index){return {...r,recordId:r.recordId||`${module}:${sha(`${r.id}\0${index}\0${r.original}`).slice(0,20)}`,introducedVersion:r.introducedVersion||version,lastSeenVersion:version};}
export const versions=root=>read(path.join(root,'resources/app/package.json')).version;
export function byPosition(rows){return [...rows].sort((a,b)=>a.start-b.start||a.end-b.end);}
export function assertRanges(rows,source,name){const seen=new Set();for(const r of rows){if(!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end>source.length||r.end<=r.start||source.slice(r.start,r.end)!==r.raw)throw Error(`Invalid NEW source range: ${name}:${r.id}`);const k=`${r.start}:${r.end}`;if(seen.has(k))throw Error(`Duplicate range: ${name}:${k}`);seen.add(k);}}
