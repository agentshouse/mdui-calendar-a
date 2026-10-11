import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IlamyCalendar, SLOT_EVENT_MUTATION_SCOPE, type CalendarEvent as DonorEvent, type EventFormProps, type EventsChange, type PluginMutationResult } from '@ilamy/calendar';
import { recurrencePlugin, Weekday, type RecurrenceEditScope, type RRuleOptions } from '@ilamy/calendar-recurrence';
import dayjs from '@ilamy/utils/dayjs';
import { Button } from '@ilamy/ui/components/button';
import { Input } from '@ilamy/ui/components/input';
import { Textarea } from '@ilamy/ui/components/textarea';
import { Label } from '@ilamy/ui/components/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ilamy/ui/components/dialog';
import { CalendarDays, LoaderCircle } from 'lucide-react';
import { dataStore, type CalendarEvent, type EditorSession, type MutationSession } from './data/house';
import { validationMessage as message } from './validation-message';

export const REFERENCE_DATE = '2026-10-11T00:00:00.000Z';
const recurrence = recurrencePlugin();
const plugins = [recurrence];

/** The only conversion boundary: Room JSON is never populated with Dayjs or RRule instances. */
export function toDonorEvent(event: CalendarEvent): DonorEvent {
  const rule = event.rrule ? { ...event.rrule } : undefined;
  if (rule) {
    for (const field of ['dtstart', 'until']) if (typeof rule[field] === 'string') rule[field] = new Date(rule[field] as string);
    if (Array.isArray(rule.byweekday)) rule.byweekday = rule.byweekday.map(value => {
      if (value && typeof value === 'object' && 'weekday' in value) {
        const day = value as {weekday: number; n?: number};
        return new Weekday(day.weekday, day.n);
      }
      return value;
    });
  }
  return { ...event, start: dayjs(event.start), end: dayjs(event.end), uid: event.uid || undefined,
    recurrenceId: event.recurrenceId || undefined, rrule: rule as RRuleOptions | undefined };
}

export function toRoomEvent(event: DonorEvent, existing?: CalendarEvent): CalendarEvent {
  const rule = event.rrule ? { ...event.rrule } as Record<string, unknown> : null;
  if (rule) {
    for (const field of ['dtstart', 'until']) if (rule[field] != null) rule[field] = dayjs(rule[field] as string | Date).toISOString();
    if (Array.isArray(rule.byweekday)) rule.byweekday = rule.byweekday.map(value => {
      if (value && typeof value === 'object' && 'weekday' in value) {
        const weekday = value as {weekday: number; n?: number};
        return weekday.n == null ? weekday.weekday : {weekday: weekday.weekday, n: weekday.n};
      }
      return value;
    });
  }
  const now = new Date().toISOString();
  const optional = {
    allDay: Boolean(event.allDay), description: event.description ?? '', location: event.location ?? '',
    color: event.color ?? '', backgroundColor: event.backgroundColor ?? '',
    uid: event.uid || null, recurrenceId: event.recurrenceId || null, exdates: event.exdates ?? [], rrule: rule,
  };
  const result: CalendarEvent = {...existing, id: String(event.id), title: event.title, start: event.start.toISOString(), end: event.end.toISOString(),
    ...optional, createdAt: existing?.createdAt ?? now, updatedAt: now};
  // Missing stored fields are not donor edits. Synthetic defaults would replace
  // held native input when a scoped draft is initialized. A previously present
  // field still gets its intentional clearing value (for example All EXDATEs).
  if (existing) for (const key of Object.keys(optional) as (keyof typeof optional)[]) {
    if (event[key] === undefined && existing[key] === undefined) delete result[key];
  }
  return result;
}

function findStoredEvent(selected: DonorEvent | null | undefined) {
  return selected ? dataStore.snapshot().events.find(event => event.id === String(selected.id)) : undefined;
}

