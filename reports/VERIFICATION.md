# Local verification

Calendar adapts ilamy-calendar revision 04e34d17cb6db097c034bba04655353bcc38fe7c. All 164 vendored source files match that pinned source byte-for-byte. Source mappings and hashes are in vendor-provenance.json; the check runs with release validation.

Passing local gates:

- Strict TypeScript over application, vendored source and test code
- ESLint over the integration source
- 138 tests: 57 Room boundary, 5 editable batch, 32 scoped resume, 7 scoped-conflict, 31 shell/DOM, and 6 donor-data/schema tests
- Production eager single-JavaScript build
- Static security/assets/schema/provenance/release-size audit
- Complete notices for the installed 102-package production dependency closure, with two documented upstream supplements

Runtime recovery tests verify that only explicit clearance of a connection refusal re-evaluates latest Room/sync/query readiness, preserving mounted input; active denial and genuine storage loss remain blocking.

The draft tests cover raw partial fields, reload/reopen hydration, new creation lifecycle, live shared drafts, overlapping later-input-wins CAS, first bases, disjoint fields/sections/preamble, explicit Save, refusal retention, queued Save during provider halt/unavailability, initial sync, binding removal, and atomic recurrence-related add/update/remove mutations. DOM tests cover async form lifecycle, error retention, donor This/Following/All form choices, scope Cancel, stored override identity, native rule retention, All anchor normalization, missing-bundle refusal, navigation preservation, and staged drag changes requiring explicit Save. Scoped tests cover path-reference-only resume, raw invalid fields, deterministic same-occurrence concurrent creation, initialization CAS conflict handling, original bases/sections, newer edits during refused Save, and Discovery cleanup. Different unfinished scopes cannot silently mix a following cutoff with another scope's creation. Data tests independently reconstruct all 23 seed records and validate actual schema serialization.

Toolchain note: the installed SDK advertises Node >=24.21.0; the execution environment has Node 24.19.0. The stated checks pass on the available environment. The shipped App is browser code; no Node process is deployed by this release.

Not claimed: hosted desktop or 360px visual acceptance, hosted pointer drag operation, offline reload, real multi-tab coordination, or hosted network capture. These remain browser acceptance checks for the parent after the dev gate is available. Local boundary mocks do not prove Provider or host acceptance.
