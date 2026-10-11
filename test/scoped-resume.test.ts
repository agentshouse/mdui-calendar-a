import {afterEach, describe, expect, it, vi} from 'vitest';
import {HouseDataStore, type CalendarEvent, type MutationSession} from '../src/data/house';
import {Boundary, ROOM, E1, E2, E3, START, END, eventPath, event, eventDoc, gate, type Doc} from './house-boundary';

// Native RoomDraft persistence is the business-data boundary. Presentation may
// remember only which native paths belong to a scoped edit, never their values.
const E4 = '44444444-4444-4444-8444-444444444444';
const UID = 'weekly-planning';
const master: CalendarEvent = {...event(E1, 'Weekly planning'), rrule: {freq: 'WEEKLY'}, uid: UID};
const oldOverride: CalendarEvent = {...event(E2, 'Old exception'), rrule: null, uid: UID, recurrenceId: START};
const raw = {title: '', start: '2026-10-', end: '', description: '\n  unsaved native notes  \n', location: 'Room #'};
const stores: HouseDataStore[] = [];
const sessions: MutationSession[] = [];
type Change = Parameters<HouseDataStore['openMutationEditor']>[0];
const scopeKey = (scope = 'this') => `${UID}:${scope}:${scope === 'all' ? 'series' : START}`;
const pointerKey = (scope = 'this') => `${ROOM}:${scopeKey(scope)}`;
const pointer = (boundary: Boundary, scope = 'this') => (boundary.presentationValue.calendarScopedDrafts as Record<string, unknown>)?.[pointerKey(scope)];
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const current = (store: HouseDataStore, id: string) => store.snapshot().events.find(item => item.id === id)!;

async function setup(input: Boundary | Doc[] = [eventDoc(master), eventDoc(oldOverride)]) {
  const boundary = input instanceof Boundary ? input : new Boundary(input);
  const store = new HouseDataStore(async () => boundary.client()); stores.push(store);
  await store.start();
  return {boundary, store};
}

function thisChange(store: HouseDataStore, id = E3): Change {
  return {
    added: [{...event(id, 'Recomputed donor occurrence'), rrule: null, uid: UID, recurrenceId: START}],
    updated: [{...current(store, E1), exdates: [START]}],
    deleted: current(store, E2) ? [current(store, E2)] : [],
  };
}

async function open(store: HouseDataStore, change: Change, editableId: string, scope = 'this') {
  const session = await store.openMutationEditor(change, editableId, scopeKey(scope));
  sessions.push(session);
  expect(session.editor).toBeDefined();
  return session;
}

async function reload(boundary: Boundary, store: HouseDataStore, session: MutationSession) {
  session.close(); store.dispose();
  // A freshly deserialized Presentation object cannot retain closures or fields
  // accidentally attached by the old store or editor.
  boundary.presentationValue = copy(boundary.presentationValue);
  return (await setup(boundary)).store;
}

function assertUnchanged(boundary: Boundary, before: {drafts: Map<string, unknown>; writes: number; presentations: number; saves: number}) {
  expect(boundary.drafts).toEqual(before.drafts);
  expect(boundary.writes).toHaveLength(before.writes);
  expect(boundary.presentation.write).toHaveBeenCalledTimes(before.presentations);
  expect(boundary.saves).toHaveLength(before.saves);
  expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
}
const checkpoint = (boundary: Boundary) => ({drafts: new Map(boundary.drafts), writes: boundary.writes.length, presentations: boundary.presentation.write.mock.calls.length, saves: boundary.saves.length});

afterEach(() => {
  sessions.splice(0).forEach(session => session.close());
  stores.splice(0).forEach(store => store.dispose());
  vi.restoreAllMocks();
});

