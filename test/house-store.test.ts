import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ConnectionRefusal} from '@agentshouse/mdruntime';
import {HouseDataStore, OPENED, type CalendarEvent} from '../src/data/house';
import {Boundary, ROOM, E1, E2, E3, START, END, eventPath, event, eventDoc, gate, sync, type Doc, type Draft} from './house-boundary';

const stores: HouseDataStore[] = [];
const sessions: {close(): void}[] = [];
async function setup(input: Doc[] | Boundary = [eventDoc()]) {
  const boundary = input instanceof Boundary ? input : new Boundary(input);
  const provider = vi.fn(async () => boundary.client());
  const store = new HouseDataStore(provider); stores.push(store);
  await store.start();
  return {boundary, store, provider};
}
async function edit(store: HouseDataStore, initial?: CalendarEvent, proposed?: Partial<CalendarEvent>) {
  const session = await store.openEditor(initial, proposed); sessions.push(session); return session;
}
function fields(boundary: Boundary, path = eventPath(E1)) {return boundary.drafts.get(path)?.parts.fields;}
const refusal = {code: 'revoked-authorization', retryable: false, reauthorizationOffered: true, refusal: null} satisfies ConnectionRefusal;
afterEach(() => {sessions.splice(0).forEach(session => session.close()); stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks();});

describe('calendar published-client boundary and live binding', () => {
  it('starts once, reads an empty Room without seed writes, and closes observations', async () => {
    const {boundary, store, provider} = await setup([]);
    await Promise.all([store.start(), store.start()]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(store.snapshot()).toMatchObject({events: [], loading: false, error: null, busy: false});
    expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
    expect([...boundary.observations.keys()].sort()).toEqual(['connection-refusal', 'query', 'rooms', 'service-mode', 'storage-loss', 'sync-status']);
    store.dispose();
    expect([...boundary.observations.values()].every(handle => handle.closed && handle.listeners.size === 0)).toBe(true);
  });

  it('observes remote additions, edits, and removals without polling or autosaving', async () => {
    const {boundary, store} = await setup();
    const changed = vi.fn(); const stop = store.subscribe(changed); const version = store.snapshot().version;
    boundary.external(eventDoc(event(E2, 'Second event')));
    boundary.external(eventDoc({...event(), location: 'Remote room'}));
    expect(store.snapshot().events).toHaveLength(2);
    expect(store.snapshot().events[0].location).toBe('Remote room');
    expect(store.snapshot().version).toBeGreaterThan(version);
    boundary.externalRemove(eventPath(E1));
    expect(store.snapshot().events.map(item => item.id)).toEqual([E2]);
    expect(changed).toHaveBeenCalled(); stop(); changed.mockClear();
    boundary.externalRemove(eventPath(E2)); expect(changed).not.toHaveBeenCalled();
    expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.saves).toEqual([]);
  });

  it('orders events by start instant and then path, regardless of identity format', async () => {
    const early = {...event('z-early'), start: '2026-10-12T09:00:00.000+02:00'};
    const tied = {...event('a-tied'), start: '2026-10-12T07:00:00.000Z'};
    const {store} = await setup([eventDoc(), eventDoc(early), eventDoc(tied)]);
    expect(store.snapshot().events.map(item => item.id)).toEqual(['a-tied', 'z-early', E1]);
  });

  it('waits for completed sync and exactly one Room before observing business data', async () => {
    const boundary = new Boundary([eventDoc()]); boundary.lastCompleted = null; boundary.roomValues = [];
    const {store} = await setup(boundary);
    expect(store.snapshot()).toMatchObject({events: [], loading: true, error: null});
    expect(boundary.observations.has('query')).toBe(false);
    await expect(edit(store)).rejects.toThrow(/loading/);
    boundary.publish('rooms', [{locator: ROOM}, {locator: 'room:other'}]);
    boundary.publish('sync-status', sync());
    expect(store.snapshot().error).toMatch(/exactly one/);
    expect(boundary.observations.has('query')).toBe(false);
    boundary.publish('rooms', [{locator: ROOM}]);
    await vi.waitFor(() => expect(store.snapshot()).toMatchObject({loading: false, error: null}));
    expect(store.snapshot().events).toHaveLength(1); expect(boundary.writes).toEqual([]);
  });

  it('closes a late query observation if the Room disappears during binding', async () => {
    const boundary = new Boundary([eventDoc()]); const delayed = gate(); boundary.queryGate = delayed.promise;
    const store = new HouseDataStore(async () => boundary.client()); stores.push(store);
    const starting = store.start();
    await vi.waitFor(() => expect(boundary.observations.has('rooms')).toBe(true));
    boundary.publish('rooms', []); delayed.release(); await starting;
    expect(store.snapshot().events).toEqual([]);
    expect(boundary.observations.get('query')?.closed).toBe(true);
    await expect(edit(store)).rejects.toThrow(); expect(boundary.writes).toEqual([]);
  });

  it('clears removed-Room state, blocks writes and Save, and does not revive off-Room input', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({title: 'Draft before removal'});
    boundary.removeRoom();
    expect(store.snapshot().events).toEqual([]); expect(session.value()).toEqual({});
    const before = boundary.writes.length;
    await expect(session.write({title: 'Typed without a Room'})).rejects.toThrow(/Room.*available|binding/i);
    await expect(session.commit()).rejects.toThrow(); expect(boundary.writes).toHaveLength(before); expect(boundary.saves).toEqual([]);
    boundary.external(eventDoc(event(E1, 'Freshly reached')));
    boundary.publish('rooms', [{locator: ROOM}]);
    await vi.waitFor(() => expect(store.snapshot().events[0]?.title).toBe('Freshly reached'));
    expect(session.value().title).not.toBe('Typed without a Room');
    expect(session.value().title).not.toBe('Draft before removal');
    expect(boundary.drafts.size).toBe(0);
  });

  it('does not flush queued keystrokes after reach is removed during a draft read', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    const delayed = gate(); let reading = false;
    boundary.beforeRead = async () => {boundary.beforeRead = undefined; reading = true; await delayed.promise;};
    const writing = session.write({title: 'Pending before reach removal'});
    await vi.waitFor(() => expect(reading).toBe(true));
    boundary.removeRoom(); delayed.release();
    await expect(writing).rejects.toThrow(/Room.*available|binding/i);
    expect(session.value()).toEqual({}); expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
  });

  it('keeps connection refusal and storage loss actionable and blocks mutations', async () => {
    const {boundary, store} = await setup();
    boundary.publish('connection-refusal', refusal);
    expect(store.snapshot().error).toMatch(/revoked-authorization/);
    boundary.external(eventDoc(event(E2))); expect(store.snapshot().error).toMatch(/revoked-authorization/);
    await expect(edit(store)).rejects.toThrow(/revoked-authorization/);
    boundary.publish('storage-loss', 'test-storage-loss');
    expect(store.snapshot().error).toMatch(/storage loss/); expect(boundary.writes).toEqual([]);
  });

  it('surfaces invalid or duplicate visible event data rather than silently accepting it', async () => {
    const {boundary, store} = await setup();
    boundary.external({...eventDoc(event(E2)), fields: {...event(E2), start: 'bad-date'}});
    expect(store.snapshot().error).toBeTruthy(); await expect(edit(store)).rejects.toThrow();
    boundary.externalRemove(eventPath(E2)); expect(store.snapshot().error).toBeNull();
    boundary.external({...eventDoc(), path: 'events/duplicate.md'});
    expect(store.snapshot().error).toMatch(/Duplicate/); expect(boundary.saves).toEqual([]);
  });
});

