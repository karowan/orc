# Publishing orc to npm

All nine packages publish publicly under the `@karowanorg/orc-*` scope from this
workspace. Entry points are built (`dist/`); `files` whitelists keep tarballs
lean; interdeps are pinned `^0.1.1`.

## One-time setup

`npm login` as a member of the `karowanorg` org (packages publish under
`@karowanorg/orc-*`; `publishConfig.access: public` is set per package).

## Publish

```sh
npm run test          # tsc -b && vitest run — must be green
npm run release       # tsc -b && npm publish --workspaces (access is public via publishConfig)
```

Then publish orc-review (see its PUBLISHING.md) — it depends on these
packages at `^0.1.1`.

## Versioning

Manual for now: bump the version in each changed package plus anything
depending on it (interdeps are `^0.1.1`, so patch/minor bumps flow without
edits), rebuild, `npm run release`.

## Invariants to keep

- `@karowanorg/orc-ops` must stay externalizable: the detached supervisor resolves its
  own entry file (`dist/ops.js` → `dist/supervisor-entry.js`). Never bundle
  ops into a consumer.
- No deep `@karowanorg/orc-*/src/...` imports — the `exports` maps only expose package
  roots (plus `@karowanorg/orc-sdk/program`).
