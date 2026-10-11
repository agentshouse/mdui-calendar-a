# Complete Calendar donor seed

## Source and license

The Calendar demo is the complete `dummyEvents` array from [ilamy-calendar's playground seed](https://github.com/kcsujeet/ilamy-calendar/blob/04e34d17cb6db097c034bba04655353bcc38fe7c/packages/playground/src/lib/seed.ts), pinned to commit `04e34d17cb6db097c034bba04655353bcc38fe7c`.

- Original source path: `packages/playground/src/lib/seed.ts`
- Exact, unmodified local source copy: `samples/donor/seed.ts`
- Source SHA-256: `f8ea1a952d2ca285c5e7849af3bd156699b7fece5702c34d9a99f57e71255233`
- License: [MIT](https://github.com/kcsujeet/ilamy-calendar/blob/04e34d17cb6db097c034bba04655353bcc38fe7c/LICENSE), **Copyright (c) 2025 Sujeet Kc**
- Exact license copies: `LICENSE` and `samples/donor/LICENSE`
- License SHA-256: `a0196423e884b263ca15b4ea52983f40bd0da3c193e0a66485e8c74075a9c286`

The MIT notice is retained intact. No replacement sample titles, descriptions, or events were authored. `calendar-readme.md`, Room metadata, and this provenance documentation are port additions.

## Deterministic transform

Run from the Calendar directory after installing the locked dependencies:

```sh
node scripts/build-demo.mjs
npm test -- test/donor-data.test.ts
```

The build script first checks the raw source and license hashes. It strips only the source's two import statements and export keyword, then evaluates the reviewed, hash-pinned local fixture with the installed Day.js and RRule implementations. Every no-argument `dayjs()` receives **2026-10-11T00:00:00.000Z**, explicitly in **UTC**. The host clock and host timezone cannot shift the result.

1. Preserve all **23** source records, in source order, with their exact string IDs. There are **21 one-offs**, **2 recurring series**, and **5 all-day records**. No recurrence instances are materialized as extra stored events.
2. Preserve every title, description, `backgroundColor`, `color`, optional-field presence, and `allDay` boolean. Missing donor descriptions, colors, or `allDay` fields remain absent.
3. Serialize `start`, `end`, and recurrence `dtstart` with `toISOString()`. The source's inclusive `endOf('day')` values remain `23:59:59.999Z`; they are not changed to exclusive end dates.
4. Preserve each recurrence rule's frequency, interval, and empty exception array. RRule `WEEKLY` is numeric `2`. Convert weekday instances to their numeric RRule weekday: Monday `0` through Sunday `6`. A weekday with an ordinal remains `{weekday, n}`. The seed uses only ordinary weekdays.
5. Add required `createdAt` and `updatedAt` metadata, both equal to the frozen reference instant. These record import provenance, not donor edit history.

`baseDate` therefore becomes October 1, 2026. The two series remain: Daily Standup on Monday–Friday from October 1 at 10:00 UTC, and PST Evening Sync (UTC Boundary) on Wednesday from October 7 at 16:00 UTC. Morning Yoga Class uses the direct frozen `dayjs()` call and begins October 11 at 10:00 UTC. The donor's PST title and description are preserved verbatim; freezing in UTC does not add an America/Los_Angeles timezone or rewrite that example's wall-clock fields.

## Files and publication boundary

- `samples/events.json`: all 23 normalized event objects, with no added `type` field.
- `samples/events/{id}.md`: one typed `calendar_event` Markdown document per source event, with JSON-compatible YAML scalar/object/array values.
- `samples/sample-documents.json`: the same event fields with relative document paths and types for test/runtime harnesses.
- `samples/calendar-readme.md`: untyped documentation for the demo Room.
- `samples/PROVENANCE.json`: machine-readable source URLs, hashes, transform, reference instant, counts, and generated-events hash.
- `/tmp/port-publication/calendar-payload.json`: 24 **create-only** operations for `/rooms/calendar-port/events/{id}.md` and `/rooms/calendar-port/calendar-readme.md`.

The script is local and has no House client, authentication, network requests, Room creation, or publish calls. Set `CALENDAR_PAYLOAD_PATH` to place the review payload elsewhere. Publishing the payload is a separately authorized step; pre-existing Room records must never be overwritten by the demo import.

## Schema and independent checks

`schema.yaml` uses the MD Model's supported JSON Schema subset for nested objects, booleans, arrays, ISO date-time strings, integer weekdays, and ordinal weekday objects. In addition to seed fields, it allows the donor recurrence editor's `uid`, `recurrenceId`, exception dates, standard public RRule filters, `count`, and `until`. Explicit null is accepted for cleared `uid`, `recurrenceId`, and `rrule` fields; absent seed fields remain absent. This lets per-occurrence edits persist without flattening a recurring series. UI-only instance state is not part of the schema.

The donor-data tests independently reconstruct every source expression using a small immutable UTC `Date` implementation, rather than importing the generator's Day.js transform or normalizer. They compare all fields of every normalized record, verify byte-identical source/license hashes, validate every Markdown document against the real MD Model, check invalid values are refused, and compare recurrence occurrences for the two real RRule series. Snapshot hashes alone are not treated as semantic verification.
