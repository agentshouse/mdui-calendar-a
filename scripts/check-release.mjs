import './check-provenance.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {verify, validate} from '@agentshouse/mdmodel';
const root = path.resolve(import.meta.dirname, '..'); const dist = path.join(root, 'dist');
function files(directory) {return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{assert(!entry.isSymbolicLink());const target=path.join(directory,entry.name);return entry.isDirectory()?files(target):[target];});}
const output=files(dist); const bytes=output.reduce((sum,file)=>sum+fs.statSync(file).size,0);
assert(output.length<=2000); assert(bytes<20*1024*1024);
for (const name of ['app.json','schema.yaml']) assert.equal(fs.readFileSync(path.join(root,name),'utf8'),fs.readFileSync(path.join(dist,name),'utf8'));
assert.equal(fs.readFileSync(path.join(root,'LICENSE'),'utf8'),fs.readFileSync(path.join(dist,'LICENSE.txt'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.join(dist,'app.json'),'utf8'));
assert.equal(manifest.entry,'index.html');assert.equal(manifest.room_slots.length,1);assert(!manifest.external_calls && !manifest.external_origins);
const refs=new Set();
function asset(value,from) {if(value.startsWith('data:')||value.startsWith('#'))return;assert(!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value),`External resource ${value}`);const target=path.resolve(path.dirname(from),decodeURIComponent(value.split(/[?#]/)[0]));assert(target.startsWith(dist+path.sep));assert(fs.existsSync(target),`Missing resource ${value}`);refs.add(path.relative(dist,target));}
for(const file of output){const text=fs.readFileSync(file,'utf8');
 if(file.endsWith('.html')) {assert(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(text));for(const match of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g))asset(match[1],file);}
 if(file.endsWith('.css'))for(const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\)/g))asset(match[1],file);
 if(file.endsWith('.js')) {assert(!/localStorage|sessionStorage|indexedDB|\bfetch\s*\(/.test(text),'Forbidden runtime storage/network API'); assert(!/import\s*\(/.test(text),'Lazy runtime chunk');}
}
for(const file of files(path.join(root,'src'))) {const source=fs.readFileSync(file,'utf8');assert(!/localStorage|sessionStorage|connectMdRuntime|serveMdRuntime|createMemoryAdapter|new\s+WebSocket|\bfetch\s*\(/.test(source),`Forbidden production API ${file}`);}
for(const name of ['LICENSE.txt','THIRD_PARTY_NOTICES.txt'])asset('./'+name,path.join(dist,'index.html'));
const schema=verify(fs.readFileSync(path.join(root,'schema.yaml'),'utf8'));assert.equal(schema.verdict,'accept',JSON.stringify(schema));
const library=Object.fromEntries(files(path.join(root,'samples/events')).map(file=>['events/'+path.basename(file),fs.readFileSync(file,'utf8')]));
const valid=validate(library,undefined,schema.model);assert.equal(valid.verdict,'accept',JSON.stringify(valid));assert.equal(Object.keys(library).length,23);
console.log(JSON.stringify({result:'passed',files:output.length,bytes,mebibytes:+(bytes/1024/1024).toFixed(3),schema:'accepted',sampleDocuments:23,references:[...refs],browser:'Hosted desktop/360px unverified',network:'Static audit only; hosted network capture unverified'}));