// Match the business fields submitted by the donor form, never its view-local ID.
function editableDonorFields(event: DonorEvent): Partial<DonorEvent> {
  const {title, start, end, allDay, description, location, color, backgroundColor} = event;
  return {title, start, end, allDay, description, location, color, backgroundColor};
}

function scopedEdit(event: DonorEvent, scope: RecurrenceEditScope, currentEvents: DonorEvent[], updates: Partial<DonorEvent>): PluginMutationResult {
  const result = recurrence.applyEdit?.({event, scope, currentEvents, updates});
  if (!result || Array.isArray(result)) throw new Error('The recurring edit did not return a complete event change.');
  return result;
}

// Concurrent tabs must address the same native creation draft even before the
// path-only resume reference is published. Keep the donor's recurrence mutation
// intact and replace only a new detached occurrence's timestamp-based identity.
async function identifyNewOccurrence(change: PluginMutationResult, scope: RecurrenceEditScope): Promise<PluginMutationResult> {
  if (scope !== 'this' || !change.added.length) return change;
  const replacements = new Map<DonorEvent, DonorEvent>();
  const added = await Promise.all(change.added.map(async event => {
    if (!event.uid || !event.recurrenceId) throw new Error('The new occurrence has no stable series identity.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([event.uid, event.recurrenceId])));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const identified = {...event, id: `occurrence_${hash}`};
    replacements.set(event, identified);
    return identified;
  }));
  return {...change, added, events: change.events.map(event => replacements.get(event) ?? event)};
}

function scopeEffects(scope: RecurrenceEditScope, removedCount: number, existingOverride: boolean): string {
  if (scope === 'this') return existingOverride
    ? 'Only this occurrence changes. Save updates its existing detached override and keeps its original recurrence identity.'
    : 'Only this occurrence changes. Save excludes the original occurrence from its series and creates a detached override for your edits.';
  const removals = `${removedCount} detached override${removedCount === 1 ? '' : 's'} will be removed.`;
  if (scope === 'following') return `Save ends the original series before the selected occurrence and creates a new series from the entered start. Earlier occurrences stay unchanged. ${removals}`;
  return `Save edits the entire series, keeps its original start date, and applies the entered time and duration. All exceptions will be cleared, restoring excluded occurrences. ${removals}`;
}

type FormEditor = {session: EditorSession; commit?: () => Promise<void>; effects?: string; count?: number};

function DraftFields({ session, commit, effects, count, busy, afterSave }: FormEditor & { busy: boolean; afterSave: () => void }) {
  const [, refresh] = useState(0);
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => session.subscribe(() => refresh(value => value + 1)), [session]);
  const fields = session.value();
  const write = (patch: Record<string, unknown>) => {
    setFailure(undefined);
    void session.write(patch).catch(error => setFailure(message(error)));
  };
  const save = async () => {
    if (saving || busy) return;
    setSaving(true); setFailure(undefined);
    try { await (commit ? commit() : session.commit()); afterSave(); } catch (error) { setFailure(message(error)); } finally { setSaving(false); }
  };
  const textField = (name: string, label: string, placeholder?: string) => <div className="grid gap-2" key={name}>
    <Label htmlFor={`event-${name}`}>{label}</Label>
    <Input id={`event-${name}`} name={name} value={String(fields[name] ?? '')} placeholder={placeholder}
      onChange={event => {
        const raw = event.target.value;
        const recurrence = session.value().rrule;
        write(name === 'start' && recurrence && typeof recurrence === 'object'
          ? {start: raw, rrule: {...recurrence, dtstart: raw}} : {[name]: raw});
      }} autoComplete="off" />
  </div>;
  return <form className="grid gap-4" onSubmit={event => {event.preventDefault(); void save();}}>
    <fieldset className="contents" disabled={saving || busy}>
      {textField('title', 'Title', 'Add a title')}
      <div className="grid gap-4 sm:grid-cols-2">
        {textField('start', 'Start · ISO date and time', '2026-10-11T09:00:00.000Z')}
        {textField('end', 'End · ISO date and time', '2026-10-11T10:00:00.000Z')}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">Times are shown in UTC. Enter a complete ISO timestamp, including its timezone.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(fields.allDay)}
        onChange={event => write({allDay: event.target.checked})} />All day</label>
      {textField('location', 'Location', 'Add a location')}
      <div className="grid gap-2"><Label htmlFor="event-description">Description</Label>
        <Textarea id="event-description" rows={3} value={String(fields.description ?? '')}
          onChange={event => write({description: event.target.value})} placeholder="Add a description" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{textField('backgroundColor', 'Background color', '#dbeafe')}{textField('color', 'Text color / color classes', '#1e40af')}</div>
      {effects && <div className="rounded-md bg-muted p-3 text-sm"><p>{effects}</p><p className="mt-2">{count} event {count === 1 ? 'document is' : 'documents are'} staged in Room drafts. The live calendar changes only when you save.</p></div>}
      {(failure || session.error()) && <p role="alert" className="text-sm text-destructive">{failure || session.error()}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={afterSave}>Close</Button>
        <Button type="submit" disabled={saving || busy}>{saving ? <LoaderCircle className="size-4 animate-spin" /> : null}Save event</Button></DialogFooter>
      <p className="text-xs text-muted-foreground">Changes stay in your Room draft until you save. Closing keeps the draft.</p>
    </fieldset>
  </form>;
}

function RoomEventForm({ selectedEvent, onClose }: EventFormProps) {
  const [editor, setEditor] = useState<FormEditor>();
  const [failure, setFailure] = useState<string>();
  const [scope, setScope] = useState<RecurrenceEditScope>();
  const scopeChosen = useRef(false);
  const snapshot = useSyncExternalStore(dataStore.subscribe, dataStore.snapshot);
  const original = useMemo(() => findStoredEvent(selectedEvent), [selectedEvent]);
  const recurring = Boolean(selectedEvent && recurrence.managesEvent?.(selectedEvent));
  useEffect(() => {
    if (recurring && !scope) return;
    let cancelled = false;
    let active: EditorSession | MutationSession | undefined;
    const closeActive = () => {active?.close(); active = undefined;};
    const open = async (): Promise<FormEditor> => {
      if (recurring && selectedEvent && scope) {
        const rows = dataStore.snapshot().events;
        const donorRows = rows.map(toDonorEvent);
        const change = await identifyNewOccurrence(scopedEdit(selectedEvent, scope, donorRows, editableDonorFields(selectedEvent)), scope);
        const primary = scope === 'this'
          ? change.added[0] ?? change.updated.find(event => event.id === selectedEvent.id)
          : scope === 'following' ? change.added[0] : change.updated[0];
        if (!primary) throw new Error('The recurring edit has no editable event.');
        const normalize = (event: DonorEvent) => toRoomEvent(event, rows.find(row => row.id === String(event.id)));
        const seriesUid = selectedEvent.uid || `${selectedEvent.id}@ilamy.calendar`;
        const scopeKey = `${seriesUid}:${scope}:${scope === 'all' ? 'series' : selectedEvent.recurrenceId ?? selectedEvent.start.toISOString()}`;
        const batch = await dataStore.openMutationEditor({added: change.added.map(normalize), updated: change.updated.map(normalize), deleted: change.deleted.map(normalize)}, String(primary.id), scopeKey);
        active = batch;
        const session = batch.editor;
        if (!session) {closeActive(); throw new Error('The recurring event draft could not be opened.');}
        return {session, count: batch.count, effects: scopeEffects(scope, batch.removedCount, Boolean(selectedEvent.recurrenceId)), commit: async () => {
          if (scope === 'all') {
            // Flush and validate raw Room fields before any donor date conversion.
            // Invalid or incomplete input must remain untouched in its native draft.
            if (!await session.selection()) throw new Error('The event draft was saved or discarded elsewhere. Review the remaining Room drafts in House.');
            await batch.validate();
            const edited = toDonorEvent(session.value() as CalendarEvent);
            const normalized = scopedEdit(selectedEvent, scope, donorRows, {...editableDonorFields(edited), rrule: edited.rrule}).updated[0];
            // Keep a rule changed in the native draft. The donor's nullish-rule
            // fallback must not resurrect a rule removed outside this form.
            const anchored = toRoomEvent({...normalized, rrule: edited.rrule ? normalized.rrule : undefined});
            await session.writeExisting({start: anchored.start, end: anchored.end, rrule: anchored.rrule});
          }
          await batch.commit();
        }};
      }
      const proposed = !original ? {
        title: selectedEvent?.title || '', start: selectedEvent?.start?.toISOString() ?? REFERENCE_DATE,
        end: selectedEvent?.end?.toISOString() ?? dayjs(REFERENCE_DATE).add(1, 'hour').toISOString(),
        allDay: Boolean(selectedEvent?.allDay), color: 'bg-blue-100 text-blue-800',
      } : undefined;
      const session = await dataStore.openEditor(original, proposed);
      active = session;
      return {session};
    };
    void open().then(next => {
      if (cancelled) {closeActive(); return;}
      setEditor(next);
    }).catch(error => {if (!cancelled) setFailure(recurring ? `${message(error)} Any Room drafts already staged are retained for review in House.` : message(error));});
    return () => {cancelled = true; closeActive();};
  }, [original, selectedEvent, recurring, scope]);
  if (recurring && selectedEvent && !scope) return recurrence.renderSlot?.(SLOT_EVENT_MUTATION_SCOPE, {
    event: selectedEvent, operation: 'edit',
    resolve: (choice: unknown) => {
      if (choice !== 'this' && choice !== 'following' && choice !== 'all') return;
      scopeChosen.current = true; setScope(choice);
    },
    // The donor calls onClose after onConfirm as well as for Cancel.
    cancel: () => {if (!scopeChosen.current) onClose();},
  });
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className="sm:max-w-[620px] overflow-y-auto">
      <DialogHeader><DialogTitle>{recurring ? scope === 'all' ? 'Edit recurring series' : scope === 'following' ? 'Edit this and following events' : 'Edit this occurrence' : original ? 'Edit event' : 'New event'}</DialogTitle>
        <DialogDescription>{recurring ? 'Review the scope below and save the complete change together.' : original ? 'Update the event in your Calendar Room.' : 'Create an event in your Calendar Room.'}</DialogDescription></DialogHeader>
      {failure ? <p role="alert" className="text-sm text-destructive">{failure}</p> : editor ? <DraftFields {...editor} busy={snapshot.busy} afterSave={onClose} /> : <p role="status" className="text-sm text-muted-foreground">Opening Room draft…</p>}
    </DialogContent>
  </Dialog>;
}

class CalendarBoundary extends Component<{ children: ReactNode; resetKey: number }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) { return {error: message(error)}; }
  componentDidUpdate(previous: { children: ReactNode; resetKey: number }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({error: undefined});
  }
  render() {return this.state.error ? <div className="calendar-error" role="alert">Calendar data could not be displayed: {this.state.error}</div> : this.props.children;}
}

