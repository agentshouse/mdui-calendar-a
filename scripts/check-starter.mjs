import { checkCurrentStarter } from './check-current-starter.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {verify, validate} from '@agentshouse/mdmodel';
const root = path.resolve(import.meta.dirname, '..');
const names = fs.readdirSync(path.join(root, 'starter/events')).sort();
assert.deepEqual(names, ['1.md']);
const library = {};
for (const name of names) {
  const content = fs.readFileSync(path.join(root, 'starter/events', name), 'utf8');
  library[`events/${name}`] = content;
}
checkCurrentStarter(library);
const schema = verify(fs.readFileSync(path.join(root, 'schema.yaml'), 'utf8'));
assert.equal(schema.verdict, 'accept', JSON.stringify(schema));
assert.equal(validate(library, {binaryTargets: []}, schema.model).verdict, 'accept');
console.log('Current Starter event accepted; no external reference targets required.');
