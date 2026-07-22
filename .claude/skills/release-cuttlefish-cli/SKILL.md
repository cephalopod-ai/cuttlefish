---
name: release-cuttlefish-cli
description: Use when cutting a new cuttlefish-cli release for this repo - bumping the version, tagging, and publishing the GitHub release that triggers the automated npm publish, platform archives, and Homebrew formula bump. Covers the one rule that matters (tag vX.Y.Z MUST equal the package version).
---

# Releasing cuttlefish-cli

The published npm package is **`cuttlefish-cli`** (lives in `packages/cuttlefish`). The root
package (`cuttlefish`) is private; `packages/web` is internal (its version isn't shipped).
Version lives in **one place**: `packages/cuttlefish/package.json`.

## How the pieces connect

Publishing the GitHub release is the single trigger; everything downstream is automated:

- **npm**: `.github/workflows/release-npm.yml` fires on `release: published`. It runs
  typecheck/test/lint/build, **verifies the release tag equals `v` + the package
  version**, runs `verify:package`, then `npm publish --provenance --access public`
  (environment `npm-production`, OIDC `id-token: write`).
- **Platform archives**: `.github/workflows/release-artifacts.yml` fires when the npm
  publish workflow succeeds; builds linux-x64/darwin-arm64/win32-x64 archives.
- **Homebrew**: `.github/workflows/bump-formula.yml` also fires on `release: published`.
  It waits (up to ~5 min) for the npm tarball at
  `registry.npmjs.org/cuttlefish-cli/-/cuttlefish-cli-X.Y.Z.tgz`, computes its sha256, rewrites
  `Formula/cuttlefish.rb`, and pushes the bump to `main`.
- **CI** (`ci.yml`) runs typecheck/test/build on `main` + PRs. It does **not** publish.

> **The one rule:** the tag MUST be exactly `v<package.json version>`. Releases
> v0.0.2, v0.0.3, and v0.1.0 all failed the workflow's tag/version check (package
> was at 0.23.x) and never reached npm — which is why the version numbering
> continues from 0.23.x, not from the old tag names.

> **First-publish caveat (still open as of 2026-07-22):** `cuttlefish-cli` has
> never successfully published to npm. The v0.23.4 attempt passed the tag check
> but failed `npm publish` with `E404` (PUT not allowed): the workflow has no
> real npm credential — setup-node leaves a placeholder `NODE_AUTH_TOKEN`, no
> `NPM_TOKEN` secret is wired into the publish step, and OIDC trusted publishing
> can't be configured for a package that doesn't exist yet. A maintainer must
> either (a) do a one-time manual `npm publish` from `packages/cuttlefish` with a
> real npm account to create the package, then configure the trusted publisher /
> `NPM_TOKEN` for the workflow, or (b) add an npm token with create-package
> rights to the `npm-production` environment and re-run the release workflow.
> Once the package exists on npm this caveat is obsolete — delete it.

## Steps

1. **Land the work on `main`** (merge the PR). Releases are cut from `main`; the
   formula-bump job also pushes to `main`. Ensure a clean tree: `git status`.

2. **Pick the version.** Continue from `packages/cuttlefish/package.json` (0.23.x
   line). This is `0.x`, so a minor bump (`0.N.0`) is fine even for small breaking
   changes; patch (`0.x.N`) for fixes only.

3. **Bump + changelog + commit** (no `Co-Authored-By: Claude` trailer - repo convention):
   ```bash
   # edit packages/cuttlefish/package.json "version"
   # promote CHANGELOG.md [Unreleased] into a [X.Y.Z] - YYYY-MM-DD section
   git commit -am "chore(release): cuttlefish-cli vX.Y.Z"
   ```

4. **Build + verify** from repo root (the workflow re-runs all of this, but fail fast locally):
   ```bash
   pnpm build      # turbo build + copies packages/web/out -> packages/cuttlefish/dist/web
   pnpm typecheck && pnpm test
   ```

5. **Tag + push:**
   ```bash
   git tag vX.Y.Z && git push origin main --tags
   ```

6. **Create the GitHub release** (publishing it triggers npm publish + formula bump):
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "...release notes..."
   ```
   For a dry run, add `--draft` (drafts do NOT trigger any workflows).

7. **Verify**: the `Publish npm Package` workflow run for `vX.Y.Z` succeeds,
   `npm view cuttlefish-cli version` is X.Y.Z, the `Release Artifacts` run attaches
   the three platform archives, and a `formula: bump to vX.Y.Z` commit lands on
   `main` within ~5 min (check the bump-formula workflow run).

## Notes
- Don't bump `package.json` in the root or `packages/web` - only `packages/cuttlefish`.
- Keep the `bin` path in `package.json` free of a `./` prefix
  (`"cuttlefish": "dist/bin/cuttlefish.js"`) — npm's publish-time auto-correct
  flags the `./` form.
- If the formula job fails, it's almost always the npm tarball not being live yet;
  re-run the workflow once `npm view cuttlefish-cli@X.Y.Z` resolves.
- Ledger convention: `.giles/feature-ledger/` entries numbered ≥0023 are
  local-only (`.giles/` is gitignored; only 0001-0022 are tracked). Write the
  release ledger entry locally; don't force-add it.
