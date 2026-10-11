import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const donor = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
assert.equal(createHash('sha256').update(donor).digest('hex'), 'a0196423e884b263ca15b4ea52983f40bd0da3c193e0a66485e8c74075a9c286');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const notices = ['CALENDAR — THIRD-PARTY NOTICES\n\nAdapted from kcsujeet/ilamy-calendar at 04e34d17cb6db097c034bba04655353bcc38fe7c.\nSource: https://github.com/kcsujeet/ilamy-calendar/tree/04e34d17cb6db097c034bba04655353bcc38fe7c\n\n'+donor, '\nVendored calendar core, types, UI, utilities and recurrence plugin retain this donor notice. Donor seed records are reused with a frozen 2026-10-11 UTC reference date. Dependency notices below cover the installed production closure, a superset of the actual bundled modules.'];
const supplements = [
 {name:'@cfworker/json-schema',version:'4.1.1',file:'licenses/cfworker-json-schema-MIT.txt',source:'https://github.com/cfworker/cfworker/blob/5409fdc2bd144f68e8b28c61c71fcb16600000a6/LICENSE.md',sha256:'376944252ab78ca6b41aee44ddea8894927ee67891e77e61eb9d59af63e35094'},
 {name:'react-remove-scroll-bar',version:'2.3.8',file:'licenses/react-remove-scroll-bar-MIT.txt',source:'https://github.com/theKashey/react-remove-scroll-bar/blob/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE',sha256: 'a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84'},
];
const packages = []; const missing = [];
for (const [relative, entry] of Object.entries(lock.packages)) {
  if (!relative || entry.dev || entry.link) continue;
  const directory = path.join(root, relative);
  if (!fs.existsSync(path.join(directory, 'package.json'))) {if (!entry.optional) missing.push(relative); continue;}
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'Not declared');
  const files = fs.readdirSync(directory).filter(name => /^(licen[cs]e|notice|copying|copyright|ofl)(?:[._-]|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
  packages.push({name: pkg.name, version: pkg.version, license, files});
  notices.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${license}\n`);
  if (!files.length && !supplements.some(item => item.name === pkg.name && item.version === pkg.version)) missing.push(`${pkg.name}@${pkg.version}`);
  for (const file of files) notices.push(`\n--- ${file} ---\n${fs.readFileSync(path.join(directory, file), 'utf8')}`);
  assert(!/^(UNLICENSED|Not declared)$/.test(license), `${pkg.name}: license not available`);
}
for (const item of supplements) {const text=fs.readFileSync(path.join(root,'public',item.file),'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),item.sha256);notices.push(`\n${'='.repeat(72)}\n${item.name} ${item.version}\nSource: ${item.source}\nVerified upstream grant reused from the existing audited port. For react-remove-scroll-bar 2.3.8, the package declares MIT but omits its root license; its npm gitHead b3b1287aad81def2e2ae707274b74531b61ddbaf is unavailable publicly, so the linked repository commit is not claimed to be its publication commit.\n\n${text}`);}
fs.mkdirSync(path.join(root, 'public'), {recursive:true}); fs.mkdirSync(path.join(root, '.build'), {recursive:true});
const text = notices.join('\n')+'\n';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(path.join(root, 'public/THIRD_PARTY_NOTICES.txt'), 'utf8'), text);
else fs.writeFileSync(path.join(root, 'public/THIRD_PARTY_NOTICES.txt'), text);
fs.writeFileSync(path.join(root, '.build/license-audit.json'), JSON.stringify({donorCommit:'04e34d17cb6db097c034bba04655353bcc38fe7c', donorLicenseSha256:createHash('sha256').update(donor).digest('hex'), packages, supplements, missing}, null, 2)+'\n');
console.log(JSON.stringify({packages:packages.length, missing}));
assert.equal(missing.length, 0, 'Production dependency license text is missing');
