import {describe, expect, test} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {parse, validate, verify} from '@agentshouse/mdmodel';
import {RRule} from 'rrule';

const root = process.cwd();
const reference = '2026-10-11T00:00:00.000Z';
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const events = JSON.parse(read('samples/events.json')) as Record<string, unknown>[];
const manifest = JSON.parse(read('samples/PROVENANCE.json'));
const raw = read('samples/donor/seed.ts');
const schema = verify(read('schema.yaml'));

/** Independent reference implementation for just the donor's UTC expressions.
 * No Day.js import, generator import, shared normalizer, or sample-derived dates.
 * Unsupported donor expressions throw instead of silently changing semantics.
 */
class UtcReferenceDate {
  private readonly value: Date;
  constructor(value: string | number = reference) { this.value = new Date(value); }
  private change(set: (date: Date) => void): UtcReferenceDate {
    const date = new Date(this.value.getTime());
    set(date);
    return new UtcReferenceDate(date.getTime());
  }
  startOf(unit: string): UtcReferenceDate {
    if (unit === 'month') return this.change(date => { date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0); });
    if (unit === 'day') return this.change(date => date.setUTCHours(0, 0, 0, 0));
    throw new Error(`Unsupported startOf(${unit})`);
  }
  endOf(unit: string): UtcReferenceDate {
    if (unit !== 'day') throw new Error(`Unsupported endOf(${unit})`);
    return this.change(date => date.setUTCHours(23, 59, 59, 999));
  }
  date(day: number): UtcReferenceDate { return this.change(date => date.setUTCDate(day)); }
  hour(hour: number): UtcReferenceDate { return this.change(date => date.setUTCHours(hour)); }
  minute(minute: number): UtcReferenceDate { return this.change(date => date.setUTCMinutes(minute)); }
  day(weekday: number): UtcReferenceDate {
    return this.change(date => date.setUTCDate(date.getUTCDate() + weekday - date.getUTCDay()));
  }
  add(amount: number, unit: string): UtcReferenceDate {
    if (unit !== 'day' && unit !== 'week') throw new Error(`Unsupported add(${unit})`);
    return this.change(date => date.setUTCDate(date.getUTCDate() + amount * (unit === 'week' ? 7 : 1)));
  }
  subtract(amount: number, unit: string): UtcReferenceDate { return this.add(-amount, unit); }
  toDate(): Date { return new Date(this.value.getTime()); }
  toJSON(): string { return this.value.toISOString(); }
}

function reconstructSource(): Record<string, unknown>[] {
  // RRule uses Monday=0; keep these independent literal constants so a broken
  // production weekday-object conversion cannot make the expectation pass.
  const weekdayConstants = {WEEKLY: 2, MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6};
  const source = raw.replace(/^import .*\r?\n/gm, '')
    .replace('export const dummyEvents =', 'const dummyEvents =') + '\n dummyEvents;';
  const sourceRows = vm.runInNewContext(source, {
    dayjs: () => new UtcReferenceDate(), RRule: weekdayConstants,
  }, {filename: 'independent-donor-reconstruction', timeout: 1000});
  // Both native Date and UtcReferenceDate serialize themselves without the
  // production transform's per-field or weekday branching.
  const plainRows = JSON.parse(JSON.stringify(sourceRows)) as Record<string, unknown>[];
  return plainRows.map(event => ({...event, createdAt: reference, updatedAt: reference}));
}

function document(fields: Record<string, unknown>): string {
  return '---\ntype: calendar_event\n'
    + Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('')
    + '---\n';
}

function validation(fields: Record<string, unknown>) {
  if (schema.verdict !== 'accept') throw new Error(`Invalid schema: ${JSON.stringify(schema)}`);
  return validate({'events/check.md': document(fields)}, undefined, schema.model);
}

