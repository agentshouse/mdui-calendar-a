# Calendar donor demo

This Room contains the complete licensed ilamy-calendar playground sample: 23 stored event records (21 one-offs and two recurring series). Recurring occurrences are expanded by the calendar and are not additional seed records.

Source: https://github.com/kcsujeet/ilamy-calendar/blob/04e34d17cb6db097c034bba04655353bcc38fe7c/packages/playground/src/lib/seed.ts

License: MIT, Copyright (c) 2025 Sujeet Kc. The complete license is included with the Calendar app.

All source dayjs() calls are frozen at 2026-10-11T00:00:00.000Z in UTC. Titles, descriptions, colors, IDs, all-day flags, durations, recurrence intervals, and weekdays retain the donor values. Dates remain relative to that October 2026 reference. The source title and description for the PST example are preserved verbatim; this reproducible seed is anchored in UTC and does not introduce a separate America/Los_Angeles timezone.

The imported event timestamps createdAt and updatedAt both use the same frozen reference. These are provenance metadata, not claims about the donor author's editing time.

Each event is a calendar_event document in events/. Editing or deleting an event changes its Room document through the MD Runtime. This README is untyped documentation, not a calendar event.
