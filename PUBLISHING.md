# Publishing orc to npm

All nine packages publish publicly under the `@karowanorg/orc-*` scope from this
workspace. Entry points are built (`dist/`); `files` whitelists keep tarballs
lean; interdeps are pinned `^0.1.1`.

## One-time setup

`npm login` as a member of the `karowanorg` org (packages publish under
`@karowanorg/orc-*`; `publishConfig.access: public` is set per package).

## Publish

CI publishes. Bump the version of each changed package (plus anything that
depends on it) in a PR; when it merges to `main`, the `publish` workflow
(`.github/workflows/publish.yml`):

1. compares every workspace's version with the registry
   (`node scripts/publish-changed.mjs --plan`),
2. if any version is new, runs `npm test` (`tsc -b && vitest run`),
3. publishes the new ones in dependency order with provenance attestations.

Re-running is safe: versions already on the registry are skipped, so a run
that failed halfway just picks up the rest. Trigger it by hand from the
Actions tab (`workflow_dispatch`) if a push was missed.

Auth is npm trusted publishing: the workflow presents its GitHub OIDC token
and npm mints a short-lived publish credential, so no token is stored
anywhere. One-time setup, per package, at
`https://www.npmjs.com/package/<name>/access`:

- Trusted Publisher → GitHub Actions
- Organization or user: `karowan`; Repository: `orc`;
  Workflow filename: `publish.yml`; Environment: leave blank
- Then set Publishing access to "Require two-factor authentication and
  disallow tokens" so trusted publishing is the only publish path.

Do this for all nine `@karowanorg/orc-*` packages. A new package must be
published once by hand (`npm publish` from a logged-in machine) before it can
be given a trusted publisher.

Manual fallback from a logged-in machine (`npm login` first; same skip logic, no provenance):

```sh
npm run test          # tsc -b && vitest run — must be green
npm run release       # tsc -b && node scripts/publish-changed.mjs
```

Then publish orc-review (see its PUBLISHING.md) — it depends on these
packages at `^0.1.1`.

## Versioning

Manual: bump the version in each changed package plus anything depending on
it (interdeps are `^0.1.1`, so patch/minor bumps flow without edits) in the
same PR as the change, or in a `release:` PR afterwards. Merging publishes.

## Invariants to keep

- `@karowanorg/orc-ops` must stay externalizable: the detached supervisor resolves its
  own entry file (`dist/ops.js` → `dist/supervisor-entry.js`). Never bundle
  ops into a consumer.
- No deep `@karowanorg/orc-*/src/...` imports — the `exports` maps only expose package
  roots (plus `@karowanorg/orc-sdk/program`).
