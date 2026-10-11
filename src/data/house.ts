import {connectHouseBridge} from '@agentshouse/app-bridge';
import {z} from 'zod';

type Runtime = Awaited<ReturnType<typeof connectHouseBridge>['runtime']>;
type Parts = Parameters<Runtime['roomDraft']['write']>[3];
type Draft = NonNullable<Awaited<ReturnType<Runtime['roomDraft']['read']>>>;
type Document = {room: string; path: string; type?: string; fields?: Readonly<Record<string, unknown>>; markdown?: string};
export const OPENED = Symbol('opened calendar document');
const timestamp = z.iso.datetime({offset: true});
const identity = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/);
export const eventSchema = z.object({
  id: identity, title: z.string().min(1).max(1000).regex(/\S/), start: timestamp, end: timestamp,
  description: z.string().max(50000).optional(), location: z.string().max(2000).optional(),
  color: z.string().max(200).optional(), backgroundColor: z.string().max(200).optional(), allDay: z.boolean().optional(),
  rrule: z.record(z.string(), z.unknown()).nullable().optional(), exdates: z.array(timestamp).optional(), uid: z.string().max(300).nullable().optional(), recurrenceId: timestamp.nullable().optional(),
  createdAt: timestamp, updatedAt: timestamp,
}).refine(event => Date.parse(event.end) >= Date.parse(event.start), {message: 'End must be at or after start.', path: ['end']});
export type CalendarEvent = z.infer<typeof eventSchema> & {[OPENED]?: Document};
export type StoreSnapshot = {events: CalendarEvent[]; loading: boolean; error: string | null; status: string; halted: boolean; busy: boolean; version: number};
export const calendarQuery = {types: ['calendar_event'], select: {fields: 'all' as const, markdown: true as const}, orderBy: [{by: {field: '/start'}, direction: 'asc' as const}, {by: 'path' as const, direction: 'asc' as const}]};
const recurrenceFields = ['rrule', 'exdates', 'uid', 'recurrenceId'];
const editable = ['title', 'start', 'end', 'description', 'location', 'color', 'backgroundColor', 'allDay', 'rrule', 'exdates', 'uid', 'recurrenceId'];
const reasonText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let connection: Promise<Runtime> | undefined;
export function houseRuntime() {
  connection ??= (async () => {const bridge = connectHouseBridge(); bridge.setTab({title: 'Calendar'}); return bridge.runtime;})();
  return connection;
}

