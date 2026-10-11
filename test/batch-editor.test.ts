import {afterEach, describe, expect, it, vi} from 'vitest';
import {HouseDataStore, type CalendarEvent, type MutationSession} from '../src/data/house';
import {Boundary, ROOM, E1, E2, E3, START, END, eventPath, event, eventDoc, type Doc} from './house-boundary';

const stores: HouseDataStore[] = [];
const sessions: MutationSession[] = [];
const master: CalendarEvent = {...event(E1, 'Weekly planning'), rrule: {freq: 'WEEKLY'}, uid: 'weekly-planning'};
const override: CalendarEvent = {...event(E3, 'Edited occurrence'), rrule: null, uid: master.uid, recurrenceId: START};

async function setup(docs: Doc[] = [eventDoc(master), eventDoc(event(E2, 'Old exception'))]) {
  const boundary = new Boundary(docs);
  const store = new HouseDataStore(async () => boundary.client()); stores.push(store);
  await store.start();
  return {boundary, store};
}

function bundle(store: HouseDataStore) {
  return {
    added: [override],
    updated: [{...store.snapshot().events.find(item => item.id === E1)!, exdates: [START]}],
    deleted: [store.snapshot().events.find(item => item.id === E2)!],
  };
}

async function openBundle(store: HouseDataStore, editableId = E3) {
  const mutation = await store.openMutationEditor(bundle(store), editableId);
  sessions.push(mutation);
  expect(mutation.editor).toBeDefined();
  return {mutation, editor: mutation.editor!};
}

const businessFields = (fields: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'updatedAt'));

afterEach(() => {
  sessions.splice(0).forEach(session => session.close());
  stores.splice(0).forEach(store => store.dispose());
  vi.restoreAllMocks();
});