describe('complete licensed donor seed', () => {
  test('retains byte-identical pinned source and MIT license with honest attribution', () => {
    expect(manifest.commit).toBe('04e34d17cb6db097c034bba04655353bcc38fe7c');
    expect(sha256(raw)).toBe('f8ea1a952d2ca285c5e7849af3bd156699b7fece5702c34d9a99f57e71255233');
    expect(manifest.source_sha256).toBe(sha256(raw));
    expect(sha256(read('samples/donor/LICENSE'))).toBe('a0196423e884b263ca15b4ea52983f40bd0da3c193e0a66485e8c74075a9c286');
    expect(read('LICENSE')).toBe(read('samples/donor/LICENSE'));
    expect(manifest.license_sha256).toBe(sha256(read('LICENSE')));
    expect(manifest.copyright).toBe('Copyright (c) 2025 Sujeet Kc');
    expect(manifest.license).toBe('MIT');
    expect(manifest.normalized_events_sha256).toBe(sha256(read('samples/events.json')));
    expect(manifest.reference_instant).toBe(reference);
    expect(manifest.timezone).toBe('UTC');
  });

  test('matches every field of all 23 records independently reconstructed from the source', () => {
    expect(events).toEqual(reconstructSource());
    expect(events).toHaveLength(23);
    expect(new Set(events.map(event => event.id)).size).toBe(23);
    expect(events.map(event => event.id)).toEqual([
      '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', '5.9',
      '6', '8', '9', '10', '11', '12', '15', '16', '17', '18', '19', '20', '21', '22',
    ]);
    expect(events.filter(event => event.rrule)).toHaveLength(2);
    expect(events.filter(event => !event.rrule)).toHaveLength(21);
    expect(events.filter(event => event.allDay === true)).toHaveLength(5);
    for (const event of events) {
      expect(event.createdAt).toBe(reference);
      expect(event.updatedAt).toBe(reference);
      expect(typeof event.id).toBe('string');
      expect(Date.parse(String(event.end))).toBeGreaterThan(Date.parse(String(event.start)));
    }
    expect(events.find(event => event.id === '22')?.start).toBe('2026-10-11T10:00:00.000Z');
    expect(events.find(event => event.id === '22')).not.toHaveProperty('description');
    expect(events.find(event => event.id === '5.1')).not.toHaveProperty('color');
    expect(events.find(event => event.id === '5.1')).not.toHaveProperty('allDay');
    expect(events.find(event => event.id === '15')?.end).toBe('2026-10-09T23:59:59.999Z');
  });

  test('keeps exact recurrence dates, weekdays, exclusions, and generated instances', () => {
    const standup = events.find(event => event.id === '20')!;
    const evening = events.find(event => event.id === '21')!;
    expect(standup.rrule).toEqual({freq: 2, interval: 1, byweekday: [0, 1, 2, 3, 4], dtstart: '2026-10-01T10:00:00.000Z'});
    expect(evening.rrule).toEqual({freq: 2, interval: 1, byweekday: [2], dtstart: '2026-10-07T16:00:00.000Z'});
    expect(standup.exdates).toEqual([]);
    expect(evening.exdates).toEqual([]);
    const occurrences = (event: Record<string, unknown>) => {
      const rule = event.rrule as {freq: number; interval: number; byweekday: number[]; dtstart: string};
      return new RRule({...rule, dtstart: new Date(rule.dtstart)})
        .between(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T23:59:59Z'), true)
        .map(date => date.toISOString());
    };
    const businessDays = Array.from({length: 31}, (_, index) => index + 1)
      .filter(day => { const weekday = new Date(Date.UTC(2026, 9, day)).getUTCDay(); return weekday !== 0 && weekday !== 6; })
      .map(day => new Date(Date.UTC(2026, 9, day, 10)).toISOString());
    expect(occurrences(standup)).toEqual(businessDays);
    expect(occurrences(evening)).toEqual([7, 14, 21, 28].map(day => new Date(Date.UTC(2026, 9, day, 16)).toISOString()));
  });

  test('all Markdown documents and test harness fields round-trip through the real Room model', () => {
    expect(schema.verdict).toBe('accept');
    if (schema.verdict !== 'accept') return;
    const names = fs.readdirSync(path.join(root, 'samples/events')).filter(name => name.endsWith('.md'));
    expect(names.sort()).toEqual(events.map(event => `${event.id}.md`).sort());
    const library: Record<string, string> = {'calendar-readme.md': read('samples/calendar-readme.md')};
    for (const event of events) {
      const relative = `events/${event.id}.md`;
      library[relative] = read(`samples/${relative}`);
      const parsed = parse(library[relative]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.document.type).toBe('calendar_event');
      expect(parsed.document.fields).toEqual({type: 'calendar_event', ...event});
    }
    expect(validate(library, undefined, schema.model)).toEqual({verdict: 'accept'});
    expect(JSON.parse(read('samples/sample-documents.json'))).toEqual(events.map(fields => ({
      type: 'calendar_event', path: `events/${fields.id}.md`, fields,
    })));
  });

  test('schema allows real optional fields and ordinal recurrence, but refuses invalid field types', () => {
    const ordinary = events[0];
    expect(validation({...ordinary, uid: null, recurrenceId: null, rrule: null})).toEqual({verdict: 'accept'});
    expect(validation({...ordinary, uid: 'series-uid', recurrenceId: '2026-10-12T15:00:00.000Z',
      location: 'Meeting room', allDay: false,
      rrule: {freq: 1, interval: 1, count: 6, byweekday: [{weekday: 0, n: 2}],
        dtstart: ordinary.start, until: '2026-12-31T23:59:59.999Z'}, exdates: [ordinary.start],
    })).toEqual({verdict: 'accept'});
    for (const patch of [
      {id: 5}, {id: '../unsafe'}, {id: 'a'.repeat(201)}, {title: ''}, {title: '   '}, {title: 'a'.repeat(1001)}, {start: 'not-a-date'}, {end: '2026-13-01T00:00:00Z'},
      {allDay: 'true'}, {description: 12}, {location: []}, {color: []}, {backgroundColor: 3},
      {uid: 3}, {uid: 'a'.repeat(301)}, {description: 'a'.repeat(50001)}, {location: 'a'.repeat(2001)}, {color: 'a'.repeat(201)}, {backgroundColor: 'a'.repeat(201)}, {recurrenceId: ''}, {createdAt: ''}, {updatedAt: 'today'}, {exdates: ['bad-date']},
      {rrule: {freq: 7}}, {rrule: {freq: 2, interval: 0}}, {rrule: {freq: 2, byweekday: [7]}},
      {rrule: {freq: 1, byweekday: [{weekday: 0, n: 0}]}}, {rrule: {freq: 2, dtstart: 'bad-date'}},
    ]) expect(validation({...ordinary, ...patch}).verdict, JSON.stringify(patch)).toBe('refuse');
    for (const required of ['id', 'title', 'start', 'end', 'createdAt', 'updatedAt']) {
      const fields = {...ordinary};
      delete fields[required];
      expect(validation(fields).verdict, required).toBe('refuse');
    }
  });

  test('generation is host-timezone-independent and emits create-only complete publication payloads', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-seed-'));
    const before = read('samples/events.json');
    try {
      const payloadPath = path.join(temporary, 'payload.json');
      execFileSync(process.execPath, ['scripts/build-demo.mjs'], {
        cwd: root,
        env: {...process.env, TZ: 'Pacific/Honolulu', CALENDAR_PAYLOAD_PATH: payloadPath},
        encoding: 'utf8',
      });
      expect(read('samples/events.json')).toBe(before);
      const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
      expect(payload.room_handle_required).toBe(true);
      expect(payload.changes).toHaveLength(24);
      expect(new Set(payload.changes.map((change: {path: string}) => change.path)).size).toBe(24);
      for (let index = 0; index < events.length; index++) {
        const relative = `events/${events[index].id}.md`;
        expect(payload.changes[index]).toEqual({op: 'create', path: `/rooms/calendar-port/${relative}`, content: read(`samples/${relative}`)});
      }
      expect(payload.changes.at(-1)).toEqual({op: 'create', path: '/rooms/calendar-port/calendar-readme.md', content: read('samples/calendar-readme.md')});
    } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  });
});