/** All business data and durable drafts belong to the host's local Room replica. */
export class HouseDataStore {
  private state: StoreSnapshot = {events: [], loading: true, error: null, status: '', halted: false, busy: false, version: 0};
  private listeners = new Set<() => void>();
  private closers: (() => void)[] = [];
  private init?: Promise<void>;
  private md?: Runtime;
  private room?: string;
  private ready = false;
  private disposed = false;
  private generation = 0;
  private storageLoss: string | null = null;
  private connectionRefusal: string | null = null;
  private blocker() {return this.storageLoss ?? this.connectionRefusal;}
  constructor(private provider: () => Promise<Runtime> = houseRuntime) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private emit(patch: Partial<StoreSnapshot>) {this.state = {...this.state, ...patch}; this.listeners.forEach(listener => listener());}
  private read(result: {documents: readonly Document[]}) {
    const ids = new Set<string>();
    const events = result.documents.map(doc => {
      if (doc.room !== this.room || doc.type !== 'calendar_event') throw new Error('Unexpected document outside the bound Calendar Room.');
      const event = eventSchema.parse(doc.fields);
      if (ids.has(event.id)) throw new Error('Duplicate Calendar event identity.');
      ids.add(event.id);
      return Object.assign(event, {[OPENED]: {...doc, fields: {...doc.fields}}});
    });
    this.emit({events, loading: false, error: this.blocker(), version: this.state.version + 1});
  }
  start() {this.init ??= this.connect(); return this.init;}
  private async connect() {
    const timeout = setTimeout(() => this.emit({loading: false, error: 'Open this Calendar App inside House to connect its Room.'}), 15000);
    try {
      const md = await this.provider(); this.md = md; clearTimeout(timeout);
      if (this.disposed) return;
      const rooms = await md.observe('rooms'); const sync = await md.observe('sync-status');
      if (this.disposed) {rooms.close(); sync.close(); return;}
      let query: {current(): {documents: readonly Document[]}; close(): void} | undefined;
      let stopQuery: (() => void) | undefined; let loading: Promise<void> | undefined;
      const render = () => {if (this.ready && query && !this.disposed) try {this.read(query.current());} catch (error) {this.emit({loading: false, error: this.blocker() ?? reasonText(error)});}};
      const bindings = () => {
        if (this.disposed) return;
        const current = rooms.current(); const status = sync.current();
        const target = current.length === 1 ? current[0].locator : undefined;
        this.ready = status.lastCompleted !== null && Boolean(target);
        this.emit({status: status.attentionRequired.length ? 'Room drafts need attention. Review them in House before saving those events.' : status.providerUnreachable ? 'Provider unavailable. Your Room drafts and saved queue remain local.' : ''});
        if (!this.ready) {
          if (!target || target !== this.room) {this.room = undefined; this.generation++; stopQuery?.(); query?.close(); query = undefined; this.emit({events: []});}
          this.emit({loading: status.lastCompleted === null, error: this.blocker() ?? (status.lastCompleted === null ? null : 'Bind exactly one Calendar Room to this App.')}); return;
        }
        if (this.room === target && query) {render(); return;}
        this.room = target; const generation = ++this.generation;
        stopQuery?.(); query?.close(); query = undefined; this.emit({events: [], loading: true, error: this.blocker()});
        loading = md.observe('query', {...calendarQuery, rooms: [target!]}).then(next => {
          if (this.disposed || generation !== this.generation) {next.close(); return;}
          query = next; stopQuery = next.subscribe(render); render();
        }).catch(error => {if (generation === this.generation) this.emit({loading: false, error: this.blocker() ?? reasonText(error)});});
      };
      this.closers.push(rooms.subscribe(bindings), () => rooms.close(), sync.subscribe(bindings), () => sync.close(), () => {stopQuery?.(); query?.close();});
      bindings();
      const watch = async <T>(promise: Promise<{current(): T; subscribe(fn: (value: T) => void): () => void; close(): void}>, apply: (value: T) => void) => {
        const observation = await promise; if (this.disposed) {observation.close(); return;}
        apply(observation.current()); this.closers.push(observation.subscribe(apply), () => observation.close());
      };
      await Promise.all([
        watch(md.observe('service-mode'), value => this.emit({halted: value === 'write-halted'})),
        watch(md.observe('connection-refusal'), value => {
          const current = value ? `House connection refused: ${value.reason}` : null;
          if (current === this.connectionRefusal) return;
          this.connectionRefusal = current;
          // Only the Runtime's explicit clearance can remove an access refusal.
          // Re-render from current Room/sync/query facts; never infer recovery from connectivity.
          bindings();
        }),
        watch(md.observe('storage-loss'), value => {if (value) {
          // Lost durable data is a separate fact; a later connection recovery cannot erase it.
          this.storageLoss = 'House reports local draft or queue storage loss. Review the Room before continuing.';
          bindings();
        }}),
      ]);
      await loading;
    } catch (error) {if (!this.disposed) this.emit({loading: false, error: this.blocker() ?? reasonText(error)});} finally {clearTimeout(timeout);}
  }
  dispose() {this.disposed = true; this.generation++; this.closers.splice(0).forEach(close => close());}
  private assertRoom(room: string) {
    if (this.disposed || !this.ready || this.room !== room) throw new Error('The original Calendar Room is no longer available.');
    if (this.state.error) throw new Error(this.state.error);
  }
  private async available() {
    await this.start();
    if (!this.md || !this.room || this.state.loading) throw new Error('The Calendar Room is still loading.');
    this.assertRoom(this.room); return {md: this.md, room: this.room};
  }
  async openEditor(initial?: CalendarEvent, proposed: Partial<CalendarEvent> = {}) {
    return this.editor(initial, proposed, false);
  }
  private async editor(initial?: CalendarEvent, proposed: Partial<CalendarEvent> = {}, exactNewIdentity = false, stageEmpty = false) {
    const {md, room} = await this.available();
    const epoch = this.generation;
    const ensure = () => {this.assertRoom(room); if (this.generation !== epoch) throw new Error('The original Calendar Room binding changed. Reopen the editor.');};
    const opened = initial?.[OPENED];
    if (initial && (!opened || opened.room !== room)) throw new Error('Reopen this event from its Room before editing.');
    const pointerKey = `calendar:${room}:new`;
    const presentation = await md.presentation.read();
    const object = presentation && typeof presentation === 'object' ? presentation as Record<string, unknown> : {};
    const pointers = object.calendarDrafts && typeof object.calendarDrafts === 'object' ? object.calendarDrafts as Record<string, string> : {};
    const pointer = !initial && !exactNewIdentity ? pointers[pointerKey] : undefined;
    const held = typeof pointer === 'string' ? await md.roomDraft.read(room, pointer) : null;
    const creation = held?.parts.creation;
    const resumed = creation && 'type' in creation && creation.type === 'calendar_event' ? creation.fields : undefined;
    const now = new Date().toISOString();
    const base: Record<string, unknown> = initial ? {...initial} : resumed ? {...resumed} : {id: exactNewIdentity && proposed.id ? proposed.id : crypto.randomUUID(), title: '', start: '', end: '', createdAt: now, updatedAt: now};
    identity.parse(base.id);
    const path = opened?.path ?? `events/${base.id}.md`;
    if (resumed && pointer !== path) throw new Error('The saved draft pointer does not match its event identity.');
    const visible = () => this.state.events.find(event => event.id === base.id);
    const fieldsOf = (draft: Draft | null): Record<string, unknown> => {
      if (draft?.parts.move || draft?.parts.removal || draft?.parts.markdown) throw new Error('This event has structural draft changes. Review them in House.');
      const creation = draft?.parts.creation;
      if (creation && (!('type' in creation) || creation.type !== 'calendar_event' || creation.fields.id !== base.id)) throw new Error('Another document occupies this draft path.');
      return {...base, ...visible(), ...(creation && 'fields' in creation ? creation.fields : {}), ...Object.fromEntries(Object.entries(draft?.parts.fields ?? {}).map(([key, part]) => [key, part.value]))};
    };
    let hadVisible = Boolean(opened || visible());
    let activeDraft = await md.roomDraft.read(room, path); let fields = fieldsOf(activeDraft);
    let initializing = true;
    let serial = Promise.resolve(); let lastFailure: unknown; let observedFailure: unknown; let observedGeneration = 0; let inputGeneration = 0;
    const pending = new Map<string, {value: unknown; generation: number}>();
    const listeners = new Set<(fields: Record<string, unknown>) => void>();
    const value = () => this.room === room && this.ready && this.generation === epoch ? {...fields, ...Object.fromEntries([...pending].map(([key, item]) => [key, item.value]))} : {};
    const redraw = () => listeners.forEach(listener => listener(value()));
    const observation = await md.observe('room-drafts');
    const accept = (drafts: readonly Draft[]) => {activeDraft = drafts.find(draft => draft.room === room && draft.path === path) ?? null; observedGeneration++; try {fields = fieldsOf(activeDraft); observedFailure = undefined;} catch (error) {observedFailure = error;} redraw();};
    const stop = observation.subscribe(accept); accept(observation.current());
    const stopVisible = this.subscribe(() => {
      if (visible()) hadVisible = true;
      if (this.room !== room || this.generation !== epoch) {pending.clear(); fields = {}; activeDraft = null; observedFailure = new Error('The original Calendar Room is no longer available.');}
      else try {fields = fieldsOf(activeDraft);} catch (error) {observedFailure = error;}
      redraw();
    });
    const write = (patch: Record<string, unknown>, forceDraft = false, requireDraft = false) => {
      try {ensure();} catch (error) {return Promise.reject(error);}
      if (Object.keys(patch).some(key => !editable.includes(key))) return Promise.reject(new Error('Only editable calendar fields may be drafted.'));
      const generation = ++inputGeneration;
      for (const [key, field] of Object.entries(patch)) pending.set(key, {value: field, generation});
      redraw();
      const next = serial.then(async () => {
        ensure();
        let current = await md.roomDraft.read(room, path);
        for (;;) {
          ensure(); if (hadVisible && !visible()) throw new Error('This event was removed from its Room.');
          if (requireDraft && !current) throw new Error('Part of this scoped edit was saved or discarded elsewhere. Review the remaining Room drafts in House.');
          if (initializing && exactNewIdentity && stageEmpty && visible()) throw new Error('A new occurrence collides with an existing event.');
          // A simultaneous scoped opener may have created this exact business draft.
          // Initial donor defaults must never overwrite its newer raw fields.
          if (initializing && exactNewIdentity && stageEmpty && current?.parts.creation) {
            activeDraft = current; fields = fieldsOf(current); pending.clear(); redraw(); return;
          }
          const flushing = new Map(pending);
          const currentDocument = visible()?.[OPENED] ?? opened;
          if (initializing && stageEmpty && currentDocument) {
            for (const key of recurrenceFields) {
              const expected = key in proposed ? proposed[key as keyof CalendarEvent] : currentDocument.fields?.[key];
              if (current?.parts.fields?.[key] && !same(current.parts.fields[key].value, expected)) throw new Error('Related recurrence metadata has an unfinished draft from another scope. Review it in House.');
            }
          }
          if (!flushing.size && (currentDocument || current) && !forceDraft) return;
          fieldsOf(current);
          const latest: Record<string, unknown> = {...Object.fromEntries([...flushing].map(([key, item]) => [key, item.value])), updatedAt: new Date().toISOString()};
          const parts: Parts = currentDocument && !current?.parts.creation ? {...current?.parts, fields: {...current?.parts.fields,
            ...Object.fromEntries(Object.entries(latest).map(([key, field]) => [key, {value: field, base: current?.parts.fields?.[key] ? current.parts.fields[key].base : key in (currentDocument.fields ?? {}) ? {value: currentDocument.fields?.[key]} : null}])),
          }} : {...current?.parts, creation: {type: 'calendar_event', fields: {...fieldsOf(current), ...latest}, sections: current?.parts.creation && 'sections' in current.parts.creation ? current.parts.creation.sections : {}}, ...(current?.parts.fields ? {fields: Object.fromEntries(Object.entries(current.parts.fields).map(([key, part]) => [key, key in latest ? {...part, value: latest[key]} : part]))} : {})};
          const answer = await md.roomDraft.write(room, path, current?.revision ?? null, parts);
          if (answer.outcome === 'stale') {current = await md.roomDraft.read(room, path); continue;}
          for (;;) {const before = observedGeneration; const latestDraft = await md.roomDraft.read(room, path); if (before !== observedGeneration) continue; activeDraft = latestDraft; fields = fieldsOf(latestDraft); break;}
          for (const [key, item] of flushing) if (pending.get(key)?.generation === item.generation) pending.delete(key);
          lastFailure = undefined; redraw();
          if (!opened && !exactNewIdentity) {
            const currentState = await md.presentation.read(); const state = currentState && typeof currentState === 'object' ? currentState as Record<string, unknown> : {};
            const previous = state.calendarDrafts && typeof state.calendarDrafts === 'object' ? state.calendarDrafts as Record<string, unknown> : {};
            await md.presentation.write({...state, calendarDrafts: {...previous, [pointerKey]: path}});
          }
          return;
        }
      });
      serial = next.catch(error => {lastFailure = error; redraw();}); return next;
    };
    const selection = async () => {
      await serial; if (lastFailure) throw lastFailure; ensure();
      const draft = await md.roomDraft.read(room, path); eventSchema.parse(fieldsOf(draft));
      if (hadVisible && !visible()) throw new Error('This event was removed from its Room.');
      return draft ? {path, revision: draft.revision} : null;
    };
    const session = {
      path, value, write, writeExisting: (patch: Record<string, unknown>) => write(patch, false, true), selection,
      error: () => observedFailure ? reasonText(observedFailure) : lastFailure ? reasonText(lastFailure) : undefined,
      subscribe(listener: (fields: Record<string, unknown>) => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
      close() {stop(); stopVisible(); observation.close(); listeners.clear();},
      commit: async () => {const draft = await selection(); if (draft) await this.save(room, [draft]);},
    };
    const patch = Object.fromEntries(Object.entries((resumed && !exactNewIdentity) || (exactNewIdentity && stageEmpty && activeDraft?.parts.creation) ? {} : proposed).filter(([key, field]) => editable.includes(key) && field !== undefined && (!opened || !same(field, opened.fields?.[key])) && !same(field, value()[key])));
    // A new blank editor is itself a durable business creation draft.
    try {if (Object.keys(patch).length || (!opened && !activeDraft) || (stageEmpty && !activeDraft)) await write(patch, stageEmpty);} catch (error) {session.close(); throw error;} finally {initializing = false;}
    return session;
  }
  private async save(room: string, selections: {path: string; revision: string}[]) {
    if (this.state.busy) throw new Error('A save is already in progress.');
    this.assertRoom(room); this.emit({busy: true});
    try {
      // A provider write halt is informational: native Save still queues locally.
      const answer = await this.md!.save(room, selections);
      if (answer.outcome !== 'saved') throw new Error(`House refused Save (${answer.outcome}${'rule' in answer ? `: ${answer.rule}` : ''}). Your Room drafts are retained.`);
      if (this.room === room && this.ready) this.read(await this.md!.query({...calendarQuery, rooms: [room]}));
    } finally {this.emit({busy: false});}
  }
  async openMutationEditor(change: {added: CalendarEvent[]; updated: CalendarEvent[]; deleted: CalendarEvent[]}, editableId?: string, resumeKey?: string) {
    const {md, room} = await this.available();
    const epoch = this.generation;
    const ensure = () => {this.assertRoom(room); if (this.generation !== epoch) throw new Error('The original Calendar Room binding changed. Reopen the calendar.');};
    const sessions: EditorSession[] = []; let editor: EditorSession | undefined; const removals: {path: string; revision: string}[] = [];
    const relatedMetadata = new Map<string, Record<string, unknown>>();
    const validate = async () => {
      ensure(); const selections = (await Promise.all(sessions.map(session => session.selection()))).filter((selection): selection is {path: string; revision: string} => Boolean(selection));
      if (resumeKey && selections.length !== sessions.length) throw new Error('Part of this scoped edit was saved or discarded elsewhere. Review the remaining Room drafts in House.');
      for (const [path, expected] of relatedMetadata) {
        const draft = await md.roomDraft.read(room, path); ensure();
        const visible = this.state.events.find(event => event[OPENED]?.path === path);
        const fields = {...visible, ...Object.fromEntries(Object.entries(draft?.parts.fields ?? {}).map(([key, part]) => [key, part.value]))};
        if (recurrenceFields.some(key => !same(fields[key as keyof typeof fields], expected[key]))) throw new Error('Related recurrence metadata changed in another editor. Review the scoped Room drafts in House.');
      }
      for (const removal of removals) {const draft = await md.roomDraft.read(room, removal.path); ensure(); if (draft?.revision !== removal.revision) throw new Error('A removal draft changed. Review it in House.');}
      ensure(); return [...selections, ...removals];
    };
    const finish = () => ({count: sessions.length + removals.length, removedCount: removals.length, ...(editor ? {editor} : {}), close: () => sessions.forEach(session => session.close()), validate, commit: async () => {
      const selections = await validate();
      if (selections.length) await this.save(room, selections);
    }});
    const ids = [...change.added, ...change.updated, ...change.deleted].map(event => String(event.id));
    if (new Set(ids).size !== ids.length) throw new Error('Calendar mutation contains duplicate identities.');
    if (editableId !== undefined && ![...change.updated, ...change.added].some(event => String(event.id) === editableId)) throw new Error('The editable event is not part of this Calendar mutation.');
    if (resumeKey !== undefined && (!editableId || !resumeKey || resumeKey.length > 1000)) throw new Error('A scoped edit needs a valid target and scope identity.');
    const pointerKey = resumeKey ? `${room}:${resumeKey}` : undefined;
    try {
      if (pointerKey) {
        const presentation = await md.presentation.read(); ensure();
        const state = presentation && typeof presentation === 'object' ? presentation as Record<string, unknown> : {};
        const pointers = state.calendarScopedDrafts && typeof state.calendarScopedDrafts === 'object' ? state.calendarScopedDrafts as Record<string, unknown> : {};
        const affected = [...change.updated, ...change.deleted].map(event => this.state.events.find(row => row.id === event.id)?.[OPENED]?.path).concat(change.added.map(event => `events/${event.id}.md`));
        for (const [key, value] of Object.entries(pointers)) {
          if (key === pointerKey || !key.startsWith(`${room}:`) || !value || typeof value !== 'object') continue;
          const paths = (value as {paths?: unknown}).paths;
          if (!Array.isArray(paths)) continue;
          const overlap = paths.filter((path): path is string => typeof path === 'string' && affected.includes(path));
          if ((await Promise.all(overlap.map(path => md.roomDraft.read(room, path)))).some(Boolean)) throw new Error('Another scoped edit already has unfinished drafts for these events. Finish or review it in House first.');
          ensure();
        }
        const pointer = pointers[pointerKey];
        if (Object.hasOwn(pointers, pointerKey)) {
          if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) || Object.keys(pointer).sort().join(',') !== 'editablePath,paths') throw new Error('The scoped draft pointer is invalid. Review the Room drafts in House.');
          const {paths, editablePath} = pointer as {paths?: unknown; editablePath?: unknown};
          if (!Array.isArray(paths) || !paths.length || !paths.every(path => typeof path === 'string' && (/^events\/[a-zA-Z0-9_.-]+\.md$/.test(path) || this.state.events.some(event => event[OPENED]?.path === path))) || new Set(paths).size !== paths.length || typeof editablePath !== 'string' || !paths.includes(editablePath)) throw new Error('The scoped draft pointer is invalid. Review the Room drafts in House.');
          const held = await Promise.all((paths as string[]).map(path => md.roomDraft.read(room, path))); ensure();
          if (held.some(Boolean)) {
            if (held.some(draft => !draft)) throw new Error('Part of this scoped edit was saved or discarded elsewhere. Review the remaining Room drafts in House.');
            for (const draft of held as Draft[]) {
              ensure();
              if (draft.parts.removal) {
                if (!this.state.events.some(event => event[OPENED]?.path === draft.path)) throw new Error('A scoped removal no longer has its original event. Review it in House.');
                removals.push({path: draft.path, revision: draft.revision}); continue;
              }
              let session: EditorSession;
              if (draft.parts.creation) {
                const creation = draft.parts.creation;
                if (!('type' in creation) || creation.type !== 'calendar_event' || `events/${creation.fields.id}.md` !== draft.path) throw new Error('The scoped creation no longer matches its event.');
                // Read the real creation draft; the new donor timestamp ID and defaults are ignored.
                session = await this.editor(undefined, {id: String(creation.fields.id)}, true);
              } else {
                const original = this.state.events.find(event => event[OPENED]?.path === draft.path);
                if (!original) throw new Error('A scoped event no longer exists. Review its draft in House.');
                session = await this.editor(original);
              }
              sessions.push(session); if (session.path === editablePath) editor = session;
              else relatedMetadata.set(session.path, Object.fromEntries(recurrenceFields.map(key => [key, session.value()[key]])));
            }
            ensure(); if (!editor) throw new Error('The scoped editable event is no longer available.');
            return finish();
          }
          // All named drafts disappeared after Save/discard or actual reach loss.
          // A pointer never restores business content and does not imply a surviving draft.
        }
      }
      for (const event of change.updated) {
        ensure();
        const original = this.state.events.find(row => row.id === String(event.id));
        if (!original) throw new Error('The changed series no longer exists. Reopen the calendar.');
        if (pointerKey) {
          const held = await md.roomDraft.read(room, original[OPENED]!.path); ensure();
          for (const key of recurrenceFields) {
            const proposed = event[key as keyof CalendarEvent];
            if (held?.parts.fields?.[key] && !same(held.parts.fields[key].value, proposed)) throw new Error('Related recurrence metadata has an unfinished draft from another scope. Review it in House.');
          }
        }
        const session = await this.editor(original, event, false, Boolean(pointerKey)); sessions.push(session);
        if (String(event.id) === editableId) editor = session;
        else if (pointerKey) relatedMetadata.set(session.path, Object.fromEntries(recurrenceFields.map(key => [key, session.value()[key]])));
      }
      for (const event of change.added) {
        ensure();
        if (this.state.events.some(row => row.id === String(event.id))) throw new Error('A new occurrence collides with an existing event.');
        const session = await this.editor(undefined, event, true, Boolean(pointerKey)); sessions.push(session);
        if (String(event.id) === editableId) editor = session;
      }
      for (const event of change.deleted) {
        ensure();
        const original = this.state.events.find(row => row.id === String(event.id)); const opened = original?.[OPENED];
        if (!opened?.markdown) throw new Error('The removed occurrence no longer exists.');
        const current = await md.roomDraft.read(room, opened.path);
        ensure();
        if (current) throw new Error('An occurrence being removed has an unfinished Room draft. Review it in House.');
        const answer = await md.roomDraft.write(room, opened.path, null, {removal: {base: opened.markdown}});
        ensure();
        if (answer.outcome !== 'written' || !answer.roomDraft) throw new Error('The occurrence draft changed. Review it in House.');
        removals.push({path: opened.path, revision: answer.roomDraft.revision});
      }
      ensure();
      if (pointerKey && editor) {
        const presentation = await md.presentation.read(); ensure();
        const state = presentation && typeof presentation === 'object' ? presentation as Record<string, unknown> : {};
        const pointers = state.calendarScopedDrafts && typeof state.calendarScopedDrafts === 'object' ? state.calendarScopedDrafts as Record<string, unknown> : {};
        // Presentation holds only native path references; all field content and bases stay in Room Drafts.
        await md.presentation.write({...state, calendarScopedDrafts: {...pointers, [pointerKey]: {paths: [...sessions.map(session => session.path), ...removals.map(removal => removal.path)], editablePath: editor.path}}});
        ensure();
      }
      return finish();
    } catch (error) {sessions.forEach(session => session.close()); throw error;}
  }
}
export type EditorSession = Awaited<ReturnType<HouseDataStore['openEditor']>>;
export type MutationSession = Awaited<ReturnType<HouseDataStore['openMutationEditor']>>;
export const dataStore = new HouseDataStore();