describe('Calendar connection-refusal recovery', () => {
  it('clears a transient refusal on the same ready store using the current live query', async () => {
    const {boundary, store, provider} = await setup();
    const query = boundary.observations.get('query');
    boundary.publish('connection-refusal', refusal);
    boundary.external(eventDoc(event(E1, 'Latest observed title')));
    boundary.publish('sync-status', sync());
    expect(store.snapshot().error).toMatch(/revoked-authorization/);
    boundary.publish('connection-refusal', null);
    expect(store.snapshot()).toMatchObject({loading: false, error: null, events: [{title: 'Latest observed title'}]});
    expect((await edit(store, store.snapshot().events[0])).value().title).toBe('Latest observed title');
    expect(provider).toHaveBeenCalledTimes(1); expect(boundary.observations.get('query')).toBe(query);
    expect(query?.closed).toBe(false); expect(boundary.query).not.toHaveBeenCalled();
    expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
  });

  it.each(['rooms-first', 'sync-first'] as const)('keeps edits blocked after refusal clears until Room and sync are ready (%s)', async order => {
    const boundary = new Boundary([eventDoc()]); boundary.lastCompleted = null; boundary.roomValues = [];
    const {store} = await setup(boundary);
    boundary.publish('connection-refusal', refusal); boundary.publish('connection-refusal', null);
    expect(store.snapshot()).toMatchObject({events: [], loading: true, error: null});
    await expect(edit(store)).rejects.toThrow(/loading|available|binding/i);
    if (order === 'rooms-first') boundary.publish('rooms', [{locator: ROOM}]);
    else boundary.publish('sync-status', sync());
    expect(boundary.observations.has('query')).toBe(false);
    await expect(edit(store)).rejects.toThrow(/loading|available|binding/i);
    if (order === 'rooms-first') boundary.publish('sync-status', sync());
    else boundary.publish('rooms', [{locator: ROOM}]);
    await vi.waitFor(() => expect(store.snapshot()).toMatchObject({loading: false, error: null}));
    expect((await edit(store, store.snapshot().events[0])).value().title).toBe('Planning');
    expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
  });

  it('retains query-validation errors when a refusal clears instead of blindly enabling edits', async () => {
    const {boundary, store} = await setup();
    boundary.publish('connection-refusal', refusal);
    boundary.external({...eventDoc(), fields: {...event(), start: 'partial date'}});
    boundary.publish('connection-refusal', null);
    expect(store.snapshot().error).toBeTruthy();
    expect(store.snapshot().error).not.toMatch(/connection refused/i);
    await expect(edit(store)).rejects.toThrow();
    boundary.external(eventDoc());
    expect(store.snapshot().error).toBeNull();
    expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
  });

  it('keeps an active refusal blocking existing and new editors through healthy Room, sync, and query updates', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({title: 'Existing native draft'});
    const writes = boundary.writes.length; const retained = boundary.drafts.get(session.path);
    boundary.publish('connection-refusal', refusal);
    boundary.publish('sync-status', sync()); boundary.publish('rooms', [{locator: ROOM}]);
    boundary.external(eventDoc(event(E2)));
    expect(store.snapshot().error).toMatch(/revoked-authorization/);
    await expect(edit(store)).rejects.toThrow(/revoked-authorization/);
    await expect(session.write({title: 'Blocked typing'})).rejects.toThrow(/revoked-authorization/);
    await expect(session.commit()).rejects.toThrow(/revoked-authorization/);
    expect(session.value().title).toBe('Existing native draft');
    expect(boundary.drafts.get(session.path)).toEqual(retained); expect(boundary.writes).toHaveLength(writes);
    expect(boundary.saves).toEqual([]); expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it.each(['existing', 'new'] as const)('preserves the mounted %s editor and its raw native draft through refusal-clear, continued typing, and Save', async kind => {
    const {boundary, store} = await setup(kind === 'new' ? [] : [eventDoc()]);
    const session = await edit(store, kind === 'existing' ? store.snapshot().events[0] : undefined);
    const raw = {title: '', start: '2026-10-', end: '', description: '\n  keep raw input  \n'};
    await session.write(raw);
    const held = boundary.drafts.get(session.path); const writes = boundary.writes.length;
    const observation = boundary.observations.get('room-drafts'); const redraw = vi.fn(); session.subscribe(redraw);
    boundary.publish('connection-refusal', refusal);
    expect(session.value()).toMatchObject(raw);
    await expect(session.write({title: 'Blocked title'})).rejects.toThrow(/revoked-authorization/);
    boundary.publish('connection-refusal', null);
    expect(store.snapshot().error).toBeNull(); expect(session.value()).toMatchObject(raw);
    expect(boundary.drafts.get(session.path)).toEqual(held); expect(boundary.writes).toHaveLength(writes);
    expect(boundary.observations.get('room-drafts')).toBe(observation); expect(observation?.closed).toBe(false);
    expect(redraw).toHaveBeenCalled();
    await expect(session.commit()).rejects.toThrow(); expect(boundary.saves).toEqual([]);
    await session.write({title: 'Recovered title', start: START, end: END});
    expect(session.value()).toMatchObject({title: 'Recovered title', description: raw.description});
    if (kind === 'existing') expect(fields(boundary)?.title.base).toEqual({value: 'Planning'});
    const revision = boundary.drafts.get(session.path)!.revision;
    await session.commit();
    expect(boundary.saves).toEqual([{room: ROOM, drafts: [{path: session.path, revision}]}]);
    expect(boundary.queue).toHaveLength(1); expect(boundary.drafts.has(session.path)).toBe(false);
    expect(boundary.docs.get(session.path)?.fields).toMatchObject({title: 'Recovered title', start: START, end: END, description: raw.description});
    expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it.each(['loss-first', 'refusal-first'] as const)('never conceals latched storage loss through refusal transitions or healthy sync (%s)', async order => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({title: 'Retained draft'}); const held = boundary.drafts.get(session.path);
    if (order === 'refusal-first') boundary.publish('connection-refusal', refusal);
    boundary.publish('storage-loss', 'test-storage-loss');
    boundary.publish('connection-refusal', refusal);
    expect(store.snapshot().error).toMatch(/storage loss/);
    boundary.publish('connection-refusal', null); boundary.publish('storage-loss', null);
    boundary.publish('rooms', [{locator: ROOM}]); boundary.publish('sync-status', sync()); boundary.external(eventDoc(event(E2)));
    expect(store.snapshot().error).toMatch(/storage loss/);
    await expect(edit(store)).rejects.toThrow(/storage loss/);
    await expect(session.write({title: 'Unsafe edit'})).rejects.toThrow(/storage loss/);
    await expect(session.commit()).rejects.toThrow(/storage loss/);
    expect(boundary.drafts.get(session.path)).toEqual(held); expect(boundary.saves).toEqual([]);
    expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it('preserves first bases and native changed-underneath refusal after connection recovery', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({title: 'Local unsaved title'});
    boundary.publish('connection-refusal', refusal); boundary.external(eventDoc(event(E1, 'Remote title')));
    boundary.publish('connection-refusal', null);
    expect(store.snapshot().error).toBeNull(); expect(session.value().title).toBe('Local unsaved title');
    await session.write({title: 'Continued local title'});
    expect(fields(boundary)?.title.base).toEqual({value: 'Planning'});
    const held = boundary.drafts.get(session.path)!;
    await expect(session.commit()).rejects.toThrow(/changed-underneath/);
    expect(boundary.saves).toEqual([{room: ROOM, drafts: [{path: session.path, revision: held.revision}]}]);
    expect(boundary.drafts.get(session.path)).toEqual(held); expect(boundary.queue).toEqual([]);
    expect(boundary.docs.get(session.path)?.fields.title).toBe('Remote title');
    expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it('keeps returned-draft attention and native rejection visible after connection recovery', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({title: 'Returned local title'});
    const returned = {kind: 'rejected', retryable: false, code: 'calendar-validation', fields: {title: 'Review this event'}} satisfies NonNullable<Draft['returned']>;
    const held = {...boundary.drafts.get(session.path)!, returned};
    boundary.drafts.set(session.path, held); boundary.publish('room-drafts', [held]);
    boundary.publish('sync-status', sync({attentionRequired: [{room: ROOM, path: session.path, returned}]}));
    boundary.publish('connection-refusal', refusal); boundary.publish('connection-refusal', null);
    expect(store.snapshot().error).toBeNull(); expect(store.snapshot().status).toMatch(/drafts need attention/i);
    expect(session.value().title).toBe('Returned local title'); expect(boundary.drafts.get(session.path)).toEqual(held);
    boundary.nextSaveRule = 'calendar-validation';
    await expect(session.commit()).rejects.toThrow(/calendar-validation/);
    expect(boundary.saves).toEqual([{room: ROOM, drafts: [{path: session.path, revision: held.revision}]}]);
    expect(boundary.drafts.get(session.path)).toEqual(held); expect(boundary.queue).toEqual([]);
    expect(store.snapshot().status).toMatch(/drafts need attention/i); expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });
});

describe('durable raw Calendar business drafts', () => {
  it('persists every awaited keystroke, including temporarily invalid input, without Save', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    for (const title of ['', 'P', 'Pl', 'Plan']) {
      await session.write({title}); expect(fields(boundary)?.title.value).toBe(title);
      expect(fields(boundary)?.title.base).toEqual({value: 'Planning'}); expect(boundary.saves).toEqual([]);
    }
    await session.write({start: '2026-10-', end: '', description: '\n    raw code\nline  \n', location: 'Room #'});
    expect(fields(boundary)?.start.value).toBe('2026-10-'); expect(fields(boundary)?.end.value).toBe('');
    const retained = boundary.drafts.get(session.path);
    await expect(session.commit()).rejects.toThrow(); expect(boundary.saves).toEqual([]);
    expect(boundary.drafts.get(session.path)).toEqual(retained);
    session.close();
    const reopened = await edit(store, store.snapshot().events[0]);
    expect(reopened.value()).toMatchObject({title: 'Plan', start: '2026-10-', end: '', description: '\n    raw code\nline  \n', location: 'Room #'});
  });

  it('creates a durable blank draft immediately and restores it across store navigation', async () => {
    const {boundary, store} = await setup([]);
    boundary.presentationValue = {view: 'week', unrelated: {scroll: 42}};
    const first = await edit(store);
    expect(boundary.drafts.get(first.path)?.parts.creation).toMatchObject({type: 'calendar_event', fields: {title: '', start: '', end: ''}, sections: {}});
    await first.write({title: 'Raw title', start: '2026-10-12T09:', description: 'Unsaved notes'}); first.close(); store.dispose();
    const {store: next} = await setup(boundary); const reopened = await edit(next);
    expect(reopened.path).toBe(first.path);
    expect(reopened.value()).toMatchObject({title: 'Raw title', start: '2026-10-12T09:', description: 'Unsaved notes'});
    expect(boundary.presentationValue).toMatchObject({view: 'week', unrelated: {scroll: 42}, calendarDrafts: {[`calendar:${ROOM}:new`]: first.path}});
    expect(JSON.stringify(boundary.presentationValue)).not.toContain('Unsaved notes');
    expect(boundary.saves).toEqual([]); await expect(reopened.commit()).rejects.toThrow();
  });

  it('only explicit commit validates and queues a new event, then starts a fresh creation', async () => {
    const {boundary, store} = await setup([]); const first = await edit(store);
    await first.write({title: 'New event', start: START, end: END});
    expect(boundary.docs.size).toBe(0); expect(boundary.queue).toEqual([]);
    await first.commit();
    expect(boundary.saves).toHaveLength(1); expect(boundary.queue).toHaveLength(1);
    expect(boundary.drafts.has(first.path)).toBe(false);
    expect(store.snapshot().events[0]).toMatchObject({title: 'New event', start: START, end: END});
    const next = await edit(store); expect(next.path).not.toBe(first.path); expect(next.value().title).toBe('');
    expect(boundary.saves).toHaveLength(1);
  });

  it('retains queued typing when the form closes immediately', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    const typing = session.write({description: 'Navigate immediately'}); session.close(); await typing;
    const reopened = await edit(store, store.snapshot().events[0]);
    expect(reopened.value().description).toBe('Navigate immediately'); expect(boundary.saves).toEqual([]);
  });

  it('refuses identity, timestamps, and other noneditable mutations before drafting', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    for (const patch of [{id: E2}, {createdAt: END}, {updatedAt: END}, {arbitrary: true}]) await expect(session.write(patch)).rejects.toThrow(/editable/);
    expect(boundary.writes).toEqual([]); expect(session.value().id).toBe(E1);
    await expect(edit(store, event())).rejects.toThrow(/Reopen/);
    await expect(edit(store, {...store.snapshot().events[0], [OPENED]: {...eventDoc(), room: 'room:other'}})).rejects.toThrow(/Reopen/);
  });

  it('permits nullable recurrence metadata and preserves optional business values', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({rrule: null, uid: null, recurrenceId: null, exdates: [], allDay: false, color: '', backgroundColor: '', location: ''});
    expect(session.value()).toMatchObject({rrule: null, uid: null, recurrenceId: null, exdates: [], allDay: false, color: ''});
    await session.commit(); expect(boundary.docs.get(session.path)?.fields).toMatchObject({rrule: null, uid: null, recurrenceId: null});
  });

  it('refuses end-before-start on Save but keeps raw inputs until corrected', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({end: '2026-10-12T08:00:00.000Z'});
    await expect(session.commit()).rejects.toThrow(/End/);
    expect(fields(boundary)?.end.value).toBe('2026-10-12T08:00:00.000Z'); expect(boundary.saves).toEqual([]);
    await session.write({end: START}); await session.commit(); expect(boundary.saves).toHaveLength(1);
  });
});

