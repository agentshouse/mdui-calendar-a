# Calendar

A Room-backed calendar with month, week, day and year views, recurring events, and explicit Draft/Save editing.

Use Node.js 24 and npm. Run `npm ci --no-audit`, then `npm run verify` to typecheck, lint, test, validate the starter, build, and check assets, provenance and licenses. Run `npm run dev` for development inside a compatible host.

`starter/events/` contains three unchanged licensed example documents, including a recurring series, with dates anchored in October 2026. Import them only when desired into a Room using `schema.yaml`; the App never seeds data automatically. Source and dependency notices are retained in `LICENSE`, `licenses/`, and `public/THIRD_PARTY_NOTICES.txt`.

To publish, configure the existing authenticated House App Git origin, commit reviewed changes on `main`, and run `npm run publish`. It requires clean exact-source verification and atomically publishes source and a parentless built release. Verify the advertised source and House admission afterward; an uncertain result requires inspection before retrying. GitHub copying is separate.

Recurring edits offer this occurrence, following events, or the whole series. Explicit Save queues the selected batch; closing retains native Room Drafts. Whole-series edits clear exceptions, and following edits split the series. Repeated split-ID collisions are refused. Local checks do not replace hosted browser acceptance.
