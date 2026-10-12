# Calendar

A Room-backed calendar with month, week, day and year views, recurring events, and explicit Draft/Save editing.

Use Node.js 24 and npm. Run `npm ci --no-audit`, then `npm run verify` to typecheck, lint, test, validate the starter, build, and check assets, provenance and licenses. Run `npm run dev` for development inside a compatible host.

`starter/events/` contains three unchanged licensed example documents, including a recurring series, with dates anchored in October 2026. Import them only when desired into a Room using `schema.yaml`; the App never seeds data automatically. Source and dependency notices are retained in `LICENSE`, `licenses/`, and `public/THIRD_PARTY_NOTICES.txt`.

To publish, configure the existing authenticated House App Git origin, commit reviewed changes on `main`, and run `npm run publish`. It requires clean exact-source verification and atomically publishes source and a parentless built release. Verify the advertised source and House admission afterward; an uncertain result requires inspection before retrying. GitHub copying is separate.

Recurring edits offer this occurrence, following events, or the whole series. Explicit Save queues the selected batch; closing retains native Room Drafts. Whole-series edits clear exceptions, and following edits split the series. Repeated split-ID collisions are refused. Local checks do not replace hosted browser acceptance.

## Portable publisher safety

The publisher accepts credential-free HTTPS House App remotes on any host, including
`https://<host>/app/new.git` for creation. Choose only a host and App you are authorized
to publish to. Host portability does not authorize publication to another environment.
For initial creation, use `npm run publish -- --name "<display name>"`; `--name` is
optional and no default display name is invented. The helper reports only complete,
explicitly returned App/Git receipt URLs and never changes `origin`. After creation,
inspect the returned canonical App in House and set its actual Git URL as `origin`
before another publication. Never retry an uncertain creation blindly.

`npm run test:publisher` runs offline local-Git regression fixtures with mocked
push/remote transport; it installs no packages and does not contact House. These
checks are included in `npm run verify` before the existing App-specific gates.
Publication requires clean committed `main`, runs exactly that full verify gate,
pins the source SHA, and atomically pushes source `main` plus a parentless dist-only
`release`. It preserves the normal index and source branch, rejects unsafe origin
rewrites, index flags, metadata mismatches, and conflicting publisher/worktree locks.
It never commits source, resets work, or substitutes a build-only verification.

Failure diagnostics suppress arbitrary subprocess output to avoid leaking credentials.
Run `npm run verify` locally for full compiler/test output; never share credential
values or verbose HTTP traces. A reported creation receipt or advertised source SHA
does not prove release admission: inspect the known App's published revision in House.
After a failed or uncertain push, inspect that state before deciding whether to retry.
