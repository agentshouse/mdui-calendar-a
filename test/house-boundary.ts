import {assertQueryPointers} from './query-pointers';
import {expect, vi} from 'vitest';
import type {MdRuntimeClient} from '@agentshouse/mdruntime/client';
import type {CalendarEvent} from '../src/data/house';

// A strict, local test double of the published asynchronous client boundary.
// This is not a Runtime implementation or evidence of hosted Provider acceptance.
export type Draft = NonNullable<Awaited<ReturnType<MdRuntimeClient['roomDraft']['read']>>>;
type Parts = Parameters<MdRuntimeClient['roomDraft']['write']>[3];
type SaveResult = Awaited<ReturnType<MdRuntimeClient['save']>>;
type SaveSelection = Parameters<MdRuntimeClient['save']>[1];
type Fields = Record<string, unknown>;
export type Doc = {room: string; path: string; type: string; fields: Fields; markdown: string; sections?: Record<string, string>; preamble?: string};
export const ROOM = 'room:calendar-test';
export const E1 = '11111111-1111-4111-8111-111111111111';
export const E2 = '22222222-2222-4222-8222-222222222222';
export const E3 = '33333333-3333-4333-8333-333333333333';
export const T0 = '2026-10-01T12:00:00.000Z';
export const START = '2026-10-12T09:00:00.000Z';
export const END = '2026-10-12T10:00:00.000Z';
export const eventPath = (id: string) => `events/${id}.md`;
const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const event = (id = E1, title = 'Planning'): CalendarEvent => ({id, title, start: START, end: END, createdAt: T0, updatedAt: T0});
const markdown = (type: string, fields: Fields, sections: Record<string, string> = {}, preamble = '') => `---\n${JSON.stringify({type, ...fields})}\n---\n${preamble}${Object.entries(sections).map(([heading, body]) => `\n# ${heading}\n${body}`).join('')}`;
export const eventDoc = (value = event()): Doc => ({room: ROOM, path: eventPath(value.id), type: 'calendar_event', fields: {...value}, markdown: markdown('calendar_event', {...value})});

class Observation {
  value: unknown;
  closed = false;
  listeners = new Set<(value: unknown) => void>();
  constructor(value: unknown) {this.value = clone(value);}
  current = () => clone(this.value);
  subscribe = (listener: (value: unknown) => void) => {
    if (this.closed) throw new Error('Cannot subscribe to closed observation');
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  };
  close = () => {this.closed = true; this.listeners.clear();};
  publish(value: unknown) {
    if (this.closed) return;
    this.value = clone(value);
    this.listeners.forEach(listener => listener(this.current()));
  }
}

export const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, release};
};
export const sync = (patch: Record<string, unknown> = {}) => ({state: 'synced', lastCompleted: T0, providerUnreachable: false, attentionRequired: [], reset: null, ...patch});

export class Boundary {
  docs = new Map<string, Doc>();
  drafts = new Map<string, Draft>();
  observations = new Map<string, Observation>();
  allObservations = new Map<string, Set<Observation>>();
  presentationValue: Record<string, unknown> = {};
  presentation = {read: vi.fn(async () => clone(this.presentationValue)), write: vi.fn(async (value: Record<string, unknown>) => {this.presentationValue = clone(value);})};
  roomValues: {locator: string; name?: string}[] = [{locator: ROOM, name: 'Calendar'}];
  lastCompleted: string | null = T0;
  writes: {room: string; path: string; revision: string | null; parts: Parts}[] = [];
  saves: {room: string; drafts: SaveSelection}[] = [];
  queue: {identifier: string; room: string; drafts: Draft[]}[] = [];
  queries: unknown[] = [];
  revision = 0;
  saveGate?: Promise<void>;
  queryGate?: Promise<void>;
  beforeWrite?: (path: string) => void;
  afterWrite?: (path: string) => void;
  beforeRead?: (path: string) => Promise<void> | void;
  beforeSave?: () => void;
  nextSaveRule?: string;

