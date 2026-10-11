# Recovery and recurring form edits

## Runtime-owned recovery facts

The first release incorrectly reused one latched error for both connection refusal and storage loss. A non-null `connection-refusal` set it, and a later null observation could never clear it. Initial empty Room reach was already gated by `sync-status.lastCompleted` and was not this defect.

The correction separates the current observed connection refusal from the persistent storage-loss fact. Only an explicit null from the Runtime clears a previous connection refusal. The App then re-evaluates the latest Room, first-sync and local-query observations; a healthy sync alone cannot override an active denial. An invalid query or absent binding remains an error. Existing native editors keep their sessions and exact draft input while the continuously discovered Room remains available. No App-driven reauthorization or credential handling is introduced.

The installed Runtime's refusal reasons are `missing-required-guarantee` and `revoked-authorization`. Provider unavailability is reported separately by sync status; it does not prevent local drafting or native Save. A real storage-loss report remains visible and blocking independently of subsequent connection recovery. Returned drafts, changed-underneath refusal, active denial, and Discovery removal retain their existing handling. Discovery removal invalidates the old editor and destroys native Room draft/queue state under the host contract; no off-Room recovery is created.

## Recurring click edits

The first release mapped a generated occurrence directly to its master for editing. That differed from the donor form, which asks which occurrences a recurring edit should affect. The corrected shell uses the unchanged recurrence plugin's scope UI and mutation algorithms.

Scope is chosen before the custom business-field editor opens, so typing can go directly into the affected real event document's native Room Draft. Cancel before choosing a scope stages nothing. After choosing a scope, the donor's related master updates, added event and possible removals become a single batch of native drafts. The form exposes their effect and still requires explicit Save; closing retains drafts. Reopen the same occurrence and choose the same scope to hydrate the actual native bundle, including incomplete fields.

- This event: create a detached override for a generated occurrence, or update the exact stored override; preserve its original recurrence ID and update the master's EXDATE/UID when required.
- This and following: terminate the original series before the selected occurrence, create a following master, and potentially remove later detached overrides. The original cutoff remains based on the selected occurrence, even when the following master's new start changes. The new series inherits the donor rule fields and EXDATEs; a COUNT is not recalculated by the pinned algorithm.
- All events: retain the master's original calendar-date anchor while applying edited time and duration through the donor algorithm; clear EXDATEs and remove detached overrides. Previously excluded occurrences may reappear. Invalid raw input is validated before date normalization, so the form cannot silently replace a partial date with a valid one.

New This override creations use an adapter-owned deterministic business ID derived from series UID and original recurrence identity. This lets simultaneous tabs target the same native creation draft; it does not alter recurrence rules, exception semantics, or IDs of stored overrides. Donor source files stay byte-identical.

Runtime Presentation remembers only the Room/scope-to-path association and editable path. It contains no field values, draft bases, sections, revisions, or recovery copy. Resume reads every actual native draft and refuses a partly missing bundle rather than regenerating it. When all named drafts are gone, no old business data is restored. CAS merges and resume preserve original bases and disjoint sections/preamble.

A different pending scope that overlaps the same event documents is refused before reuse; conflicting recurrence metadata is also checked on every native initialization CAS retry. Finish or review the existing scope first. The noneditable related master metadata is checked before commit. Whole-bundle validation and a retained-draft-only normalization write prevent All Save from recreating a primary that another tab saved or discarded. Existing native repeat-rule fields are retained during All date normalization; no rule-editing UI is introduced.

The whole selected bundle is saved atomically. Removal staging refuses an event that already has an unfinished native draft. The fixed donor `_following` ID can collide on a repeated split of the same original series; the store refuses the collision rather than overwriting an existing event.

These controls do not introduce a recurrence-rule editor, repeat presets, standalone Delete, resize handles, import/export, resource scheduling, or a generic drag-batch resume UI. Scoped form drafts can be resumed as described above; unfinished drag batches remain available for House review. Hosted destructive cases still require the appropriate testing scope; having no Delete button does not remove the deletion effects of following/all scopes.

## Verification boundaries

Focused local tests cover explicit refusal clearance, readiness, mounted raw drafts, active-denial priority, persistent storage loss, native Save refusals, scope choices, ordinary/override edits, Cancel, and atomic editable batches. Local mocks and DOM tests do not establish hosted browser acceptance. No browser/auth workaround, Room schema/data change, or binding expansion accompanies this correction.