describe('shared draft CAS and cross-tab observations', () => {
  it('merges disjoint fields across stores, preserves sections and preamble, and keeps first bases', async () => {
    const {boundary, store} = await setup(); const {store: other} = await setup(boundary);
    boundary.draft(eventPath(E1), {sections: {Notes: {value: 'Other tab section', base: ''}}, preamble: {value: 'Other preamble', base: ''}});
    const one = await edit(store, store.snapshot().events[0]); const two = await edit(other, other.snapshot().events[0]);
    const notified = vi.fn(); const stop = two.subscribe(notified);
    await one.write({title: 'Tab one'}); await two.write({location: 'Tab two'}); await one.write({title: 'Latest title'});
    expect(one.value()).toMatchObject({title: 'Latest title', location: 'Tab two'});
    expect(two.value()).toMatchObject({title: 'Latest title', location: 'Tab two'}); expect(notified).toHaveBeenCalled(); stop();
    expect(fields(boundary)?.title.base).toEqual({value: 'Planning'}); expect(fields(boundary)?.location.base).toBeNull();
    expect(boundary.drafts.get(one.path)?.parts).toMatchObject({sections: {Notes: {value: 'Other tab section', base: ''}}, preamble: {value: 'Other preamble', base: ''}});
    await one.commit(); expect(boundary.docs.get(one.path)).toMatchObject({fields: {title: 'Latest title', location: 'Tab two'}, sections: {Notes: 'Other tab section'}, preamble: 'Other preamble'});
  });

  it('rereads a stale revision, preserves disjoint data, and makes later same-field typing win', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    boundary.beforeWrite = path => {
      boundary.beforeWrite = undefined;
      boundary.draft(path, {fields: {title: {value: 'Competing earlier title', base: {value: 'Planning'}}, location: {value: 'Other tab location', base: null}}, sections: {Notes: {value: 'Other tab notes', base: ''}}});
    };
    const reads = boundary.roomDraft.read.mock.calls.length;
    await session.write({title: 'Later local title'});
    expect(boundary.writes).toHaveLength(2); expect(boundary.writes[0].revision).toBeNull(); expect(boundary.writes[1].revision).toBe('draft-1');
    expect(boundary.roomDraft.read.mock.calls.length - reads).toBeGreaterThanOrEqual(3);
    expect(session.value()).toMatchObject({title: 'Later local title', location: 'Other tab location'});
    expect(fields(boundary)?.title.base).toEqual({value: 'Planning'});
    expect(boundary.drafts.get(session.path)?.parts.sections?.Notes.value).toBe('Other tab notes'); expect(boundary.saves).toEqual([]);
  });

  it('does not roll back newer observed input when an older write response resolves', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    boundary.afterWrite = path => {boundary.afterWrite = undefined; boundary.draft(path, {fields: {title: {value: 'Later other tab', base: {value: 'Planning'}}}});};
    await session.write({title: 'Earlier local'});
    expect(session.value().title).toBe('Later other tab'); expect(fields(boundary)?.title.value).toBe('Later other tab');
  });

  it('coalesces queued typing once and never replays it over later foreign input', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    boundary.afterWrite = path => {boundary.afterWrite = undefined; boundary.draft(path, {fields: {title: {value: 'Foreign C', base: {value: 'Planning'}}}});};
    const a = session.write({title: 'A'}); const b = session.write({title: 'B'}); await Promise.all([a, b]);
    expect(boundary.writes).toHaveLength(1); expect(session.value().title).toBe('Foreign C');
  });

  it('persists fresh keystrokes that arrive during a previous write', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    let later: Promise<void> | undefined;
    boundary.afterWrite = () => {boundary.afterWrite = undefined; later = session.write({title: 'B during A', location: 'Second field'});};
    await session.write({title: 'A'}); await later;
    expect(session.value()).toMatchObject({title: 'B during A', location: 'Second field'}); expect(fields(boundary)?.title.value).toBe('B during A');
    expect(boundary.writes).toHaveLength(2);
  });

  it('uses the live displayed base when a field is first typed after a remote redraw', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    boundary.external(eventDoc(event(E1, 'Visible remote title')));
    expect(session.value().title).toBe('Visible remote title');
    await session.write({title: 'Typed after seeing remote'});
    expect(fields(boundary)?.title.base).toEqual({value: 'Visible remote title'}); await session.commit();
  });

  it('preserves first typed bases across remote edits and refuses changed-underneath Save', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    await session.write({title: 'First local title'});
    boundary.external(eventDoc(event(E1, 'Remote title')));
    await session.write({title: 'Revised local title'});
    expect(fields(boundary)?.title.base).toEqual({value: 'Planning'});
    await expect(session.commit()).rejects.toThrow(/changed-underneath/);
    expect(boundary.docs.get(session.path)?.fields.title).toBe('Remote title'); expect(fields(boundary)?.title.value).toBe('Revised local title');
    expect(boundary.saves).toHaveLength(1); expect(boundary.queue).toEqual([]); expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it('refreshes an open editor after another tab saves and anchors its next draft to that visible state', async () => {
    const {boundary, store} = await setup(); const {store: other} = await setup(boundary);
    const one = await edit(store, store.snapshot().events[0]); const two = await edit(other, other.snapshot().events[0]);
    await one.write({title: 'Saved first'}); await one.commit(); expect(two.value().title).toBe('Saved first');
    await two.write({title: 'Typed after Save'});
    expect(fields(boundary)?.title.base).toEqual({value: 'Saved first'}); await two.commit();
    expect(one.value().title).toBe('Typed after Save'); expect(boundary.queue).toHaveLength(2);
  });

  it('transitions an open creation editor to field patches after another tab saves it', async () => {
    const {boundary, store} = await setup([]); const first = await edit(store, undefined, {title: 'New saved event', start: START, end: END});
    const {store: other} = await setup(boundary); const second = await edit(other); expect(second.path).toBe(first.path);
    await second.commit(); await first.write({title: 'Continue typing'});
    expect(boundary.drafts.get(first.path)?.parts.creation).toBeUndefined();
    expect(fields(boundary, first.path)?.title).toEqual({value: 'Continue typing', base: {value: 'New saved event'}});
    await first.commit(); expect(boundary.docs.get(first.path)?.fields.title).toBe('Continue typing');
  });

  it('does not resurrect a new event after it was saved and then removed remotely', async () => {
    const {boundary, store} = await setup([]); const session = await edit(store, undefined, {title: 'Created event', start: START, end: END});
    await session.commit(); boundary.externalRemove(session.path);
    const saves = boundary.saves.length;
    await expect(session.write({title: 'Stale open form'})).rejects.toThrow(/removed|available/i);
    await expect(session.commit()).rejects.toThrow(/removed|available/i);
    expect(boundary.docs.has(session.path)).toBe(false); expect(boundary.saves).toHaveLength(saves);
    expect(boundary.drafts.get(session.path)?.parts.creation).toBeUndefined();
  });

  it('does not overwrite a resumed creation draft with fresh UI defaults', async () => {
    const {boundary, store} = await setup([]);
    const first = await edit(store, undefined, {title: 'Default title', start: START, end: END});
    await first.write({title: 'User edited title', start: 'partial start', description: 'Keep exact draft'}); first.close();
    const writes = boundary.writes.length;
    const second = await edit(store, undefined, {title: 'Default title again', start: END, end: END});
    expect(second.path).toBe(first.path);
    expect(second.value()).toMatchObject({title: 'User edited title', start: 'partial start', description: 'Keep exact draft'});
    expect(boundary.writes).toHaveLength(writes); expect(boundary.saves).toEqual([]);
  });

  it('keeps field and section overrides already present on creation drafts', async () => {
    const {boundary, store} = await setup([]); const session = await edit(store);
    const held = boundary.drafts.get(session.path)!;
    const creation = held.parts.creation!; if (!('fields' in creation)) throw new Error('Expected typed creation');
    boundary.draft(session.path, {...held.parts, creation: {...creation, sections: {Notes: 'Creation notes'}}, fields: {location: {value: 'Other tab location', base: null}}});
    await session.write({title: 'My title'});
    expect(boundary.drafts.get(session.path)?.parts).toMatchObject({creation: {sections: {Notes: 'Creation notes'}}, fields: {location: {value: 'Other tab location', base: null}}});
    expect(session.value().location).toBe('Other tab location');
  });

  it.each(['removal', 'move', 'markdown'] as const)('rejects incompatible %s drafts without replacing or discarding them', async kind => {
    const {boundary, store} = await setup(); const original = boundary.docs.get(eventPath(E1))!;
    const parts: Draft['parts'] = kind === 'removal' ? {removal: {base: original.markdown}} : kind === 'move' ? {move: {to: 'events/elsewhere.md', base: original.markdown}} : {markdown: {value: '# Changed', base: original.markdown}};
    const held = boundary.draft(original.path, parts);
    await expect(edit(store, store.snapshot().events[0])).rejects.toThrow(/structural/);
    expect(boundary.drafts.get(original.path)).toEqual(held); expect(boundary.writes).toEqual([]); expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it('surfaces structural drafts arriving while an editor is open and refuses subsequent writes', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]);
    const held = boundary.draft(session.path, {removal: {base: boundary.docs.get(session.path)!.markdown}});
    expect(session.error()).toMatch(/structural/); await expect(session.write({title: 'Overwrite removal'})).rejects.toThrow(/structural/);
    await expect(session.commit()).rejects.toThrow(/structural/); expect(boundary.drafts.get(session.path)).toEqual(held); expect(boundary.saves).toEqual([]);
  });
});

