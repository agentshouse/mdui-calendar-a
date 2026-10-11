import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import type { CalendarEvent as DonorEvent, IlamyCalendar } from '@ilamy/calendar';
import dayjs from '@ilamy/utils/dayjs';
import { Weekday } from '@ilamy/calendar-recurrence';
import type { CalendarEvent, EditorSession, MutationSession } from '../src/data/house';

const harness = vi.hoisted(() => ({
  latest: undefined as unknown,
  clicked: undefined as unknown,
  snapshot: { events: [] as unknown[], loading: false, error: null as string | null, status: '', halted: false, busy: false, version: 0 },
  listeners: new Set<() => void>(),
  openEditor: vi.fn(), openMutationEditor: vi.fn(), start: vi.fn(async () => {}),
}));
vi.mock('../src/data/house', () => ({ dataStore: {
  snapshot: () => harness.snapshot,
  subscribe: (listener: () => void) => {harness.listeners.add(listener); return () => harness.listeners.delete(listener);},
  start: harness.start, openEditor: harness.openEditor, openMutationEditor: harness.openMutationEditor,
} }));
vi.mock('@ilamy/calendar', async importOriginal => {
  const actual = await importOriginal<typeof import('@ilamy/calendar')>();
  return { ...actual, useIlamyCalendarContext: () => ({t: (key: keyof typeof actual.defaultTranslations) => actual.defaultTranslations[key]}), IlamyCalendar: function TestCalendar(props: ComponentProps<typeof IlamyCalendar>) {
    harness.latest = props;
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<DonorEvent | null>(null);
    const [view, setView] = useState('month');
    return <div><button onClick={() => {setSelected(null); setOpen(true);}}>Test New</button>
      <button onClick={() => {setSelected(harness.clicked as DonorEvent); setOpen(true);}}>Test Edit</button>
      <button onClick={() => setView('week')}>Test Week</button><span data-testid="test-view">{view}</span>
      {props.renderEventForm?.({open, selectedEvent: selected, onClose: () => setOpen(false)})}
    </div>;
  } };
});
import App, { REFERENCE_DATE, toDonorEvent, toRoomEvent } from '../src/App';

const row = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: 'event-1', title: 'Planning', start: '2026-10-11T09:00:00.000Z', end: '2026-10-11T10:00:00.000Z', createdAt: REFERENCE_DATE, updatedAt: REFERENCE_DATE, ...patch });
function draft(initial: Record<string, unknown> = {}) {
  let fields = { ...initial };
  const listeners = new Set<(fields: Record<string, unknown>) => void>();
  const write = vi.fn(async (patch: Record<string, unknown>) => {fields = {...fields, ...patch}; listeners.forEach(listener => listener(fields));});
  const session = {
    path: 'events/event-1.md', value: () => fields, write, writeExisting: vi.fn(async (patch: Record<string, unknown>) => {await write(patch);}),
    subscribe: (listener: (fields: Record<string, unknown>) => void) => {listeners.add(listener); return () => listeners.delete(listener);},
    error: () => undefined, close: vi.fn(), commit: vi.fn(async () => {}), selection: vi.fn(async (): Promise<{path: string; revision: string} | null> => ({path: 'events/event-1.md', revision: 'draft-1'})),
  } satisfies EditorSession;
  return session;
}
function notify(patch: Partial<typeof harness.snapshot>) {harness.snapshot = {...harness.snapshot, ...patch}; harness.listeners.forEach(listener => listener());}
const latest = () => harness.latest as ComponentProps<typeof IlamyCalendar>;
beforeEach(() => {
  dayjs.tz.setDefault('UTC');
  harness.snapshot = { events: [], loading: false, error: null, status: '', halted: false, busy: false, version: 0 };
  harness.listeners.clear(); harness.openEditor.mockReset(); harness.openMutationEditor.mockReset(); harness.start.mockClear(); harness.clicked = undefined;
});
afterEach(() => {cleanup(); dayjs.tz.setDefault();});

