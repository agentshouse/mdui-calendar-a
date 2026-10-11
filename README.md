# Calendar

An ordinary House Calendar App adapted from [ilamy-calendar](https://github.com/kcsujeet/ilamy-calendar/tree/04e34d17cb6db097c034bba04655353bcc38fe7c), under MIT © 2025 Sujeet Kc.

The thin shell retains the pinned calendar's month/week/day/year views and recurrence-aware drag-and-drop. All 23 original seed records are preserved as typed Room documents with the UTC reference frozen to October 11, 2026. Read `docs/DONOR_DATA.md` and `samples/PROVENANCE.json` for exact provenance and reproducible adaptation.

## Use

Open inside House with the Calendar Room bound. Click a day/time to create an event or an event to edit. Business fields are staged in native Room Drafts as typed, including incomplete inputs. Save event validates and queues the change. Closing keeps the draft. Reopening New resumes its existing creation draft.

Clicking a recurring occurrence first opens the donor's choice of this occurrence, following events, or the full series. Cancel stages nothing. The chosen scope opens its real business-document draft; explicit Save commits its complete related batch. Closing retains drafts; choosing the same occurrence and scope resumes the native draft bundle. Dragging uses the donor's same scope choices and requires Save changes. All-series edits preserve the original series date anchor and clear exceptions, including detached overrides; following edits may remove later overrides. The form describes these effects. Read `docs/RECOVERY_AND_RECURRENCE.md` for exact semantics and limitations. The App never silently discards drafts or retries a rejected Save.

All reads are from the Room replica. Local drafting and explicit Save remain available when the Provider is unavailable or has paused writes; saved batches wait in the host queue. Explicit Runtime clearance of a connection refusal re-evaluates current Room/sync/query readiness without losing held input; actual storage loss remains visible and blocking. The App does not use Provider Actions, browser business-data stores, external endpoints, or auto-seeding.

## Development and checks

- `npm ci --no-audit`
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run release:check`
- `node scripts/generate-notices.mjs --check`

`node scripts/build-demo.mjs` rebuilds local fixtures and a create-only payload. It never writes to House. Operator Room setup and publication are separate.

Local boundary/DOM checks do not claim hosted browser acceptance. The parentless built release is served from its root; source and built commits remain separate.