describe('explicit local Save and atomic calendar mutations', () => {
  it('queues Save during Provider write halt and outage, leaving transport to Runtime', async () => {
    const {boundary, store} = await setup(); boundary.publish('service-mode', 'write-halted');
    boundary.publish('sync-status', sync({state: 'pending', providerUnreachable: true}));
    expect(store.snapshot().halted).toBe(true); expect(store.snapshot().status).toMatch(/unavailable/);
    const session = await edit(store, store.snapshot().events[0]); await session.write({title: 'Queue locally'}); await session.commit();
    expect(boundary.saves).toHaveLength(1); expect(boundary.queue).toHaveLength(1); expect(store.snapshot().halted).toBe(true);
    boundary.publish('service-mode', 'open'); expect(store.snapshot().halted).toBe(false);
  });

  it('does not Save a clean existing editor', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]); await session.commit();
    expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
  });

  it('refuses repeated Save while one is in flight', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]); await session.write({title: 'Pending'});
    const delayed = gate(); boundary.saveGate = delayed.promise; const first = session.commit();
    await vi.waitFor(() => expect(boundary.saves).toHaveLength(1)); expect(store.snapshot().busy).toBe(true);
    await expect(session.commit()).rejects.toThrow(/already in progress/); expect(boundary.saves).toHaveLength(1);
    delayed.release(); await first; expect(store.snapshot().busy).toBe(false);
  });

  it('retains a newer shared draft when Save loses revision CAS, without retrying or discarding', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]); await session.write({title: 'My draft'});
    const revision = boundary.drafts.get(session.path)!.revision; let competing: Draft | undefined;
    boundary.beforeSave = () => {competing = boundary.draft(session.path, {fields: {title: {value: 'Newer draft', base: {value: 'Planning'}}}});};
    await expect(session.commit()).rejects.toThrow(/stale/);
    expect(boundary.saves).toEqual([{room: ROOM, drafts: [{path: session.path, revision}]}]);
    expect(boundary.drafts.get(session.path)).toEqual(competing); expect(boundary.docs.get(session.path)?.fields.title).toBe('Planning');
    expect(boundary.queue).toEqual([]); expect(boundary.roomDraft.discard).not.toHaveBeenCalled(); expect(store.snapshot().busy).toBe(false);
  });

  it('retains local drafts after Runtime validation refusal without retrying Save', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]); await session.write({title: 'Valid local draft'});
    boundary.nextSaveRule = 'model-validation'; const retained = boundary.drafts.get(session.path);
    await expect(session.commit()).rejects.toThrow(/model-validation/);
    expect(boundary.saves).toHaveLength(1); expect(boundary.drafts.get(session.path)).toEqual(retained); expect(boundary.queue).toEqual([]);
  });

  it('does not resurrect an event removed remotely while its form was open', async () => {
    const {boundary, store} = await setup(); const session = await edit(store, store.snapshot().events[0]); await session.write({title: 'Unfinished'});
    boundary.externalRemove(session.path); await expect(session.commit()).rejects.toThrow(/removed/);
    expect(boundary.saves).toEqual([]); expect(boundary.drafts.get(session.path)).toBeDefined();
  });

  it('stages a mixed creation, update, and deletion and saves all three in one Change Batch', async () => {
    const {boundary, store} = await setup([eventDoc(), eventDoc(event(E2, 'Delete this occurrence'))]);
    const mutation = await store.openMutationEditor({added: [event(E3, 'New occurrence')], updated: [{...store.snapshot().events[0], title: 'Edited series'}], deleted: [store.snapshot().events[1]]}); sessions.push(mutation);
    expect(mutation.count).toBe(3); expect(boundary.saves).toEqual([]); expect(boundary.docs.size).toBe(2);
    expect(boundary.drafts.get(eventPath(E3))?.parts.creation).toMatchObject({type: 'calendar_event', fields: {id: E3, title: 'New occurrence'}});
    expect(fields(boundary)?.title.value).toBe('Edited series'); expect(boundary.drafts.get(eventPath(E2))?.parts.removal).toBeDefined();
    await mutation.commit();
    expect(boundary.saves).toHaveLength(1); expect(boundary.saves[0].drafts.map(item => item.path).sort()).toEqual([E1, E2, E3].map(eventPath).sort());
    expect(boundary.queue).toHaveLength(1); expect([...boundary.docs.keys()].sort()).toEqual([eventPath(E1), eventPath(E3)].sort()); expect(boundary.drafts.size).toBe(0);
  });

  it('retains every draft and changes no document when any mutation member conflicts at Save', async () => {
    const {boundary, store} = await setup([eventDoc(), eventDoc(event(E2, 'Delete me'))]);
    const mutation = await store.openMutationEditor({added: [event(E3)], updated: [{...store.snapshot().events[0], title: 'Updated'}], deleted: [store.snapshot().events[1]]}); sessions.push(mutation);
    boundary.beforeSave = () => boundary.external(eventDoc(event(E2, 'Remote replacement')));
    await expect(mutation.commit()).rejects.toThrow(/changed-underneath/);
    expect(boundary.docs.get(eventPath(E1))?.fields.title).toBe('Planning'); expect(boundary.docs.has(eventPath(E3))).toBe(false);
    expect(boundary.docs.get(eventPath(E2))?.fields.title).toBe('Remote replacement');
    expect(boundary.drafts.size).toBe(3); expect(boundary.queue).toEqual([]); expect(boundary.saves).toHaveLength(1); expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it('keeps the entire mutation draft set when one raw input fails validation', async () => {
    const {boundary, store} = await setup([eventDoc(), eventDoc(event(E2))]);
    const mutation = await store.openMutationEditor({added: [{...event(E3), start: 'partial timestamp'}], updated: [{...store.snapshot().events[0], title: 'Draft update'}], deleted: [store.snapshot().events[1]]}); sessions.push(mutation);
    await expect(mutation.commit()).rejects.toThrow(); expect(boundary.saves).toEqual([]); expect(boundary.drafts.size).toBe(3); expect(boundary.docs.size).toBe(2);
  });

  it('checks a removal revision again before Save and preserves replacement drafts', async () => {
    const {boundary, store} = await setup(); const mutation = await store.openMutationEditor({added: [], updated: [], deleted: [store.snapshot().events[0]]}); sessions.push(mutation);
    const competing = boundary.draft(eventPath(E1), {fields: {title: {value: 'Other tab draft', base: {value: 'Planning'}}}});
    await expect(mutation.commit()).rejects.toThrow(/removal draft changed/);
    expect(boundary.drafts.get(eventPath(E1))).toEqual(competing); expect(boundary.saves).toEqual([]);
  });

  it('does not draft a removal after Room reach disappears during its preflight read', async () => {
    const {boundary, store} = await setup(); const initial = store.snapshot().events[0];
    const delayed = gate(); let reading = false;
    boundary.beforeRead = async () => {boundary.beforeRead = undefined; reading = true; await delayed.promise;};
    const opening = store.openMutationEditor({added: [], updated: [], deleted: [initial]});
    await vi.waitFor(() => expect(reading).toBe(true));
    boundary.removeRoom(); delayed.release();
    await expect(opening).rejects.toThrow(/Room.*available|binding/i);
    expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]); expect(boundary.drafts.size).toBe(0);
  });

  it('rejects duplicate mutation identities and colliding new identities without writes', async () => {
    const {boundary, store} = await setup();
    await expect(store.openMutationEditor({added: [event()], updated: [store.snapshot().events[0]], deleted: []})).rejects.toThrow(/duplicate identities/);
    await expect(store.openMutationEditor({added: [event()], updated: [], deleted: []})).rejects.toThrow(/collides/);
    expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
  });

  it('never replaces an unfinished draft with a requested deletion', async () => {
    const {boundary, store} = await setup(); const held = boundary.draft(eventPath(E1), {fields: {title: {value: 'Unfinished', base: {value: 'Planning'}}}});
    await expect(store.openMutationEditor({added: [], updated: [], deleted: [store.snapshot().events[0]]})).rejects.toThrow(/unfinished/);
    expect(boundary.drafts.get(eventPath(E1))).toEqual(held); expect(boundary.writes).toEqual([]); expect(boundary.saves).toEqual([]);
  });

  it('closing a mutation editor retains its unsaved drafts and never queues implicitly', async () => {
    const {boundary, store} = await setup(); const mutation = await store.openMutationEditor({added: [event(E2)], updated: [{...store.snapshot().events[0], title: 'Pending'}], deleted: []}); sessions.push(mutation);
    mutation.close(); expect(boundary.drafts.size).toBe(2); expect(boundary.saves).toEqual([]); expect(boundary.docs.size).toBe(1);
  });
});
