# Calendar

Events in month, week and day views.

An [agents.house](https://agents.house) Template: an App over one Room. `schema.yaml` is
the Room's schema, `starter/` holds the documents a new Room starts with and `demo/` the
documents of its demo Site.

## Build

```sh
npm ci
npm run build
```

## Publish

Commit your change, then run `npm run publish`. It builds, then pushes `main` and the build,
as one new commit without parents on `release`, to `origin`.

## License

See the license files beside this README.