type MutationDialog = {session?: MutationSession; label: string; failure?: string};
export default function App() {
  const snapshot = useSyncExternalStore(dataStore.subscribe, dataStore.snapshot);
  const [revision, reconcile] = useState(0);
  const [mutation, setMutation] = useState<MutationDialog>();
  const [saving, setSaving] = useState(false);
  const mutationGeneration = useRef(0);
  const currentMutation = useRef<MutationSession | undefined>(undefined);
  useEffect(() => {void dataStore.start(); return () => {mutationGeneration.current++; currentMutation.current?.close();};}, []);
  const events = useMemo(() => snapshot.events.map(toDonorEvent), [snapshot.events, revision]);
  const closeMutation = useCallback(() => {
    mutationGeneration.current++;
    currentMutation.current?.close(); currentMutation.current = undefined;
    setMutation(undefined); reconcile(value => value + 1);
  }, []);
  const stageMutation = useCallback((change: EventsChange) => {
    const generation = ++mutationGeneration.current;
    currentMutation.current?.close(); currentMutation.current = undefined;
    const label = change.scope === 'this' ? 'this occurrence' : change.scope === 'following' ? 'this and following events' : change.scope === 'all' ? 'the entire series' : 'this event';
    setMutation({label});
    const rows = dataStore.snapshot().events;
    const normalize = (event: DonorEvent) => toRoomEvent(event, rows.find(row => row.id === String(event.id)));
    void dataStore.openMutationEditor({added: change.added.map(normalize), updated: change.updated.map(normalize), deleted: change.deleted.map(normalize)}).then(session => {
      if (generation !== mutationGeneration.current) {session.close(); return;}
      currentMutation.current = session; setMutation({session, label});
    }).catch(error => {if (generation === mutationGeneration.current) setMutation({label, failure: message(error)});});
    // Donor mutations are optimistic view state only. Reassert the live Room immediately.
    reconcile(value => value + 1);
  }, []);
  const saveMutation = async () => {
    if (!mutation?.session || saving || snapshot.busy) return;
    setSaving(true);
    try {await mutation.session.commit(); closeMutation();} catch (error) {setMutation(current => current ? {...current, failure: message(error)} : current);} finally {setSaving(false);}
  };
  return <main className="calendar-shell">
    <header className="app-heading"><div className="app-brand"><CalendarDays size={25} strokeWidth={1.7} /><h1>Calendar</h1></div></header>
    {(snapshot.error || snapshot.status || snapshot.halted) && <div className={snapshot.error ? 'calendar-error' : 'calendar-notice'} role={snapshot.error ? 'alert' : 'status'}>{snapshot.error || snapshot.status || 'Provider writes are paused. Save still queues changes locally in House.'}</div>}
    <section className="calendar-panel" aria-label="Calendar">
      {snapshot.loading ? <div className="loading-calendar"><LoaderCircle className="size-6 animate-spin" /><p>Loading your Calendar Room…</p></div> : <CalendarBoundary resetKey={snapshot.version}>
        <IlamyCalendar events={events} plugins={plugins} initialDate={REFERENCE_DATE} initialView="month" timezone="UTC"
          hideExportButton disableCellClick={Boolean(snapshot.error)} disableEventClick={Boolean(snapshot.error)} disableDragAndDrop={Boolean(snapshot.error || mutation)}
          renderEventForm={props => props.open ? <RoomEventForm {...props} /> : null} onEventsChange={stageMutation} />
      </CalendarBoundary>}
    </section>
    <Dialog open={Boolean(mutation)} onOpenChange={open => {if (!open && !saving) closeMutation();}}>
      <DialogContent><DialogHeader><DialogTitle>Save calendar changes?</DialogTitle><DialogDescription>The move affects {mutation?.label}. Your live calendar changes only when you save.</DialogDescription></DialogHeader>
        {mutation?.failure ? <p role="alert" className="text-sm text-destructive">{mutation.failure}</p> : mutation?.session ? <p className="text-sm">{mutation.session.count} event {mutation.session.count === 1 ? 'document is' : 'documents are'} staged in Room drafts.</p> : <p role="status" className="text-sm text-muted-foreground">Preparing Room drafts…</p>}
        <DialogFooter><Button variant="outline" onClick={closeMutation} disabled={saving}>Close</Button><Button onClick={() => {void saveMutation();}} disabled={!mutation?.session || saving || snapshot.busy}>{saving ? 'Saving…' : 'Save changes'}</Button></DialogFooter>
        <p className="text-xs text-muted-foreground">Closing keeps the staged drafts for review in House.</p>
      </DialogContent>
    </Dialog>
  </main>;
}
