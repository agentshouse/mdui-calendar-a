import {afterEach, describe, expect, it, vi} from 'vitest';
import {HouseDataStore, type CalendarEvent, type MutationSession} from '../src/data/house';
import {Boundary, ROOM, E1, E3, START, eventPath, event, eventDoc, gate} from './house-boundary';

const UID = 'shared-weekly-series';
const FOLLOWING_ID = `${E1}_following`;
const FIRST = '2026-10-19T09:00:00.000Z';
const SECOND = '2026-10-26T09:00:00.000Z';
const firstUntil = '2026-10-18T23:59:59.999Z';
const secondUntil = '2026-10-25T23:59:59.999Z';
const master: CalendarEvent = {...event(E1, 'Shared weekly meeting'), uid: UID, rrule: {freq: 'WEEKLY', dtstart: START}};
const stores: HouseDataStore[] = [];
const sessions: MutationSession[] = [];
type Change = Parameters<HouseDataStore['openMutationEditor']>[0];
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const current = (store: HouseDataStore) => store.snapshot().events.find(item => item.id === E1)!;

async function setup(boundary = new Boundary([eventDoc(master)])) {
  const store = new HouseDataStore(async () => boundary.client());
  stores.push(store);
  await store.start();
  return {boundary, store};
}

function following(store: HouseDataStore, start = FIRST): Change {
  const until = start === FIRST ? firstUntil : secondUntil;
  return {
    updated: [{...current(store), rrule: {...master.rrule, until}, exdates: []}],
    added: [{...event(FOLLOWING_ID, `Following from ${start}`), start,
      end: start.replace('09:00', '10:00'), uid: `${FOLLOWING_ID}@ilamy.calendar`,
      rrule: {...master.rrule, dtstart: start}, recurrenceId: null, exdates: []}],
    deleted: [],
  };
}

async function openFollowing(store: HouseDataStore, start = FIRST) {
  const session = await store.openMutationEditor(following(store, start), FOLLOWING_ID, `${UID}:following:${start}`);
  sessions.push(session);
  return session;
}

afterEach(() => {
  sessions.splice(0).forEach(session => session.close());
  stores.splice(0).forEach(store => store.dispose());
  vi.restoreAllMocks();
});

