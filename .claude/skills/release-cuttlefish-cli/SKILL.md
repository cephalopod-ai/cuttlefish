---
name: release-cuttlefish-cli
description: Use when cutting a new cuttlefish-cli release for this repo - bumping the version, publishing to npm, creating the GitHub release, and letting the Homebrew formula auto-update. Covers the exact order that matters (npm publish BEFORE publishing the GitHub release).
---

# Releasing cuttlefish-cli

The published npm package is **`cuttlefish-cli`** (lives in `packages/cuttlefish`). The root
package (`cuttlefish`) is private; `packages/web` is internal (its version isn't shipped).
Version lives in **one place**: `packages/cuttlefish/package.json`.

## How the pieces connect

- **npm**: published manually with `npm publish` from `packages/cuttlefish`. The package
  ships `dist/` and `template/` (see its `files`), so you MUST build first.
- **GitHub release**: created for tag `vX.Y.Z`.
- **Homebrew**: `.github/workflows/bump-formula.yml` fires on `release: published`.
  It waits (up to ~5 min) for the npm tarball at
  `registry.npmjs.org/cuttlefish-cli/-/cuttlefish-cli-X.Y.Z.tgz`, computes its sha256, rewrites
  `Formula/cuttlefish.rb`, and pushes the bump to `main`.
- **CI** (`ci.yml`) runs typecheck/test/build on `main` + PRs. It does **not** publish.

> **Order matters:** publish to npm **before** publishing the GitHub release, or the
> formula-bump job will wait and then fail because the tarball isn't on npm yet.

## Steps

1. **Land the work on `main`** (merge the PR). Releases are cut from `main`; the
   formula-bump job also pushes to `main`. Ensure a clean tree: `git status`.

2. **Pick the version.** This is `0.x`, so a minor bump (`0.N.0`) is fine even for
   small breaking changes; patch (`0.x.N`) for fixes only.

3. **Bump + commit** (no `Co-Authored-By: Claude` trailer - repo convention):
   ```bash
   # edit packages/cuttlefish/package.json "version"
   git commit -am "chore(release): cuttlefish-cli vX.Y.Z"
   ```

4. **Build + verify** from repo root:
   ```bash
   pnpm build      # turbo build + copies packages/web/out -> packages/cuttlefish/dist/web
   pnpm typecheck && pnpm test
   ```

5. **Publish to npm.** A gitignored npm **automation token** lives at
   **`packages/cuttlefish/.npmrc`** (`//registry.npmjs.org/:_authToken=...`). npm reads
   it automatically when publishing from that directory, so it bypasses the
   account's interactive login + 2FA OTP. Publish:
   ```bash
   cd packages/cuttlefish && npm publish && cd -
   ```
   - This is the irreversible step - confirm with the maintainer first.
   - If publish fails with `E401`/`EOTP`, the token file is missing or revoked.
     Recreate it at npmjs.com → Access Tokens → Classic → **Automation**, then
     write `//registry.npmjs.org/:_authToken=<token>` to `packages/cuttlefish/.npmrc`
     (it's already in `.gitignore` - never commit it).

6. **Tag + push:**
   ```bash
   git tag vX.Y.Z && git push origin main --tags
   ```

7. **Create the GitHub release** (publishing it triggers the Homebrew bump):
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "...release notes..."
   ```
   For a dry run, add `--draft` (drafts do NOT trigger the formula workflow).

8. **Verify**: a `formula: bump to vX.Y.Z` commit lands on `main` within ~5 min
   (check the bump-formula workflow run), and `npm view cuttlefish-cli version` is X.Y.Z.

## Notes
- Don't bump `package.json` in the root or `packages/web` - only `packages/cuttlefish`.
- If the formula job fails, it's almost always the npm tarball not being live yet;
  re-run the workflow once `npm view cuttlefish-cli@X.Y.Z` resolves.
