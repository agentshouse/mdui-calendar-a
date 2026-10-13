import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
export function checkCurrentStarter(documents) {
  const expected = JSON.parse(fs.readFileSync(new URL('./current-starter.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(documents).sort(), Object.keys(expected.sha256).sort());
  for (const [name, text] of Object.entries(documents))
    assert.equal(createHash('sha256').update(text).digest('hex'), expected.sha256[name], `Current Starter changed: ${name}`);
}