describe('Room-backed Calendar form', () => {
  it('sends every partial keystroke to the draft, keeps Close separate from Save, and resumes raw input', async () => {
    const session = draft({title: '', start: '', end: ''}); harness.openEditor.mockResolvedValue(session);
    render(<App />); fireEvent.click(screen.getByText('Test New'));
    const title = await screen.findByLabelText('Title');
    for (const value of ['D', 'Dr', 'Draft']) fireEvent.change(title, {target: {value}});
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-'}});
    await waitFor(() => expect(session.write).toHaveBeenCalledWith({start: '2026-10-'}));
    expect(session.value().title).toBe('Draft'); expect(session.value().start).toBe('2026-10-');
    fireEvent.click(screen.getAllByRole('button', {name: 'Close'})[0]);
    expect(session.commit).not.toHaveBeenCalled(); await waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Test New'));
    expect((await screen.findByLabelText('Title') as HTMLInputElement).value).toBe('Draft');
    expect((screen.getByLabelText('Start · ISO date and time') as HTMLInputElement).value).toBe('2026-10-');
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(session.commit).toHaveBeenCalledTimes(1));
  });
  it('closes a late async editor safely after the dialog was dismissed', async () => {
    let resolve!: (session: EditorSession) => void;
    harness.openEditor.mockImplementation(() => new Promise<EditorSession>(done => {resolve = done;}));
    render(<App />); fireEvent.click(screen.getByText('Test New'));
    expect(await screen.findByText('Opening Room draft…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Close'}));
    const session = draft(); await act(async () => resolve(session));
    expect(session.close).toHaveBeenCalledTimes(1); expect(session.commit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });
  it('shows open and Save failures and leaves the editor available after failed Save', async () => {
    harness.openEditor.mockRejectedValueOnce(new Error('Draft source unavailable'));
    render(<App />); fireEvent.click(screen.getByText('Test New'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Draft source unavailable');
    fireEvent.click(screen.getByRole('button', {name: 'Close'}));
    const session = draft(row()); session.commit.mockRejectedValue(new Error('Draft changed; review it'));
    harness.openEditor.mockResolvedValue(session); fireEvent.click(screen.getByText('Test New'));
    fireEvent.click(await screen.findByRole('button', {name: 'Save event'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Draft changed; review it');
    expect(screen.getByLabelText('Title')).toBeTruthy(); expect(session.close).not.toHaveBeenCalled();
  });
  it('opens an ordinary stored event directly without a recurrence prompt', async () => {
    const event = row(); harness.snapshot.events = [event]; harness.clicked = toDonorEvent(event);
    const session = draft(event); harness.openEditor.mockResolvedValue(session);
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    expect(await screen.findByRole('heading', {name: 'Edit event'})).toBeTruthy();
    expect(harness.openEditor).toHaveBeenCalledWith(event, undefined);
    expect(harness.openMutationEditor).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Title'), {target: {value: 'Revised planning'}});
    expect(session.write).toHaveBeenCalledWith({title: 'Revised planning'});
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(session.commit).toHaveBeenCalledOnce());
  });
  it('preserves selected view through a live update and Save', async () => {
    const session = draft(row()); harness.openEditor.mockResolvedValue(session); render(<App />);
    fireEvent.click(screen.getByText('Test Week'));
    act(() => notify({events: [row({title: 'Remote change'})], version: 1}));
    expect(screen.getByTestId('test-view').textContent).toBe('week');
    fireEvent.click(screen.getByText('Test New')); fireEvent.click(await screen.findByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(session.commit).toHaveBeenCalled());
    act(() => notify({events: [row()], version: 2})); expect(screen.getByTestId('test-view').textContent).toBe('week');
  });
});

function recurringFixture() {
  const base = row({start: '2026-10-04T09:00:00.000Z', end: '2026-10-04T10:00:00.000Z', uid: 'series@ilamy.calendar',
    rrule: {freq: 2, dtstart: '2026-10-04T09:00:00.000Z', byweekday: [6]},
    exdates: ['2026-10-11T09:00:00.000Z', '2026-10-25T09:00:00.000Z']});
  const prior = row({id: 'override-prior', uid: base.uid, recurrenceId: '2026-10-11T09:00:00.000Z',
    start: '2026-10-11T11:00:00.000Z', end: '2026-10-11T12:00:00.000Z'});
  const future = row({id: 'override-future', uid: base.uid, recurrenceId: '2026-10-25T09:00:00.000Z',
    start: '2026-10-25T11:00:00.000Z', end: '2026-10-25T12:00:00.000Z'});
  const occurrence = toDonorEvent({...base, id: 'event-1_2', rrule: null,
    start: '2026-10-18T09:00:00.000Z', end: '2026-10-18T10:00:00.000Z'});
  harness.snapshot.events = [base, prior, future]; harness.clicked = occurrence;
  return {base, prior, future, occurrence};
}
function mutationDraft() {
  const result: {editor?: ReturnType<typeof draft>; batch?: MutationSession} = {};
  harness.openMutationEditor.mockImplementation(async (change: {added: CalendarEvent[]; updated: CalendarEvent[]; deleted: CalendarEvent[]}, id: string) => {
    const primary = [...change.added, ...change.updated].find(event => event.id === id)!;
    result.editor = draft(primary);
    result.batch = {editor: result.editor, removedCount: change.deleted.length, count: change.added.length + change.updated.length + change.deleted.length, close: vi.fn(), validate: vi.fn(async () => []), commit: vi.fn(async () => {})};
    return result.batch;
  });
  return result;
}

describe('recurring Room form edit scopes', () => {
  it('offers the unchanged donor scopes before creating any draft; Cancel does nothing', async () => {
    recurringFixture(); render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    expect(await screen.findByRole('heading', {name: 'Edit recurring event'})).toBeTruthy();
    expect(screen.getByRole('button', {name: /^This event /})).toBeTruthy();
    expect(screen.getByRole('button', {name: /^This and following events /})).toBeTruthy();
    expect(screen.getByRole('button', {name: /^All events /})).toBeTruthy();
    expect(harness.openEditor).not.toHaveBeenCalled(); expect(harness.openMutationEditor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
    expect(screen.queryByRole('heading', {name: 'Edit recurring event'})).toBeNull();
    expect(harness.openEditor).not.toHaveBeenCalled(); expect(harness.openMutationEditor).not.toHaveBeenCalled();
  });
  it('This event drafts a detached occurrence and master EXDATE and only explicitly saves the whole batch', async () => {
    const {base, occurrence} = recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^This event /}));
    const title = await screen.findByLabelText('Title');
    const [change, id] = harness.openMutationEditor.mock.calls[0];
    expect(change.updated).toHaveLength(1); expect(change.updated[0].id).toBe(base.id);
    expect(change.updated[0].exdates).toEqual([...base.exdates!, occurrence.start.toISOString()]);
    expect(change.added).toHaveLength(1); expect(id).toBe(change.added[0].id);
    expect(change.added[0].recurrenceId).toBe(occurrence.start.toISOString());
    expect(change.added[0].rrule).toBeNull(); expect(change.deleted).toEqual([]);
    expect((screen.getByLabelText('Start · ISO date and time') as HTMLInputElement).value).toBe(occurrence.start.toISOString());
    for (const value of ['S', 'Si', 'Single']) fireEvent.change(title, {target: {value}});
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-'}});
    expect(opened.editor!.write).toHaveBeenCalledWith({start: '2026-10-'});
    expect(opened.editor!.value().start).toBe('2026-10-');
    expect(opened.batch!.commit).not.toHaveBeenCalled(); expect(opened.editor!.commit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-18T09:30:00.000Z'}});
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(opened.batch!.commit).toHaveBeenCalledOnce());
    expect(opened.editor!.commit).not.toHaveBeenCalled(); expect(opened.batch!.close).toHaveBeenCalledOnce();
  });
  it('targets the same native This draft across concurrent openings and distinct drafts for distinct occurrences', async () => {
    const {occurrence} = recurringFixture();
    // Neither opening has published its resume reference or returned a batch yet.
    harness.openMutationEditor.mockImplementation(() => new Promise<MutationSession>(() => {}));
    const openOccurrence = async (selected: DonorEvent) => {
      harness.clicked = selected;
      const expectedCalls = harness.openMutationEditor.mock.calls.length + 1;
      const view = render(<App />);
      fireEvent.click(screen.getByText('Test Edit'));
      fireEvent.click(await screen.findByRole('button', {name: /^This event /}));
      await waitFor(() => expect(harness.openMutationEditor).toHaveBeenCalledTimes(expectedCalls));
      const [change, editableId, scopeKey] = harness.openMutationEditor.mock.calls.at(-1)!;
      view.unmount();
      return {event: change.added[0] as CalendarEvent, editableId, scopeKey};
    };
    const first = await openOccurrence(occurrence);
    const second = await openOccurrence({...occurrence, id: 'view-local-id-changed'});
    expect(first.event.id).toMatch(/^occurrence_[a-f0-9]{64}$/);
    expect(second.event.id).toBe(first.event.id); expect(second.editableId).toBe(first.editableId);
    expect(second.scopeKey).toBe(first.scopeKey); expect(second.event.recurrenceId).toBe(occurrence.start.toISOString());
    const following = await openOccurrence({...occurrence, start: occurrence.start.add(7, 'day'), end: occurrence.end.add(7, 'day')});
    expect(following.event.id).not.toBe(first.event.id); expect(following.editableId).toBe(following.event.id);
    expect(following.event.uid).toBe(first.event.uid); expect(following.event.recurrenceId).toBe(occurrence.start.add(7, 'day').toISOString());
  });
  it('This and following events retains the donor cutoff and override removals while editing the actual new series', async () => {
    const {base, prior, future} = recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^This and following events /}));
    await screen.findByLabelText('Title');
    const [change, id] = harness.openMutationEditor.mock.calls[0];
    expect(change.updated[0].id).toBe(base.id); expect(change.updated[0].rrule.until).toBe('2026-10-17T23:59:59.999Z');
    expect(change.updated[0].exdates).toEqual([prior.recurrenceId]);
    expect(change.deleted.map((event: CalendarEvent) => event.id)).toEqual([future.id]);
    expect(change.added[0].id).toBe('event-1_following'); expect(id).toBe(change.added[0].id);
    expect(screen.getByText(/1 detached override will be removed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-'}});
    expect(opened.editor!.write).toHaveBeenLastCalledWith({start: '2026-10-', rrule: {...change.added[0].rrule, dtstart: '2026-10-'}});
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-19T11:00:00.000Z'}});
    fireEvent.change(screen.getByLabelText('End · ISO date and time'), {target: {value: '2026-10-19T12:30:00.000Z'}});
    fireEvent.change(screen.getByLabelText('Title'), {target: {value: 'Future planning'}});
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(opened.batch!.commit).toHaveBeenCalledOnce());
    expect(harness.openMutationEditor).toHaveBeenCalledOnce();
    expect(opened.editor!.value().rrule).toEqual({...base.rrule, dtstart: '2026-10-19T11:00:00.000Z'});
    expect(change.updated[0].rrule.until).toBe('2026-10-17T23:59:59.999Z');
  });
  it('All events removes overrides, clears exceptions and uses donor anchor-date/time semantics on Save', async () => {
    const {base, prior, future} = recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    const [change, id] = harness.openMutationEditor.mock.calls[0];
    expect(id).toBe(base.id); expect(change.added).toEqual([]); expect(change.updated[0].exdates).toEqual([]);
    expect(change.deleted.map((event: CalendarEvent) => event.id)).toEqual([prior.id, future.id]);
    expect(screen.getByText(/2 detached overrides will be removed/)).toBeTruthy();
    expect((screen.getByLabelText('Start · ISO date and time') as HTMLInputElement).value).toBe(base.start);
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-11-22T14:15:00.000Z'}});
    fireEvent.change(screen.getByLabelText('End · ISO date and time'), {target: {value: '2026-11-22T16:45:00.000Z'}});
    expect(opened.editor!.value().start).toBe('2026-11-22T14:15:00.000Z');
    expect(opened.batch!.commit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(opened.batch!.commit).toHaveBeenCalledOnce());
    expect(opened.editor!.selection).toHaveBeenCalledOnce();
    expect(opened.editor!.value().start).toBe('2026-10-04T14:15:00.000Z');
    expect(opened.editor!.value().end).toBe('2026-10-04T16:45:00.000Z');
    expect(opened.editor!.value().rrule).toEqual({...base.rrule, dtstart: '2026-10-04T14:15:00.000Z'});
    expect(opened.editor!.commit).not.toHaveBeenCalled();
  });
  it('does not overwrite native raw notes when scoped source fields are absent, but retains an explicit empty edit', async () => {
    const {base} = recurringFixture();
    const rawNotes = 'Native notes still being edited';
    let editor: ReturnType<typeof draft> | undefined;
    const commit = vi.fn(async () => {});
    harness.openMutationEditor.mockImplementation(async (change: {added: CalendarEvent[]; updated: CalendarEvent[]; deleted: CalendarEvent[]}, id: string) => {
      const proposed = [...change.added, ...change.updated].find(event => event.id === id)!;
      // Applying only proposed fields must keep a native field absent from stored data.
      editor = draft({...base, description: rawNotes, ...proposed});
      return {editor, count: 3, removedCount: 2, close: vi.fn(), validate: vi.fn(async () => []), commit} satisfies MutationSession;
    });
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    const notes = await screen.findByLabelText('Description');
    expect(harness.openMutationEditor.mock.calls[0][0].updated[0]).not.toHaveProperty('description');
    expect((notes as HTMLTextAreaElement).value).toBe(rawNotes);
    fireEvent.change(notes, {target: {value: ''}});
    expect(editor!.write).toHaveBeenCalledWith({description: ''}); expect(editor!.value().description).toBe('');
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(editor!.value().description).toBe('');
  });
  it('preserves a valid rule changed in the native All draft while retaining donor anchor dates', async () => {
    const {base} = recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-11-22T14:15:00.000Z'}});
    fireEvent.change(screen.getByLabelText('End · ISO date and time'), {target: {value: '2026-11-22T16:45:00.000Z'}});
    // A resumed draft or another native editor may hold a newer recurrence rule.
    const heldRule = {freq: 1, interval: 3, bymonthday: [4], count: 7, dtstart: '2026-11-22T14:15:00.000Z'};
    await act(async () => {await opened.editor!.write({rrule: heldRule});});
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(opened.batch!.commit).toHaveBeenCalledOnce());
    expect(opened.editor!.selection).toHaveBeenCalledOnce();
    expect(opened.editor!.value().rrule).toEqual({...heldRule, dtstart: '2026-10-04T14:15:00.000Z'});
    expect(opened.editor!.value().start).toBe('2026-10-04T14:15:00.000Z');
    expect(opened.editor!.value().end).toBe('2026-10-04T16:45:00.000Z');
    expect(base.rrule!.freq).toBe(2);
  });
  it.each([null, undefined])('does not resurrect an absent native All draft rule (%s)', async rrule => {
    const {base} = recurringFixture(); const editor = draft({...base, rrule});
    const batch: MutationSession = {editor, count: 3, removedCount: 2, close: vi.fn(), validate: vi.fn(async () => []), commit: vi.fn(async () => {})};
    harness.openMutationEditor.mockResolvedValue(batch);
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-11-22T14:15:00.000Z'}});
    fireEvent.change(screen.getByLabelText('End · ISO date and time'), {target: {value: '2026-11-22T16:45:00.000Z'}});
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(batch.commit).toHaveBeenCalledOnce());
    expect(editor.selection).toHaveBeenCalledOnce(); expect(editor.value().rrule).toBeNull();
    expect(editor.value().start).toBe('2026-10-04T14:15:00.000Z');
    expect(editor.value().end).toBe('2026-10-04T16:45:00.000Z');
  });
  it('refuses All normalization when its primary draft was saved or discarded elsewhere', async () => {
    recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    opened.editor!.selection.mockResolvedValueOnce(null);
    const writes = opened.editor!.write.mock.calls.length;
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The event draft was saved or discarded elsewhere. Review the remaining Room drafts in House.');
    expect(opened.editor!.write).toHaveBeenCalledTimes(writes); expect(opened.editor!.writeExisting).not.toHaveBeenCalled(); expect(opened.batch!.commit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Title')).toBeTruthy();
  });
  it('validates the entire native All bundle before normalizing the primary draft', async () => {
    recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    vi.mocked(opened.batch!.validate).mockRejectedValueOnce(new Error('Part of this scoped edit was saved or discarded elsewhere.'));
    const writes = opened.editor!.write.mock.calls.length;
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Part of this scoped edit was saved or discarded elsewhere.');
    expect(opened.editor!.selection).toHaveBeenCalledOnce(); expect(opened.batch!.validate).toHaveBeenCalledOnce();
    expect(opened.editor!.write).toHaveBeenCalledTimes(writes); expect(opened.editor!.writeExisting).not.toHaveBeenCalled(); expect(opened.batch!.commit).not.toHaveBeenCalled();
  });
  it('does not recreate an All draft that disappears between validation and normalization', async () => {
    recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    opened.editor!.writeExisting.mockRejectedValueOnce(new Error('The native draft disappeared.'));
    const writes = opened.editor!.write.mock.calls.length;
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The native draft disappeared.');
    expect(opened.batch!.validate).toHaveBeenCalledOnce(); expect(opened.editor!.writeExisting).toHaveBeenCalledOnce();
    expect(opened.editor!.write).toHaveBeenCalledTimes(writes); expect(opened.batch!.commit).not.toHaveBeenCalled();
  });
  it('does not normalize invalid All events input or save after validation failure; Close keeps scoped drafts', async () => {
    recurringFixture(); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-'}});
    opened.editor!.selection.mockRejectedValueOnce(new Error('Start must be a complete ISO timestamp.'));
    const writes = opened.editor!.write.mock.calls.length;
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Start must be a complete ISO timestamp.');
    expect(opened.editor!.write).toHaveBeenCalledTimes(writes); expect(opened.editor!.value().start).toBe('2026-10-');
    expect(opened.batch!.commit).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', {name: 'Close'})[0]);
    await waitFor(() => expect(opened.batch!.close).toHaveBeenCalledOnce());
    expect(opened.batch!.commit).not.toHaveBeenCalled();
  });
  it('edits an existing detached override in place for This event, preserving its original recurrence identity', async () => {
    const {prior} = recurringFixture(); harness.clicked = toDonorEvent(prior); const opened = mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^This event /}));
    await screen.findByLabelText('Title');
    const [change, id] = harness.openMutationEditor.mock.calls[0];
    expect(change.added).toEqual([]); expect(change.deleted).toEqual([]); expect(change.updated).toHaveLength(1);
    expect(id).toBe(prior.id); expect(change.updated[0].recurrenceId).toBe(prior.recurrenceId);
    expect(harness.openMutationEditor.mock.calls[0][2]).toBe(`series@ilamy.calendar:this:${prior.recurrenceId}`);
    expect(screen.getByText(/updates its existing detached override/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-12T11:00:00.000Z'}});
    fireEvent.change(screen.getByLabelText('End · ISO date and time'), {target: {value: '2026-10-12T12:00:00.000Z'}});
    fireEvent.click(screen.getByRole('button', {name: 'Save event'}));
    await waitFor(() => expect(opened.batch!.commit).toHaveBeenCalledOnce());
    expect(opened.editor!.value().id).toBe(prior.id); expect(opened.editor!.value().recurrenceId).toBe(prior.recurrenceId);
    expect(harness.openEditor).not.toHaveBeenCalled();
  });
  it('uses the donor fallback series identity when opening the original master without a UID', async () => {
    const base = row({rrule: {freq: 2, dtstart: row().start}});
    harness.snapshot.events = [base]; harness.clicked = toDonorEvent(base); mutationDraft();
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    expect(harness.openMutationEditor.mock.calls[0][2]).toBe('event-1@ilamy.calendar:all:series');
    expect(harness.openMutationEditor.mock.calls[0][0].updated[0].uid).toBe('event-1@ilamy.calendar');
  });
  it('shows the native resumed bundle removal count rather than a fresh proposed count', async () => {
    const {base} = recurringFixture();
    harness.openMutationEditor.mockResolvedValue({editor: draft(base), count: 4, removedCount: 3, close: vi.fn(), validate: vi.fn(async () => []), commit: vi.fn(async () => {})} satisfies MutationSession);
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    await screen.findByLabelText('Title');
    expect(harness.openMutationEditor.mock.calls[0][0].deleted).toHaveLength(2);
    expect(screen.getByText(/3 detached overrides will be removed/)).toBeTruthy();
    expect(screen.getByText(/4 event documents are staged in Room drafts/)).toBeTruthy();
  });
  it.each([
    ['this', /^This event /], ['following', /^This and following events /], ['all', /^All events /],
  ] as const)('uses a stable %s scope pointer to reopen raw native input after remount', async (scope, button) => {
    const {occurrence} = recurringFixture();
    const held = new Map<string, ReturnType<typeof draft>>();
    const commits = vi.fn(async () => {});
    harness.openMutationEditor.mockImplementation(async (change: {added: CalendarEvent[]; updated: CalendarEvent[]; deleted: CalendarEvent[]}, id: string, scopeKey: string) => {
      let editor = held.get(scopeKey);
      if (!editor) {
        editor = draft([...change.added, ...change.updated].find(event => event.id === id)!);
        held.set(scopeKey, editor);
      }
      return {editor, removedCount: change.deleted.length, count: change.added.length + change.updated.length + change.deleted.length, close: vi.fn(), validate: vi.fn(async () => []), commit: commits};
    });
    const first = render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: button}));
    fireEvent.change(await screen.findByLabelText('Title'), {target: {value: 'Unfinished scoped title'}});
    fireEvent.change(screen.getByLabelText('Start · ISO date and time'), {target: {value: '2026-10-'}});
    const key = harness.openMutationEditor.mock.calls[0][2];
    expect(key).toBe(`series@ilamy.calendar:${scope}:${scope === 'all' ? 'series' : occurrence.start.toISOString()}`);
    first.unmount();
    // Generated view IDs may change after reload; All can be reopened from another occurrence.
    harness.clicked = {...occurrence, id: 'event-1_47', ...(scope === 'all' ? {
      start: occurrence.start.add(7, 'day'), end: occurrence.end.add(7, 'day'),
    } : {})};
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: button}));
    expect((await screen.findByLabelText('Title') as HTMLInputElement).value).toBe('Unfinished scoped title');
    expect((screen.getByLabelText('Start · ISO date and time') as HTMLInputElement).value).toBe('2026-10-');
    expect(harness.openMutationEditor.mock.calls[1][2]).toBe(key);
    expect(held.size).toBe(1); expect(commits).not.toHaveBeenCalled();
  });
  it('closes a late scoped editor without saving after the dialog was dismissed', async () => {
    const {base} = recurringFixture();
    let resolve!: (session: MutationSession) => void;
    harness.openMutationEditor.mockImplementation(() => new Promise<MutationSession>(done => {resolve = done;}));
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    expect(await screen.findByText('Opening Room draft…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Close'}));
    const batch: MutationSession = {editor: draft(base), removedCount: 2, count: 3, close: vi.fn(), validate: vi.fn(async () => []), commit: vi.fn(async () => {})};
    await act(async () => resolve(batch));
    expect(batch.close).toHaveBeenCalledOnce(); expect(batch.commit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });
  it('reports staged-draft retention on a scoped preparation failure', async () => {
    recurringFixture(); harness.openMutationEditor.mockRejectedValueOnce(new Error('An override has an unfinished Room draft.'));
    render(<App />); fireEvent.click(screen.getByText('Test Edit'));
    fireEvent.click(await screen.findByRole('button', {name: /^All events /}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'An override has an unfinished Room draft. Any Room drafts already staged are retained for review in House.');
  });
});