describe('overlapping scoped Calendar mutations', () => {
  it('refuses a different Following cutoff before touching the already staged bundle', async () => {
    const {boundary, store} = await setup();
    const first = await openFollowing(store);
    await first.editor!.write({title: '', start: '2026-10-', description: 'Keep native A input'});
    const held = new Map(boundary.drafts);
    const presentation = copy(boundary.presentationValue);
    const writes = boundary.writes.length;

    await expect(openFollowing(store, SECOND)).rejects.toThrow();

    expect(boundary.drafts).toEqual(held);
    expect(boundary.writes).toHaveLength(writes);
    expect(boundary.presentationValue).toEqual(presentation);
    expect(first.editor!.value()).toMatchObject({title: '', start: '2026-10-', description: 'Keep native A input'});
    expect(boundary.drafts.get(eventPath(E1))?.parts.fields?.rrule.value).toMatchObject({until: firstUntil});
    expect(boundary.saves).toEqual([]);
    expect(boundary.queue).toEqual([]);
  });

  it('refuses a conflicting native master before the first scope publishes its path references', async () => {
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
    const firstOpening = openFollowing(store);
    await reached.promise;
    expect(boundary.presentationValue.calendarScopedDrafts).toBeUndefined();
    const held = new Map(boundary.drafts);
    const writes = boundary.writes.length;
    try {
      await expect(openFollowing(other, SECOND)).rejects.toThrow();
      expect(boundary.drafts).toEqual(held);
      expect(boundary.writes).toHaveLength(writes);
      expect(boundary.saves).toEqual([]);
      expect(boundary.queue).toEqual([]);
    } finally {
      delayed.release();
      await firstOpening;
    }
  });

  it('does not overwrite the winning cutoff when a competing master write loses native CAS', async () => {
    const {boundary, store} = await setup();
    const {store: other} = await setup(boundary);
    const delayed = gate();
    const reached = gate();
    const writeNative = boundary.roomDraft.write.getMockImplementation()!;
    let blocked = false;
    boundary.roomDraft.write.mockImplementation(async (room, path, revision, parts) => {
      if (!blocked && path === eventPath(E1) && revision === null) {
        blocked = true; reached.release(); await delayed.promise;
      }
      return writeNative(room, path, revision, parts);
    });
    const firstOpening = openFollowing(store).then(session => ({session}), error => ({error}));
    await reached.promise;
    try {
      const winner = await openFollowing(other, SECOND);
      const held = new Map(boundary.drafts);
      const presentation = copy(boundary.presentationValue);
      delayed.release();
      const first = await firstOpening;
      expect(first).toHaveProperty('error');
      expect(boundary.drafts).toEqual(held);
      expect(boundary.presentationValue).toEqual(presentation);
      expect(winner.editor!.value()).toMatchObject({start: SECOND, rrule: {dtstart: SECOND}});
      expect(boundary.drafts.get(eventPath(E1))?.parts.fields?.rrule.value).toMatchObject({until: secondUntil});
      expect(boundary.saves).toEqual([]);
      expect(boundary.queue).toEqual([]);
    } finally {
      delayed.release();
      await firstOpening;
    }
  });

  it('refuses a prepointer All scope when its visible no-op EXDATE would borrow a pending This exclusion', async () => {
    const {boundary, store} = await setup(new Boundary([eventDoc({...master, exdates: []})]));
    const {store: other} = await setup(boundary);
    const delayed = gate();
    const reached = gate();
    const writePresentation = boundary.presentation.write.getMockImplementation()!;
    let blocked = false;
    boundary.presentation.write.mockImplementation(async value => {
      if (!blocked) {blocked = true; reached.release(); await delayed.promise;}
      await writePresentation(value);
    });
    const firstOpening = store.openMutationEditor({
      updated: [{...current(store), exdates: [FIRST]}],
      added: [{...event(E3, 'Pending This occurrence'), uid: UID, recurrenceId: FIRST, rrule: null}],
      deleted: [],
    }, E3, `${UID}:this:${FIRST}`).then(session => {sessions.push(session); return session;});
    await reached.promise;
    expect(boundary.presentationValue.calendarScopedDrafts).toBeUndefined();
    const held = new Map(boundary.drafts);
    const writes = boundary.writes.length;
    try {
      const opening = other.openMutationEditor({updated: [{...current(other), exdates: []}], added: [], deleted: []}, E1, `${UID}:all:series`)
        .then(session => {sessions.push(session); return session;});
      await expect(opening).rejects.toThrow();
      expect(boundary.drafts).toEqual(held);
      expect(boundary.writes).toHaveLength(writes);
      expect(boundary.saves).toEqual([]);
      expect(boundary.queue).toEqual([]);
    } finally {
      delayed.release();
      await firstOpening;
    }
  });

  it('does not apply new-creation defaults when the same scoped occurrence is saved during opening', async () => {
    const {boundary, store} = await setup();
    const {store: other} = await setup(boundary);
    const delayed = gate();
    const reached = gate();
    let blocked = false;
    boundary.beforeRead = async path => {
      if (!blocked && path === eventPath(FOLLOWING_ID)) {
        blocked = true; reached.release(); await delayed.promise;
      }
    };
    const firstOpening = openFollowing(store).then(session => ({session}), error => ({error}));
    await reached.promise;
    try {
      const winner = await openFollowing(other);
      await winner.editor!.write({title: 'Saved by the other tab', description: 'Keep saved native content'});
      await winner.commit();
      const documents = new Map(boundary.docs);
      const writes = boundary.writes.length;
      const saves = boundary.saves.length;
      expect(boundary.drafts.size).toBe(0);
      delayed.release();
      const first = await firstOpening;
      expect(first).toHaveProperty('error');
      expect(boundary.docs).toEqual(documents);
      expect(boundary.drafts.size).toBe(0);
      expect(boundary.writes).toHaveLength(writes);
      expect(boundary.saves).toHaveLength(saves);
      expect(boundary.docs.get(eventPath(FOLLOWING_ID))?.fields).toMatchObject({title: 'Saved by the other tab', description: 'Keep saved native content'});
    } finally {
      delayed.release();
      await firstOpening;
    }
  });

  it.each(['following', 'this'] as const)('refuses %s Save after another native edit changes its related master recurrence metadata', async scope => {
    const {boundary, store} = await setup();
    let session: MutationSession;
    if (scope === 'following') session = await openFollowing(store);
    else {
      session = await store.openMutationEditor({
        updated: [{...current(store), exdates: [FIRST]}],
        added: [{...event(E3, 'Detached occurrence'), uid: UID, recurrenceId: FIRST, rrule: null}],
        deleted: [],
      }, E3, `${UID}:this:${FIRST}`);
      sessions.push(session);
    }
    const heldMaster = boundary.drafts.get(eventPath(E1))!;
    const field = scope === 'following' ? 'rrule' : 'exdates';
    const value = scope === 'following' ? {...master.rrule, until: secondUntil} : [SECOND];
    boundary.draft(heldMaster.path, {...heldMaster.parts, fields: {
      ...heldMaster.parts.fields,
      [field]: {...heldMaster.parts.fields![field], value},
    }});
    const held = new Map(boundary.drafts);
    const writes = boundary.writes.length;

    await expect(session.commit()).rejects.toThrow();

    expect(boundary.drafts).toEqual(held);
    expect(boundary.writes).toHaveLength(writes);
    expect(boundary.saves).toEqual([]);
    expect(boundary.queue).toEqual([]);
    expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });
});