  constructor(docs: Doc[] = []) {docs.forEach(doc => this.docs.set(doc.path, clone(doc)));}
  private assertRoom(room: string) {expect(room).toBe(ROOM);}
  private checkQuery(query: unknown) {
    assertQueryPointers(query);
    expect(query).toEqual({types: ['calendar_event'], select: {fields: 'all', markdown: true}, orderBy: [{by: {field: '/start'}, direction: 'asc'}, {by: 'path', direction: 'asc'}], rooms: [ROOM]});
  }
  private result() {return {documents: [...this.docs.values()].sort((a, b) => Date.parse(String(a.fields.start)) - Date.parse(String(b.fields.start)) || a.path.localeCompare(b.path)).map(({room, path, type, fields, markdown}) => clone({room, path, type, fields, markdown}))};}
  private refreshQuery() {for (const item of this.allObservations.get('query') ?? []) item.publish(this.result());}
  external(doc: Doc) {this.docs.set(doc.path, clone(doc)); this.refreshQuery();}
  externalRemove(path: string) {this.docs.delete(path); this.refreshQuery();}
  publish(topic: string, value: unknown) {
    const observation = this.observations.get(topic);
    if (!observation) throw new Error(`Topic was not observed: ${topic}`);
    for (const item of this.allObservations.get(topic) ?? [observation]) item.publish(value);
  }
  removeRoom() {
    this.docs.clear(); this.drafts.clear(); this.queue = []; this.roomValues = [];
    this.publish('rooms', []);
    if (this.observations.has('room-drafts')) this.publish('room-drafts', []);
  }
  draft(path: string, parts: Draft['parts']): Draft {
    const value: Draft = {room: ROOM, path, revision: `draft-${++this.revision}`, parts: clone(parts), changedUnderneath: {}, returned: null};
    this.drafts.set(path, value);
    if (this.observations.has('room-drafts')) this.publish('room-drafts', [...this.drafts.values()]);
    return clone(value);
  }
  rooms = vi.fn(async () => clone(this.roomValues));
  query = vi.fn(async (query: unknown) => {this.checkQuery(query); this.queries.push(clone(query)); return this.result();});
  observe = vi.fn(async (topic: string, query?: unknown) => {
    if (topic === 'query') {this.checkQuery(query); if (this.queryGate) await this.queryGate;}
    else expect(query).toBeUndefined();
    const values: Record<string, unknown> = {
      query: this.result(), rooms: this.roomValues, 'service-mode': 'open',
      'sync-status': sync({lastCompleted: this.lastCompleted}),
      'connection-refusal': null, 'storage-loss': null, 'room-drafts': [...this.drafts.values()],
    };
    if (!(topic in values)) throw new Error(`Unexpected observation: ${topic}`);
    const observation = new Observation(values[topic]);
    this.observations.set(topic, observation);
    const watchers = this.allObservations.get(topic) ?? new Set<Observation>(); watchers.add(observation); this.allObservations.set(topic, watchers);
    return observation;
  });
  roomDraft = {
    read: vi.fn(async (room: string, path: string) => {this.assertRoom(room); await this.beforeRead?.(path); return clone(this.drafts.get(path) ?? null);}),
    write: vi.fn(async (room: string, path: string, revision: string | null, parts: Parts) => {
      this.assertRoom(room);
      this.writes.push({room, path, revision, parts: clone(parts)});
      this.beforeWrite?.(path);
      const existing = this.drafts.get(path);
      if ((existing?.revision ?? null) !== revision) return {outcome: 'stale' as const, current: clone(existing ?? null)};
      expect(Object.keys(parts).length).toBeGreaterThan(0);
      expect(Object.keys(parts).every(key => ['creation', 'fields', 'sections', 'preamble', 'removal'].includes(key))).toBe(true);
      if (parts.creation) {
        expect(Object.keys(parts.creation).sort()).toEqual(['fields', 'sections', 'type']);
        expect('type' in parts.creation && parts.creation.type).toBe('calendar_event');
      }
      if (parts.fields) for (const change of Object.values(parts.fields)) expect(Object.keys(change).sort()).toEqual(['base', 'value']);
      if (parts.sections) for (const change of Object.values(parts.sections)) expect(Object.keys(change).sort()).toEqual(['base', 'value']);
      if (parts.removal) expect(typeof parts.removal.base).toBe('string');
      // Enforce revision CAS and the first bases, independently of store code.
      if (existing?.parts.fields && parts.fields) for (const [key, part] of Object.entries(parts.fields)) if (existing.parts.fields[key]) expect(part.base).toEqual(existing.parts.fields[key].base);
      if (existing?.parts.sections && parts.sections) for (const [key, part] of Object.entries(parts.sections)) if (existing.parts.sections[key]) expect(part.base).toEqual(existing.parts.sections[key].base);
      const roomDraft = this.draft(path, parts as Draft['parts']);
      this.afterWrite?.(path);
      return {outcome: 'written' as const, roomDraft};
    }),
    discard: vi.fn(async () => {throw new Error('The store must not silently discard shared drafts');}),
  };
  save = vi.fn(async (room: string, selections: SaveSelection): Promise<SaveResult> => {
    this.assertRoom(room);
    this.saves.push({room, drafts: clone(selections)});
    expect(new Set(selections.map(item => item.path)).size).toBe(selections.length);
    selections.forEach(item => expect(Object.keys(item).sort()).toEqual(['path', 'revision']));
    if (this.saveGate) await this.saveGate;
    this.beforeSave?.();
    if (this.nextSaveRule) return {outcome: 'refused', rule: this.nextSaveRule};
    const next = new Map([...this.docs].map(([path, doc]) => [path, clone(doc)]));
    for (const selection of selections) {
      const draft = this.drafts.get(selection.path);
      if (!draft || draft.revision !== selection.revision) return {outcome: 'refused', rule: 'stale'};
      let current = next.get(selection.path);
      if (draft.parts.removal) {
        if (!current || current.markdown !== draft.parts.removal.base) return {outcome: 'refused', rule: 'changed-underneath'};
        next.delete(selection.path); continue;
      }
      if (draft.parts.creation) {
        if (current) return {outcome: 'refused', rule: 'changed-underneath'};
        if (!('type' in draft.parts.creation)) throw new Error('Unexpected raw-markdown creation');
        const {type, fields, sections} = draft.parts.creation;
        current = {room: ROOM, path: selection.path, type, fields: clone({...fields}), sections: clone({...sections}), markdown: ''};
        next.set(selection.path, current);
      }
      if (!current) return {outcome: 'refused', rule: 'changed-underneath'};
      if (draft.parts.fields) for (const [key, change] of Object.entries(draft.parts.fields)) {
        const base = key in current.fields ? {value: current.fields[key]} : null;
        if (!draft.parts.creation && !same(base, change.base)) return {outcome: 'refused', rule: 'changed-underneath'};
        current.fields[key] = clone(change.value);
      }
      if (draft.parts.sections) for (const [key, change] of Object.entries(draft.parts.sections)) {
        if ((current.sections?.[key] ?? '') !== change.base) return {outcome: 'refused', rule: 'changed-underneath'};
        current.sections = {...current.sections, [key]: change.value};
      }
      if (draft.parts.preamble) {
        if ((current.preamble ?? '') !== draft.parts.preamble.base) return {outcome: 'refused', rule: 'changed-underneath'};
        current.preamble = draft.parts.preamble.value;
      }
      current.markdown = markdown(current.type, current.fields, current.sections, current.preamble);
    }
    // Independent small local-validation contract, deliberately not eventSchema.
    for (const doc of next.values()) {
      expect(doc.type).toBe('calendar_event');
      expect(doc.path).toBe(eventPath(String(doc.fields.id)));
      if (typeof doc.fields.title !== 'string' || !doc.fields.title.trim() || !Number.isFinite(Date.parse(String(doc.fields.start))) || !Number.isFinite(Date.parse(String(doc.fields.end))) || Date.parse(String(doc.fields.end)) < Date.parse(String(doc.fields.start))) return {outcome: 'refused', rule: 'calendar-validation'};
    }
    const identifier = `local-batch-${this.saves.length}`;
    this.queue.push({identifier, room, drafts: selections.map(selection => clone(this.drafts.get(selection.path)!))});
    this.docs = next;
    selections.forEach(selection => this.drafts.delete(selection.path));
    this.refreshQuery();
    if (this.observations.has('room-drafts')) this.publish('room-drafts', [...this.drafts.values()]);
    // Queue admission and its local visible overlay only, never confirmation.
    this.publish('sync-status', sync({state: 'pending'}));
    return {outcome: 'saved', identifier};
  });
  client() {return {rooms: this.rooms, query: this.query, observe: this.observe, roomDraft: this.roomDraft, presentation: this.presentation, save: this.save} as unknown as MdRuntimeClient;}
}