describe('recurrence and drag boundary', () => {
  it('round-trips ISO dates, nullable metadata and ordinal Weekday without instances in Room JSON', () => {
    const source = row({uid: null, recurrenceId: null, rrule: {freq: 1, dtstart: REFERENCE_DATE, until: '2026-12-31T23:59:59.999Z', byweekday: [1, {weekday: 4, n: -1}]}});
    const donor = toDonorEvent(source);
    expect(donor.start.toISOString()).toBe(source.start); expect(donor.rrule?.dtstart).toBeInstanceOf(Date);
    expect((donor.rrule?.byweekday as unknown[])[1]).toBeInstanceOf(Weekday);
    const roundtrip = toRoomEvent(donor, source);
    expect(roundtrip.rrule).toEqual(source.rrule); expect(roundtrip.uid).toBeNull(); expect(roundtrip.recurrenceId).toBeNull();
    expect(JSON.parse(JSON.stringify(roundtrip)).rrule).toEqual(source.rrule);
    expect(toRoomEvent({...donor, rrule: undefined}, source).rrule).toBeNull();
  });
  it('preserves optional-field absence for stored rows while retaining explicit empty or false donor values', () => {
    const source = row(); const donor = toDonorEvent(source);
    const absent = toRoomEvent(donor, source);
    for (const field of ['description', 'location', 'color', 'backgroundColor', 'allDay', 'rrule', 'uid', 'recurrenceId', 'exdates']) {
      expect(absent).not.toHaveProperty(field);
    }
    const explicit = toRoomEvent({...donor, description: '', location: '', color: '', backgroundColor: '', allDay: false}, source);
    expect(explicit.description).toBe(''); expect(explicit.location).toBe(''); expect(explicit.color).toBe('');
    expect(explicit.backgroundColor).toBe(''); expect(explicit.allDay).toBe(false);
    const created = toRoomEvent(donor);
    expect(created.description).toBe(''); expect(created.allDay).toBe(false); expect(created.rrule).toBeNull(); expect(created.exdates).toEqual([]);
  });
  it('retains donor clearing semantics for previously present optional fields, including All exceptions', () => {
    const source = row({description: 'Stored notes', location: 'Stored room', color: 'blue', backgroundColor: '#fff', allDay: true,
      rrule: {freq: 2, dtstart: row().start}, uid: 'series@ilamy.calendar', recurrenceId: row().start, exdates: [row().start]});
    const cleared = toRoomEvent({...toDonorEvent(source), description: undefined, location: undefined, color: undefined,
      backgroundColor: undefined, allDay: undefined, rrule: undefined, uid: undefined, recurrenceId: undefined, exdates: undefined}, source);
    expect(cleared.description).toBe(''); expect(cleared.location).toBe(''); expect(cleared.color).toBe(''); expect(cleared.backgroundColor).toBe('');
    expect(cleared.allDay).toBe(false); expect(cleared.rrule).toBeNull(); expect(cleared.uid).toBeNull(); expect(cleared.recurrenceId).toBeNull();
    expect(cleared.exdates).toEqual([]);
  });
  it('stages the complete donor scoped drag bundle and commits only with explicit Save', async () => {
    const base = row({uid: 'series@ilamy.calendar', rrule: {freq: 2, dtstart: REFERENCE_DATE}});
    const removed = row({id: 'override-old', rrule: null, uid: base.uid, recurrenceId: base.start});
    harness.snapshot.events = [base, removed];
    const session: MutationSession = {editor: undefined, removedCount: 1, count: 3, close: vi.fn(), validate: vi.fn(async () => []), commit: vi.fn(async () => {})};
    harness.openMutationEditor.mockResolvedValue(session); render(<App />);
    const donor = toDonorEvent(base);
    const updated = {...donor, exdates: [base.start]};
    const added = {...donor, id: 'event-1_modified_1', rrule: undefined, recurrenceId: base.start, start: dayjs(base.start).add(1, 'hour'), end: dayjs(base.end).add(1, 'hour')};
    act(() => latest().onEventsChange?.({action: 'update', event: donor, scope: 'this', added: [added], updated: [updated], deleted: [toDonorEvent(removed)]}));
    expect(await screen.findByText('3 event documents are staged in Room drafts.')).toBeTruthy();
    expect(harness.openMutationEditor).toHaveBeenCalledTimes(1); expect(session.commit).not.toHaveBeenCalled();
    const change = harness.openMutationEditor.mock.calls[0][0];
    expect(change.updated[0].exdates).toEqual([base.start]); expect(change.added[0].rrule).toBeNull();
    expect(change.added[0].recurrenceId).toBe(base.start); expect(change.deleted[0].id).toBe('override-old');
    expect(typeof change.added[0].start).toBe('string');
    fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(session.commit).toHaveBeenCalledTimes(1)); expect(session.close).toHaveBeenCalledTimes(1);
  });
  it('closing a staged move never commits it and async failures stay visible', async () => {
    const session: MutationSession = {editor: undefined, removedCount: 0, count: 1, close: vi.fn(), validate: vi.fn(async () => []), commit: vi.fn(async () => {})};
    harness.openMutationEditor.mockResolvedValueOnce(session).mockRejectedValueOnce(new Error('Original room changed'));
    harness.snapshot.events = [row()]; render(<App />); const donor = toDonorEvent(row());
    const change = {action: 'update' as const, event: donor, added: [], updated: [donor], deleted: []};
    act(() => latest().onEventsChange?.(change)); await screen.findByText('1 event document is staged in Room drafts.');
    fireEvent.click(screen.getAllByRole('button', {name: 'Close'})[0]); expect(session.commit).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
    act(() => latest().onEventsChange?.(change)); expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Original room changed');
  });
});
