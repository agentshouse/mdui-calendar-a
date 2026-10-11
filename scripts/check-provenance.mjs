import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const report=JSON.parse(fs.readFileSync('licenses/vendor-provenance.json','utf8'));
assert.equal(report.donorCommit,'04e34d17cb6db097c034bba04655353bcc38fe7c');
assert.equal(report.files.length,164);
for(const item of report.files){assert(item.unchanged);assert.equal(createHash('sha256').update(fs.readFileSync('vendor/ilamy/'+item.path)).digest('hex'),item.sha256,item.path);}
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
for(const [name,item] of Object.entries(lock.packages)){if(item.resolved?.startsWith('http')){const url=new URL(item.resolved);assert(!url.username&&!url.password,`Credential-bearing dependency URL ${name}`);}}
console.log('Verified 164 pinned unmodified donor source files and credential-free dependency URLs.');