describe('editable event in an atomic Calendar mutation', () => {
  it('exposes the actual new-override editor and persists each raw input only on its native draft', async () => {
    const {boundary, store} = await setup();
    const {mutation, editor} = await openBundle(store);
    expect(mutation.count).toBe(3);
    expect(editor.path).toBe(eventPath(E3));
    expect(editor.value()).toMatchObject({id: E3, title: override.title, start: START, end: END, recurrenceId: START, rrule: null, uid: master.uid});
    expect(await editor.selection()).toEqual({path: eventPath(E3), revision: boundary.drafts.get(eventPath(E3))!.revision});
    const masterDraft = boundary.drafts.get(eventPath(E1));
    const removalDraft = boundary.drafts.get(eventPath(E2));
    const redraw = vi.fn(); editor.subscribe(redraw);

    for (const [field, value] of [
      ['title', ''], ['title', 'O'], ['title', 'Occurrence'],
      ['start', '2026-10-'], ['end', ''],
      ['description', '\n  raw notes  \n'], ['location', 'Room #'],
    ] as const) {
      const before = businessFields(editor.value());
      const writes = boundary.writes.length;
      await editor.write({[field]: value});
      expect(boundary.writes).toHaveLength(writes + 1);
      expect(boundary.writes.at(-1)).toMatchObject({room: ROOM, path: eventPath(E3)});
      expect(boundary.drafts.get(eventPath(E3))?.parts.creation).toMatchObject({type: 'calendar_event', fields: {...before, [field]: value}});
      expect(businessFields(editor.value())).toEqual({...before, [field]: value});
      expect(redraw).toHaveBeenLastCalledWith(expect.objectContaining({id: E3, [field]: value}));
      expect(boundary.drafts.get(eventPath(E1))).toEqual(masterDraft);
      expect(boundary.drafts.get(eventPath(E2))).toEqual(removalDraft);
      expect(boundary.saves).toEqual([]); expect(boundary.queue).toEqual([]);
    }
    expect(boundary.docs.has(eventPath(E3))).toBe(false);
    expect(boundary.docs.get(eventPath(E1))?.fields.exdates).toBeUndefined();
    expect(boundary.presentation.write).not.toHaveBeenCalled();
  });

  it('retains the complete bundle unchanged when a target has invalid partial input at commit', async () => {
    const {boundary, store} = await setup();
    const {mutation, editor} = await openBundle(store);
    await editor.write({title: '', start: '2026-10-12T09:', end: ''});
    const retained = new Map(boundary.drafts);
    const documents = new Map(boundary.docs);
    const writes = boundary.writes.length;

    await expect(mutation.commit()).rejects.toThrow();

    expect(editor.value()).toMatchObject({id: E3, title: '', start: '2026-10-12T09:', end: ''});
    expect(boundary.drafts).toEqual(retained); expect(boundary.drafts.size).toBe(3);
    expect(boundary.docs).toEqual(documents); expect(boundary.writes).toHaveLength(writes);
    expect(boundary.saves).toEqual([]); expect(boundary.queue).toEqual([]);
    expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it('saves the corrected form, master update, and removal together in one atomic selection', async () => {
    const {boundary, store} = await setup();
    const {mutation, editor} = await openBundle(store);
    await editor.write({title: '', start: 'partial', end: '', description: 'Keep these occurrence notes'});
    await expect(mutation.commit()).rejects.toThrow();
    await editor.write({title: 'Corrected occurrence', start: START, end: END});
    const selectedDrafts = [E1, E3, E2].map(id => boundary.drafts.get(eventPath(id))!);
    const selections = selectedDrafts.map(({path, revision}) => ({path, revision}));
    const documentsBeforeSave = new Map(boundary.docs);
    boundary.beforeSave = () => {
      expect(boundary.docs).toEqual(documentsBeforeSave);
      expect(boundary.drafts.size).toBe(3); expect(boundary.queue).toEqual([]);
    };

    await mutation.commit();

    expect(boundary.saves).toEqual([{room: ROOM, drafts: selections}]);
    expect(boundary.queue).toEqual([{identifier: 'local-batch-1', room: ROOM, drafts: selectedDrafts}]);
    expect(boundary.drafts.size).toBe(0);
    expect([...boundary.docs.keys()].sort()).toEqual([eventPath(E1), eventPath(E3)].sort());
    expect(boundary.docs.get(eventPath(E1))?.fields).toMatchObject({title: master.title, exdates: [START], rrule: master.rrule});
    expect(boundary.docs.get(eventPath(E3))?.fields).toMatchObject({id: E3, title: 'Corrected occurrence', start: START, end: END, description: 'Keep these occurrence notes', recurrenceId: START, uid: master.uid});
    expect(boundary.roomDraft.discard).not.toHaveBeenCalled();
  });

  it('rejects absent, deletion-only, and empty editable identities before staging any writes', async () => {
    const {boundary, store} = await setup();
    for (const editableId of ['missing-event', E2, '']) {
      await expect(store.openMutationEditor(bundle(store), editableId)).rejects.toThrow(/editable event.*not part/i);
      expect(boundary.writes).toEqual([]); expect(boundary.drafts.size).toBe(0);
      expect(boundary.saves).toEqual([]); expect(boundary.queue).toEqual([]);
      expect(boundary.presentation.write).not.toHaveBeenCalled();
    }
  });

  it('keeps disjoint fields, section edits, and their first bases when the existing target retries stale typing', async () => {
    const {boundary, store} = await setup();
    const path = eventPath(E1);
    boundary.draft(path, {
      fields: {title: {value: 'Earlier shared title', base: {value: master.title}}, location: {value: 'Shared room', base: null}},
      sections: {Notes: {value: 'Shared section', base: ''}},
      preamble: {value: 'Shared preamble', base: ''},
    });
    const {mutation, editor} = await openBundle(store, E1);
    expect(mutation.count).toBe(3); expect(editor.path).toBe(path);
    const overrideDraft = boundary.drafts.get(eventPath(E3));
    const removalDraft = boundary.drafts.get(eventPath(E2));
    boundary.external(eventDoc({...master, title: 'New visible title'}));
    boundary.beforeWrite = writtenPath => {
      boundary.beforeWrite = undefined;
      expect(writtenPath).toBe(path);
      const current = boundary.drafts.get(path)!;
      boundary.draft(path, {...current.parts, fields: {...current.parts.fields, description: {value: 'Concurrent disjoint notes', base: null}}});
    };
    const writes = boundary.writes.length;

    await editor.write({title: 'Latest typed title'});

    expect(boundary.writes).toHaveLength(writes + 2);
    expect(boundary.writes.slice(writes).map(write => write.path)).toEqual([path, path]);
    expect(boundary.writes[writes + 1].revision).not.toBe(boundary.writes[writes].revision);
    expect(boundary.drafts.get(path)?.parts).toMatchObject({
      fields: {
        title: {value: 'Latest typed title', base: {value: master.title}},
        location: {value: 'Shared room', base: null},
        description: {value: 'Concurrent disjoint notes', base: null},
        exdates: {value: [START], base: null},
      },
      sections: {Notes: {value: 'Shared section', base: ''}},
      preamble: {value: 'Shared preamble', base: ''},
    });
    expect(editor.value()).toMatchObject({id: E1, title: 'Latest typed title', location: 'Shared room', description: 'Concurrent disjoint notes'});
    expect(boundary.drafts.get(eventPath(E3))).toEqual(overrideDraft);
    expect(boundary.drafts.get(eventPath(E2))).toEqual(removalDraft);
    expect(boundary.saves).toEqual([]); expect(boundary.queue).toEqual([]);
  });
});