describe('scoped Calendar native-draft resumption', () => {
  it('hydrates actual raw This input after close and reload, using the held primary instead of a regenerated donor ID', async () => {
    const {boundary, store} = await setup();
    const first = await open(store, thisChange(store), E3);
    await first.editor!.write(raw);
    const before = checkpoint(boundary);
    const nextStore = await reload(boundary, store, first);
    const resumed = await open(nextStore, thisChange(nextStore, E4), E4);

    expect(resumed).toMatchObject({count: 3, removedCount: 1});
    expect(resumed.editor!.path).toBe(eventPath(E3));
    expect(resumed.editor!.value()).toMatchObject({...raw, id: E3, uid: UID, recurrenceId: START, rrule: null});
    expect(boundary.drafts.has(eventPath(E4))).toBe(false);
    expect(boundary.drafts.get(eventPath(E3))?.parts.creation).toMatchObject({type: 'calendar_event', fields: {...raw, id: E3}});
    assertUnchanged(boundary, before);
    await expect(resumed.commit()).rejects.toThrow();
    assertUnchanged(boundary, before);
  });

  it.each(['all', 'following'] as const)('preserves %s raw native fields and the whole held bundle instead of applying new donor defaults', async scope => {
    const {boundary, store} = await setup();
    const change: Change = scope === 'all'
      ? {added: [], updated: [{...current(store, E1), title: 'Donor All defaults'}], deleted: [current(store, E2)]}
      : {added: [{...event(E3, 'Donor following defaults'), uid: UID, rrule: {freq: 'WEEKLY'}}], updated: [{...current(store, E1), rrule: {freq: 'WEEKLY', until: START}}], deleted: [current(store, E2)]};
    const first = await open(store, change, scope === 'all' ? E1 : E3, scope);
    await first.editor!.write({...raw, rrule: {freq: 'MONTHLY', interval: 3}, exdates: [START], color: 'custom raw color', allDay: true});
    const before = checkpoint(boundary);
    const nextStore = await reload(boundary, store, first);
    const recomputed: Change = scope === 'all'
      ? {added: [], updated: [{...current(nextStore, E1), title: 'Changed donor title', rrule: {freq: 'DAILY'}}], deleted: []}
      : {added: [{...event(E4, 'Different fresh defaults'), uid: UID, rrule: {freq: 'DAILY'}}], updated: [{...current(nextStore, E1), title: 'New donor master default'}], deleted: []};
    const resumed = await open(nextStore, recomputed, scope === 'all' ? E1 : E4, scope);

    expect(resumed).toMatchObject({count: scope === 'all' ? 2 : 3, removedCount: 1});
    expect(resumed.editor!.path).toBe(eventPath(scope === 'all' ? E1 : E3));
    expect(resumed.editor!.value()).toMatchObject({...raw, rrule: {freq: 'MONTHLY', interval: 3}, exdates: [START], color: 'custom raw color', allDay: true});
    expect(boundary.drafts.has(eventPath(E4))).toBe(false);
    assertUnchanged(boundary, before);
  });

  it('puts clean included existing events in the scoped native bundle using only an updatedAt change', async () => {
    const {boundary, store} = await setup();
    const first = await open(store, {added: [], updated: [current(store, E1), current(store, E2)], deleted: []}, E1, 'all');
    expect(first).toMatchObject({count: 2, removedCount: 0});
    for (const id of [E1, E2]) {
      const native = boundary.drafts.get(eventPath(id));
      expect(native).toBeDefined();
      expect(Object.keys(native!.parts)).toEqual(['fields']);
      expect(Object.keys(native!.parts.fields!)).toEqual(['updatedAt']);
      expect(native!.parts.fields!.updatedAt).toEqual({base: {value: current(store, id).updatedAt}, value: expect.any(String)});
    }
    expect(pointer(boundary, 'all')).toEqual({paths: [eventPath(E1), eventPath(E2)], editablePath: eventPath(E1)});
    const before = checkpoint(boundary);
    const nextStore = await reload(boundary, store, first);
    const resumed = await open(nextStore, {added: [], updated: [current(nextStore, E1)], deleted: []}, E1, 'all');
    expect(resumed.count).toBe(2);
    assertUnchanged(boundary, before);
  });

  it('resumes a removal with its exact original base and saves the corrected bundle in one native selection', async () => {
    const {boundary, store} = await setup();
    const first = await open(store, thisChange(store), E3);
    await first.editor!.write(raw);
    const heldRemoval = copy(boundary.drafts.get(eventPath(E2))!);
    const nextStore = await reload(boundary, store, first);
    const resumed = await open(nextStore, {...thisChange(nextStore, E4), deleted: []}, E4);
    expect(resumed.removedCount).toBe(1);
    expect(boundary.drafts.get(eventPath(E2))).toEqual(heldRemoval);
    await resumed.editor!.write({title: 'Finished native occurrence', start: START, end: END});
    const selected = [E1, E3, E2].map(id => boundary.drafts.get(eventPath(id))!);
    await resumed.commit();
    expect(boundary.saves).toEqual([{room: ROOM, drafts: selected.map(({path, revision}) => ({path, revision}))}]);
    expect(boundary.queue).toEqual([{identifier: 'local-batch-1', room: ROOM, drafts: selected}]);
    expect(boundary.drafts.size).toBe(0);
    expect(boundary.docs.has(eventPath(E2))).toBe(false);
    expect(boundary.docs.has(eventPath(E4))).toBe(false);
    expect(boundary.docs.get(eventPath(E3))?.fields).toMatchObject({title: 'Finished native occurrence', description: raw.description, location: raw.location});
  });

  it.each([E1, E2, E3])('refuses a partially missing held bundle before any new writes or duplicate creation (missing %s)', async missing => {
    const {boundary, store} = await setup();
    const first = await open(store, thisChange(store), E3);
    await first.editor!.write(raw);
    boundary.drafts.delete(eventPath(missing));
    boundary.publish('room-drafts', [...boundary.drafts.values()]);
    const nextStore = await reload(boundary, store, first);
    const before = checkpoint(boundary);
    await expect(open(nextStore, thisChange(nextStore, E4), E4)).rejects.toThrow(/part.*saved or discarded/i);
    assertUnchanged(boundary, before);
    expect(boundary.drafts.has(eventPath(E4))).toBe(false);
  });

  it.each(['saved', 'discarded'] as const)('does not revive old raw input when every referenced native draft was %s', async outcome => {
    const {boundary, store} = await setup();
    const first = await open(store, {added: [], updated: [current(store, E1)], deleted: []}, E1, 'all');
    await first.editor!.write({...raw, title: 'Old retained raw title'});
    if (outcome === 'saved') {
      await first.editor!.write({title: 'Saved title', start: START, end: END, description: 'Saved notes', location: 'Saved room'});
      await first.commit();
    } else {
      boundary.drafts.clear();
      boundary.publish('room-drafts', []);
    }
    expect(boundary.drafts.size).toBe(0);
    const nextStore = await reload(boundary, store, first);
    const fresh = await open(nextStore, {added: [], updated: [current(nextStore, E1)], deleted: []}, E1, 'all');
    expect(fresh.editor!.value()).toMatchObject({title: outcome === 'saved' ? 'Saved title' : master.title, start: START, end: END});
    expect(fresh.editor!.value().description).toBe(outcome === 'saved' ? 'Saved notes' : undefined);
    expect(JSON.stringify([...boundary.drafts.values()])).not.toContain('Old retained raw title');
    expect(JSON.stringify([...boundary.drafts.values()])).not.toContain(raw.description.trim());
  });

  it('never restores off-Room raw drafts after actual Discovery removal and a newly reached Room', async () => {
    const {boundary, store} = await setup();
    const first = await open(store, thisChange(store), E3);
    await first.editor!.write(raw);
    const heldPointer = copy(pointer(boundary));
    const writes = boundary.writes.length;
    boundary.removeRoom();
    expect(store.snapshot().events).toEqual([]);
    expect(first.editor!.value()).toEqual({});
    await expect(first.editor!.write({title: 'Off-Room typing'})).rejects.toThrow();
    await expect(first.commit()).rejects.toThrow();
    await expect(open(store, thisChange(store, E4), E4)).rejects.toThrow();
    expect(boundary.writes).toHaveLength(writes);
    expect(boundary.drafts.size).toBe(0);
    expect(pointer(boundary)).toEqual(heldPointer);
    first.close(); store.dispose();

    boundary.roomValues = [{locator: ROOM, name: 'Calendar reached again'}];
    boundary.external(eventDoc({...master, title: 'Fresh reached master'}));
    const nextStore = (await setup(boundary)).store;
    const fresh = await open(nextStore, thisChange(nextStore, E4), E4);
    expect(fresh.editor!.path).toBe(eventPath(E4));
    expect(fresh.editor!.value()).toMatchObject({title: 'Recomputed donor occurrence', start: START, end: END});
    expect(fresh.editor!.value().description).toBeUndefined();
    expect(boundary.drafts.has(eventPath(E3))).toBe(false);
    expect(boundary.saves).toEqual([]);
  });

  it('serializes only native path references and preserves unrelated Presentation state', async () => {
    const {boundary, store} = await setup();
    boundary.presentationValue = {view: 'week', calendarScopedDrafts: {'another-scope': {paths: ['events/unrelated.md'], editablePath: 'events/unrelated.md'}}};
    const first = await open(store, thisChange(store), E3);
    await first.editor!.write(raw);
    expect(boundary.presentationValue).toEqual({
      view: 'week',
      calendarScopedDrafts: {
        'another-scope': {paths: ['events/unrelated.md'], editablePath: 'events/unrelated.md'},
        [pointerKey()]: {paths: [eventPath(E1), eventPath(E3), eventPath(E2)], editablePath: eventPath(E3)},
      },
    });
    const encoded = JSON.stringify(boundary.presentationValue);
    for (const businessContent of [raw.description.trim(), raw.location, master.title, 'Recomputed donor occurrence', 'creation', 'fields', 'revision', 'updatedAt', 'recurrenceId']) expect(encoded).not.toContain(businessContent);
    expect(boundary.presentation.write).toHaveBeenCalledOnce();
    expect(boundary.saves).toEqual([]);
  });

  it.each([
    ['string', eventPath(E3)],
    ['null', null],
    ['false', false],
    ['array', []],
    ['empty paths', {paths: [], editablePath: eventPath(E3)}],
    ['non-array paths', {paths: eventPath(E3), editablePath: eventPath(E3)}],
    ['duplicate paths', {paths: [eventPath(E3), eventPath(E3)], editablePath: eventPath(E3)}],
    ['foreign path', {paths: ['other-room/event.md'], editablePath: 'other-room/event.md'}],
    ['escaping path', {paths: ['events/../secret.md'], editablePath: 'events/../secret.md'}],
    ['missing editable path', {paths: [eventPath(E3)]}],
    ['unlisted editable path', {paths: [eventPath(E3)], editablePath: eventPath(E1)}],
    ['business payload', {paths: [eventPath(E3)], editablePath: eventPath(E3), title: 'Off-Room business payload'}],
  ])('rejects a malformed %s pointer before touching any native draft', async (_name, malformed) => {
    const {boundary, store} = await setup();
    boundary.presentationValue = {calendarScopedDrafts: {[pointerKey()]: malformed}};
    const before = checkpoint(boundary);
    await expect(open(store, thisChange(store), E3)).rejects.toThrow(/pointer.*invalid/i);
    assertUnchanged(boundary, before);
    expect(boundary.queue).toEqual([]);
  });

  it.each(['saved', 'discarded'] as const)('refuses scoped session commit if an included native draft was %s elsewhere', async outcome => {
    const {boundary, store} = await setup();
    const first = await open(store, {added: [], updated: [current(store, E1), current(store, E2)], deleted: []}, E1, 'all');
    await first.editor!.write({title: 'Scoped title'});
    const other = boundary.drafts.get(eventPath(E2))!;
    if (outcome === 'saved') await boundary.save(ROOM, [{path: other.path, revision: other.revision}]);
    else {boundary.drafts.delete(other.path); boundary.publish('room-drafts', [...boundary.drafts.values()]);}
    const before = checkpoint(boundary);
    await expect(first.commit()).rejects.toThrow(/part.*saved or discarded/i);
    assertUnchanged(boundary, before);
    expect(boundary.drafts.get(eventPath(E1))?.parts.fields?.title.value).toBe('Scoped title');
  });

  it('shares one deterministic This creation when another store opens before the first Presentation write', async () => {
    const {boundary, store} = await setup();
    const {store: other} = await setup(boundary);
    const delayed = gate();
    const reached = gate();
    const writePresentation = boundary.presentation.write.getMockImplementation()!;
    let blocked = false;
    boundary.presentation.write.mockImplementation(async value => {
      if (!blocked) {blocked = true; reached.release(); await delayed.promise;}
      await writePresentation(value);
    });
    const firstOpening = open(store, {...thisChange(store), deleted: []}, E3);
    await reached.promise;
    expect(pointer(boundary)).toBeUndefined();
    const held = boundary.drafts.get(eventPath(E3))!;
    const creation = held.parts.creation!;
    if (!('fields' in creation)) throw new Error('Expected native typed creation');
    // Simulate native raw typing while the first opener's pointer write is in
    // flight; the second store must discover the business draft independently.
    await boundary.roomDraft.write(ROOM, held.path, held.revision, {
      ...held.parts, creation: {...creation, fields: {...creation.fields, ...raw}, sections: {Notes: 'Native creation notes'}},
    });
    const before = checkpoint(boundary);
    try {
      const second = await open(other, {...thisChange(other), deleted: []}, E3);
      expect(second.editor!.path).toBe(eventPath(E3));
      expect(second.editor!.value()).toMatchObject(raw);
      expect(boundary.writes).toHaveLength(before.writes);
      expect(boundary.drafts).toEqual(before.drafts);
      expect([...boundary.drafts.values()].filter(draft => draft.parts.creation)).toHaveLength(1);
      delayed.release();
      const first = await firstOpening;
      expect(first.editor!.value()).toMatchObject(raw);
      expect(first.count).toBe(2); expect(second.count).toBe(2);
      expect(pointer(boundary)).toEqual({paths: [eventPath(E1), eventPath(E3)], editablePath: eventPath(E3)});
      expect(boundary.drafts.get(eventPath(E3))?.parts.creation).toMatchObject({sections: {Notes: 'Native creation notes'}});
      expect(boundary.saves).toEqual([]);
    } finally {delayed.release(); await firstOpening;}
  });

  it('does not overwrite newer raw creation fields when simultaneous deterministic This openers lose creation CAS', async () => {
    const {boundary, store} = await setup();
    const {store: other} = await setup(boundary);
    const delayed = gate();
    const reached = gate();
    const writeNative = boundary.roomDraft.write.getMockImplementation()!;
    let blocked = false;
    boundary.roomDraft.write.mockImplementation(async (room, path, revision, parts) => {
      if (!blocked && path === eventPath(E3) && revision === null) {
        blocked = true; reached.release(); await delayed.promise;
      }
      return writeNative(room, path, revision, parts);
    });
    const firstOpening = open(store, {...thisChange(store), deleted: []}, E3);
    await reached.promise;
    expect(pointer(boundary)).toBeUndefined();
    expect(boundary.drafts.has(eventPath(E3))).toBe(false);
    try {
      const second = await open(other, {...thisChange(other), deleted: []}, E3);
      await second.editor!.write(raw);
      const held = copy(boundary.drafts.get(eventPath(E3))!);
      const writes = boundary.writes.length;
      delayed.release();
      const first = await firstOpening;
      expect(boundary.writes).toHaveLength(writes + 1);
      expect(boundary.writes.at(-1)).toMatchObject({path: eventPath(E3), revision: null});
      expect(boundary.drafts.get(eventPath(E3))).toEqual(held);
      expect(first.editor!.value()).toMatchObject(raw);
      expect(second.editor!.value()).toMatchObject(raw);
      expect([...boundary.drafts.values()].filter(draft => draft.parts.creation)).toHaveLength(1);
      expect([...boundary.drafts.keys()].sort()).toEqual([eventPath(E1), eventPath(E3)].sort());
      expect(pointer(boundary)).toEqual({paths: [eventPath(E1), eventPath(E3)], editablePath: eventPath(E3)});
      expect(boundary.saves).toEqual([]); expect(boundary.queue).toEqual([]);
    } finally {delayed.release(); await firstOpening;}
  });

  it('keeps an existing native title, sections, and first bases when the donor proposes the original visible fields', async () => {
    const {boundary, store} = await setup();
    const held = boundary.draft(eventPath(E1), {
      fields: {
        title: {value: '', base: {value: 'First title seen before a remote edit'}},
        location: {value: 'Native unfinished room', base: {value: 'First room seen'}},
      },
      sections: {Notes: {value: '\nNative section with spacing\n', base: 'Original section'}},
      preamble: {value: 'Native preamble', base: 'Original preamble'},
    });
    const first = await open(store, {added: [], updated: [current(store, E1)], deleted: []}, E1, 'all');
    expect(first.editor!.value()).toMatchObject({title: '', location: 'Native unfinished room'});
    expect(boundary.drafts.get(eventPath(E1))).toEqual(held);
    expect(boundary.writes).toEqual([]);
    await first.editor!.write({title: 'Continued native title'});
    expect(boundary.drafts.get(eventPath(E1))?.parts).toMatchObject({
      ...held.parts,
      fields: {...held.parts.fields, title: {value: 'Continued native title', base: {value: 'First title seen before a remote edit'}}},
    });
    expect(boundary.saves).toEqual([]);
  });

  it.each(['stale', 'model-validation'] as const)('retains newer raw input across a scoped Save %s refusal', async rule => {
    const {boundary, store} = await setup();
    const first = await open(store, thisChange(store), E3);
    const {store: other} = await setup(boundary);
    const second = await open(other, thisChange(other, E4), E4);
    const selected = [E1, E3, E2].map(id => boundary.drafts.get(eventPath(id))!);
    const docs = new Map(boundary.docs);
    const heldPointer = copy(pointer(boundary));
    const delayed = gate(); boundary.saveGate = delayed.promise;
    if (rule !== 'stale') boundary.nextSaveRule = rule;
    const saving = first.commit();
    const refused = expect(saving).rejects.toThrow(rule);
    try {
      await vi.waitFor(() => expect(boundary.saves).toHaveLength(1));
      expect(store.snapshot().busy).toBe(true);
      await second.editor!.write(raw);
      const held = checkpoint(boundary);
      expect(boundary.drafts.get(eventPath(E3))?.revision).not.toBe(selected[1].revision);
      delayed.release(); await refused;
      expect(boundary.saves).toEqual([{room: ROOM, drafts: selected.map(({path, revision}) => ({path, revision}))}]);
      expect(boundary.docs).toEqual(docs); expect(boundary.queue).toEqual([]);
      expect(boundary.drafts).toEqual(held.drafts);
      expect(first.editor!.value()).toMatchObject(raw);
      expect(second.editor!.value()).toMatchObject(raw);
      expect(pointer(boundary)).toEqual(heldPointer);
      expect(store.snapshot().busy).toBe(false);
      const nextStore = await reload(boundary, store, first);
      const resumed = await open(nextStore, thisChange(nextStore, E4), E4);
      expect(resumed).toMatchObject({count: 3, removedCount: 1});
      expect(resumed.editor!.path).toBe(eventPath(E3));
      expect(resumed.editor!.value()).toMatchObject(raw);
      assertUnchanged(boundary, held);
    } finally {delayed.release(); await refused;}
  });

  it('resumes an opened existing document at its noncanonical native path in the same Room', async () => {
    const nativePath = 'calendar/imported/Weekly planning.md';
    const doc = {...eventDoc(master), path: nativePath};
    const {boundary, store} = await setup([doc]);
    const first = await open(store, {added: [], updated: [current(store, E1)], deleted: []}, E1, 'all');
    await first.editor!.write(raw);
    expect(first.editor!.path).toBe(nativePath);
    expect(pointer(boundary, 'all')).toEqual({paths: [nativePath], editablePath: nativePath});
    const before = checkpoint(boundary);
    const nextStore = await reload(boundary, store, first);
    const resumed = await open(nextStore, {added: [], updated: [{...current(nextStore, E1), title: 'Fresh donor default'}], deleted: []}, E1, 'all');
    expect(resumed.editor!.path).toBe(nativePath);
    expect(resumed.editor!.value()).toMatchObject(raw);
    expect(boundary.drafts.has(eventPath(E1))).toBe(false);
    expect(boundary.roomDraft.read.mock.calls.every(([room]) => room === ROOM)).toBe(true);
    expect(boundary.writes.every(write => write.room === ROOM && write.path === nativePath)).toBe(true);
    assertUnchanged(boundary, before);
  });

});
