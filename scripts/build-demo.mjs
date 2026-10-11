/** Rebuild the licensed demo locally. This script never creates a Room or writes to House. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import recurrence from 'rrule';

const {RRule} = recurrence;
dayjs.extend(utc);
const root = fileURLToPath(new URL('../', import.meta.url));
const reference = '2026-10-11T00:00:00.000Z';
const commit = '04e34d17cb6db097c034bba04655353bcc38fe7c';
const expectedSourceHash = 'f8ea1a952d2ca285c5e7849af3bd156699b7fece5702c34d9a99f57e71255233';
const expectedLicenseHash = 'a0196423e884b263ca15b4ea52983f40bd0da3c193e0a66485e8c74075a9c286';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const source = fs.readFileSync(path.join(root, 'samples/donor/seed.ts'), 'utf8');
const license = fs.readFileSync(path.join(root, 'samples/donor/LICENSE'));
assert.equal(sha256(source), expectedSourceHash, 'The pinned raw seed must be byte-identical.');
assert.equal(sha256(license), expectedLicenseHash, 'The pinned MIT license must be byte-identical.');
assert.equal(sha256(fs.readFileSync(path.join(root, 'LICENSE'))), expectedLicenseHash);

// The reviewed, hash-pinned local donor fixture has no TypeScript syntax except
// imports/exports. Evaluate it with its real Day.js and RRule implementations.
// UTC mode makes the documented frozen reference independent of the host zone.
const program = source
  .replace(/^import .*\r?\n/gm, '')
  .replace('export const dummyEvents =', 'const dummyEvents =') + '\n dummyEvents;';
const donorEvents = vm.runInNewContext(program, {
  dayjs: input => dayjs.utc(input === undefined ? reference : input),
  RRule,
}, {filename: 'samples/donor/seed.ts', timeout: 1000});

const events = donorEvents.map(event => {
  const normalized = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'start' || key === 'end') normalized[key] = value.toISOString();
    else if (key === 'rrule') {
      normalized.rrule = {...value,
        dtstart: value.dtstart.toISOString(),
        byweekday: value.byweekday.map(day => day.n === undefined
          ? day.weekday : {weekday: day.weekday, n: day.n}),
      };
    } else normalized[key] = value;
  }
  return {...normalized, createdAt: reference, updatedAt: reference};
});
assert.equal(events.length, 23);
assert.equal(new Set(events.map(event => event.id)).size, 23);
assert.equal(events.filter(event => event.rrule).length, 2);
assert.equal(events.filter(event => !event.rrule).length, 21);

const stringify = value => JSON.stringify(value, null, 2) + '\n';
const markdown = event => '---\ntype: calendar_event\n'
  + Object.entries(event).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('')
  + '---\n';
const readme = `# Calendar donor demo\n\nThis Room contains the complete licensed ilamy-calendar playground sample: 23 stored event records (21 one-offs and two recurring series). Recurring occurrences are expanded by the calendar and are not additional seed records.\n\nSource: https://github.com/kcsujeet/ilamy-calendar/blob/${commit}/packages/playground/src/lib/seed.ts\n\nLicense: MIT, Copyright (c) 2025 Sujeet Kc. The complete license is included with the Calendar app.\n\nAll source dayjs() calls are frozen at ${reference} in UTC. Titles, descriptions, colors, IDs, all-day flags, durations, recurrence intervals, and weekdays retain the donor values. Dates remain relative to that October 2026 reference. The source title and description for the PST example are preserved verbatim; this reproducible seed is anchored in UTC and does not introduce a separate America/Los_Angeles timezone.\n\nThe imported event timestamps createdAt and updatedAt both use the same frozen reference. These are provenance metadata, not claims about the donor author's editing time.\n\nEach event is a calendar_event document in events/. Editing or deleting an event changes its Room document through the MD Runtime. This README is untyped documentation, not a calendar event.\n`;

fs.mkdirSync(path.join(root, 'samples/events'), {recursive: true});
fs.writeFileSync(path.join(root, 'samples/events.json'), stringify(events));
for (const event of events) fs.writeFileSync(path.join(root, 'samples/events', `${event.id}.md`), markdown(event));
fs.writeFileSync(path.join(root, 'samples/calendar-readme.md'), readme);
const documents = events.map(event => ({
  type: 'calendar_event', path: `events/${event.id}.md`, fields: event,
}));
fs.writeFileSync(path.join(root, 'samples/sample-documents.json'), stringify(documents));
const manifest = {
  repository: 'https://github.com/kcsujeet/ilamy-calendar',
  commit,
  source_path: 'packages/playground/src/lib/seed.ts',
  source_url: `https://github.com/kcsujeet/ilamy-calendar/blob/${commit}/packages/playground/src/lib/seed.ts`,
  source_copy: 'samples/donor/seed.ts',
  source_sha256: expectedSourceHash,
  license: 'MIT',
  copyright: 'Copyright (c) 2025 Sujeet Kc',
  license_url: `https://github.com/kcsujeet/ilamy-calendar/blob/${commit}/LICENSE`,
  license_copy: 'samples/donor/LICENSE',
  license_sha256: expectedLicenseHash,
  reference_instant: reference,
  timezone: 'UTC',
  counts: {events: 23, one_offs: 21, recurring_series: 2, all_day_events: 5},
  normalized_events_sha256: sha256(stringify(events)),
  transform: 'node scripts/build-demo.mjs',
  publication: 'Create-only payload; no Room creation, updates, or network calls are performed by this script.',
};
fs.writeFileSync(path.join(root, 'samples/PROVENANCE.json'), stringify(manifest));

// A reviewable handoff only. The Room must already be selected/created by the
// authorized publisher; do not execute this payload from inside the app.
const payloadPath = process.env.CALENDAR_PAYLOAD_PATH || '/tmp/port-publication/calendar-payload.json';
const payload = {
  room_handle_required: true,
  changes: [
    ...events.map(event => ({op: 'create', path: `/rooms/calendar-port/events/${event.id}.md`, content: markdown(event)})),
    {op: 'create', path: '/rooms/calendar-port/calendar-readme.md', content: readme},
  ],
};
fs.mkdirSync(path.dirname(payloadPath), {recursive: true});
fs.writeFileSync(payloadPath, stringify(payload));
console.log(`Prepared ${events.length} events (21 one-offs, 2 recurring series), provenance, and ${payload.changes.length} create-only document operations at ${payloadPath}. No House writes performed.`);
