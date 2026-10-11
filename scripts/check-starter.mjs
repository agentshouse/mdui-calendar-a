import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {verify, validate} from '@agentshouse/mdmodel';
const root = path.resolve(import.meta.dirname, '..');
const names = fs.readdirSync(path.join(root, 'starter/events')).sort();
assert.deepEqual(names, ['10.md', '20.md', '22.md']);
const library = {};
for (const name of names) {
  const content = fs.readFileSync(path.join(root, 'starter/events', name), 'utf8');
  assert.equal(content, fs.readFileSync(path.join(root, 'tests/support/samples/events', name), 'utf8'), `Starter changed donor record ${name}`);
  library[`events/${name}`] = content;
}
const schema = verify(fs.readFileSync(path.join(root, 'schema.yaml'), 'utf8'));
assert.equal(schema.verdict, 'accept', JSON.stringify(schema));
assert.equal(validate(library, {binaryTargets: []}, schema.model).verdict, 'accept');
console.log('Three unchanged licensed starter events accepted; no external reference targets required.');
