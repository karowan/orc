# Publishing orc to npm

All nine packages publish publicly under the `@orc/*` scope from this
workspace. Entry points are built (`dist/`); `files` whitelists keep tarballs
lean; interdeps are pinned `^0.1.0`.

## One-time setup

1. `npm login`
2. The `@orc` scope must be yours. Check/claim: `npm org ls orc` — if it
   doesn't exist, create the org at npmjs.com/org/create (name `orc`). If the
   name is taken, pick a scope you own and rewrite in one pass:

   ```sh
   # e.g. NEW=@karowan; updates package names + interdeps everywhere
   grep -rl '@orc/' packages/*/package.json packages/*/src packages/*/test \
     ../orc-review/src ../orc-review/test ../orc-review/package.json \
     | xargs sed -i '' "s|@orc/|${NEW}/|g"
   ```

## Publish

```sh
npm run test          # tsc -b && vitest run — must be green
npm run release       # tsc -b && npm publish --workspaces (access is public via publishConfig)
```

Then publish orc-review (see its PUBLISHING.md) — it depends on these
packages at `^0.1.0`.

## Versioning

Manual for now: bump the version in each changed package plus anything
depending on it (interdeps are `^0.1.0`, so patch/minor bumps flow without
edits), rebuild, `npm run release`.

## Invariants to keep

- `@orc/ops` must stay externalizable: the detached supervisor resolves its
  own entry file (`dist/ops.js` → `dist/supervisor-entry.js`). Never bundle
  ops into a consumer.
- No deep `@orc/*/src/...` imports — the `exports` maps only expose package
  roots (plus `@orc/sdk/program`).
