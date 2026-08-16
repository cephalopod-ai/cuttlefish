# Control-Plane Remediation Runbook

This runbook records the exact, copy-pasteable commands to close the remaining
control-plane items in [TODO_LEDGER.md](TODO_LEDGER.md). It was produced on
2026-08-16 after a fresh readback of the GitHub/npm control plane.

## Why a runbook, not direct fixes

Every remaining item requires a **mutating GitHub API call**, an **npm account
action**, or a **platform settings toggle**. The sandbox that produced this
document blocks all mutating GitHub API calls (`Error: Mutating GitHub API
calls are not allowed`), and the `gh` token lacks the `admin:repo_hook` /
branch-protection scopes needed for the most privileged endpoints. The source
fixes each item depends on are already committed on `main` and pushed (HEAD is
`0` ahead / `0` behind `origin/main` as of 2026-08-16). What remains is purely
control-plane.

Run the commands below as a repo **admin** (`e3742526` is admin) from a shell
where `gh auth status` shows the repo, or in the GitHub web UI where linked.

## State readback (2026-08-16)

| Signal | Value | Source |
|---|---|---|
| `origin/main` HEAD | `80157f6` (PR #78) | `git log` |
| Local vs remote | `0` ahead / `0` behind | `git rev-list --left-right --count` |
| Branch protection on `main` | none (`404`/not configured) | `gh api .../branches/main/protection` |
| Repository rulesets | `[]` (empty) | `gh api .../rulesets` |
| `security_and_analysis` | `null` (secret scanning + push protection off) | `gh api .../repos/...` |
| `npm-production` environment | `protection_rules=[]`, `deployment_branch_policy=null`, `can_admins_bypass=true` | `gh api .../environments/npm-production` |
| CLI package version | `0.23.7` | `packages/cuttlefish/package.json` |
| npm latest `cuttlefish-cli` | `0.23.6` | `npm view cuttlefish-cli version` |
| Homebrew formula version | `0.23.6` | `Formula/cuttlefish-cli.rb` |
| v0.23.7 publish run `31612431897` | `failure` — `E404 ... you do not have permission` after "npm tokens that bypass 2FA are being restricted" | `gh run view 31612431897 --log-failed` |
| Secret-scan latest run `31923221858` | `success` (Gitleaks CLI v8.30.1, 2026-08-16) | `gh run list --workflow=secret-scan.yml` |
| CI latest run on `main` (`31923221899`) | `success` — `build`, `typecheck`, `unit-tests`, `windows`, `e2e`, `Run Gitleaks Scan`, `giles` all green | `gh api .../commits/main/check-runs` |

---

## RSP-CUT-001 — Protect `main` (P1)

**Status:** open. Requires a GitHub admin settings mutation.

**Fix — repository ruleset (preferred over legacy branch-protection):**

```bash
gh api -X POST repos/cephalopod-ai/cuttlefish/rulesets -F name="main-protection" \
  -F target="branch" \
  -F source="main" \
  -F enforcement="active" \
  -F conditions[ref_name][include][]="refs/heads/main" \
  -F bypass Actors[]='[]' \
  -F required_status_checks[strict]=true \
  -F required_status_checks[contexts][]="build" \
  -F required_status_checks[contexts][]="typecheck" \
  -F required_status_checks[contexts][]="unit-tests" \
  -F required_status_checks[contexts][]="windows" \
  -F required_status_checks[contexts][]="e2e" \
  -F required_status_checks[contexts][]="Run Gitleaks Scan" \
  -F required_status_checks[contexts][]="giles" \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F required_pull_request_reviews[dismiss_stale_reviews]=true \
  -F required_linear_history=true \
  -F delete_branch_on_merge=false \
  -F required_signatures=false
```

The seven `contexts` values are the exact check-run names that are green on
`80157f6` (see readback above). `strict=true` requires branches to be up to
date with `main` before merge.

**Emergency path (must be documented explicitly):** set
`enforcement="evaluate"` (audit mode) instead of `"active"` if a documented
break-glass path is required, or grant a specific bypass actor (service
account or team) via the `bypass_actors` field. Do **not** leave enforcement
in evaluate mode as the steady state.

**Verify:**

```bash
gh api repos/cephalopod-ai/cuttlefish/rulesets --jq '.[] | {id,name,enforcement,conditions}'
gh api "repos/cephalopod-ai/cuttlefish/rulesets/<ID>" --jq '.required_status_checks, .required_pull_request_reviews'
```

**Exit criteria:** readback proves `main` requires the seven CI checks, ≥1
review, restricts direct pushes, and an explicit (documented) emergency path
exists or bypass posture is recorded as deliberate.

---

## SEC-CUT-016 — Push protection (P2)

**Status:** mostly resolved. The license-free Gitleaks gate **is landed and
green on GitHub-hosted CI** (run `31923221858`, 2026-08-16, success). The
`secret-scan.yml` workflow installs pinned Gitleaks CLI `v8.30.1` from source
(no `GITLEAKS_LICENSE` required) and runs `gitleaks git --redact --verbose .`
with `fetch-depth: 0` (full history). The earlier failure (`31611836884`) was
the deprecated `gitleaks-action` marketplace action, which requires a paid
license for org repos — it has been replaced.

**Remaining:** enable GitHub-native secret scanning + push protection (the
`security_and_analysis` payload is currently `null`).

**Fix — enable platform secret scanning and push protection:**

```bash
gh api -X PATCH repos/cephalopod-ai/cuttlefish \
  -f security_and_analysis[secret_scanning][status]=enabled \
  -f security_and_analysis[secret_scanning_push_protection][status]=enabled \
  -f security_and_analysis[secret_scanning_non_provider_patterns][status]=enabled
```

> Note: GitHub may require the repo to have Advanced Security (GHAS) for some
> patterns on private repos; this repo is **public**, so secret scanning and
> push protection are available without GHAS.

**Verify:**

```bash
gh api repos/cephalopod-ai/cuttlefish --jq '.security_and_analysis'
# Expect: secret_scanning.enabled == true, secret_scanning_push_protection.enabled == true
```

**Exit criteria:** at least one maintained scanner runs on push/PR/history
(Gitleaks — done, green), the latest hosted scan is green (done,
`31923221858`), and push protection is enabled or its absence is explicitly
accepted. If push protection is intentionally not enabled, record the
acceptance here and close the item.

---

## RSP-CUT-002 — npm-production environment protection (P2)

**Status:** open. The `npm-production` environment exists but has
`protection_rules=[]`, `deployment_branch_policy=null`,
`can_admins_bypass=true`.

**Fix — add required reviewer + restrict to tagged releases:**

```bash
# Required reviewers (use the npm-release bot or a release team):
gh api -X PUT repos/cephalopod-ai/cuttlefish/environments/npm-production \
  -F wait_timer=0 \
  -F reviewers[][type]=User -F reviewers[][id]=209696398 \
  -F deployment_branch_policy[protected_branches]=false \
  -F deployment_branch_policy[custom_branch_policies]=true

# Then restrict the custom branch policy to the tag-bearing release flow:
gh api -X POST repos/cephalopod-ai/cuttlefish/environments/npm-production/deployment-branch-policies \
  -F name="main"
```

`release-npm.yml` triggers on `release: [published]` and verifies
`v${VERSION} == ${GITHUB_REF_NAME}`, so the effective gate is a published
release tag. Restricting the environment to `main` plus the tag-check step is
sufficient; do **not** allow arbitrary branches.

**Decide deliberately on `can_admins_bypass`:** if it stays `true`, document
that an admin can bypass the reviewer gate as the emergency path. If it must
be `false`, set it when creating the protection rule (the field is set on the
environment's protection rule creation).

**Verify:**

```bash
gh api repos/cephalopod-ai/cuttlefish/environments/npm-production \
  --jq '{protection_rules, deployment_branch_policy, can_admins_bypass}'
```

**Exit criteria:** readback shows reviewer/wait safeguards, branch/tag policy
restricts to `main`, bypass posture is deliberate and documented, and a
release rehearsal (see REL-CUT-001) exercises them.

---

## REL-CUT-001 — Complete v0.23.7 npm publication (P2)

**Status:** open. Root cause now confirmed by run logs.

**Root cause (from failed run `31612431897`):**

```
npm notice npm tokens that bypass 2FA are being restricted for account changes
          and direct publishing.
...
npm error 404 Not Found - PUT https://registry.npmjs.org/cuttlefish-cli - Not found
npm error 404  The requested resource 'cuttlefish-cli@0.23.7' could not be found
          or you do not have permission to access it.
```

This is **not** a missing package (the package exists — `npm view cuttlefish-cli version` returns `0.23.6`). It is an **npm auth/2FA authority failure**: the
`NPM_TOKEN` secret is either (a) a read-only/granular token without `publish`
scope for `cuttlefish-cli`, or (b) an automation token whose 2FA posture is
being restricted by npm's 2FA-bypass-token deprecation. The publish step ran
with `--provenance`, which requires the token to support provenance attestation.

**Fix:**

1. **Regenerate `NPM_TOKEN`** as an npm **automation** token (or a granular
   access token) with:
   - `publish` permission on the `cuttlefish-cli` package (and `cuttlefish` if
     that scope is also published), and
   - 2FA set to `auth-and-writes` (NOT a token that bypasses 2FA).
   - Provenance requires the token to allow provenance; automation tokens do.
2. Update the GitHub Actions secret that `release-npm.yml` reads (`NPM_TOKEN`):
   in **Settings → Secrets and variables → Actions**, edit the `NPM_TOKEN`
   secret with the new automation token value.
3. **Re-trigger the publish.** The release is already published (tag `v0.23.7`
   exists, release is not a draft), so the `release: [published]` trigger has
   already fired. Re-run the failed workflow directly:

   ```bash
   gh run rerun 31612431897 --repo cephalopod-ai/cuttlefish
   ```

   If rerun is unavailable (workflow changed since), trigger via
   `workflow_dispatch` after adding that trigger, or delete and republish the
   tag/release after fixing the token.
4. **Remove the stale duplicate draft.** There are two `v0.23.7` releases:
   one published (Latest) and one Draft. Delete the draft:

   ```bash
   # Find the draft release id:
   gh api repos/cephalopod-ai/cuttlefish/releases \
     --jq '.[] | select(.tag_name=="v0.23.7" and .draft==true) | .id'
   # Delete it:
   gh api -X DELETE repos/cephalopod-ai/cuttlefish/releases/<DRAFT_ID>
   ```
5. **Verify convergence:**

   ```bash
   npm view cuttlefish-cli version          # expect 0.23.7
   node -p "require('./packages/cuttlefish/package.json').version"  # 0.23.7
   git tag --list 'v0.23.7'                 # present
   # Homebrew formula: bump-formula.yml runs on release and should auto-bump.
   # Verify after publish:
   grep 'cuttlefish-cli-' Formula/cuttlefish-cli.rb | head -1
   ```

**Exit criteria:** npm, tag, package manifest, release assets, Homebrew
formula, and release docs agree on `0.23.7`; duplicate draft disposition is
recorded; downstream workflows (release-artifacts, bump-formula) are green.

---

## DEP-CUT-002 — Dependabot alert convergence (P2)

**Status:** source-side resolved. The `brace-expansion` overrides are on
`main` and pushed:

```
package.json:
  "brace-expansion@<2.0.0": "1.1.18"
  "brace-expansion@>=5.0.0 <5.0.9": "5.0.9"
```

**Remaining:** confirm Dependabot alert 15 is closed. The Dependabot alerts
API returns `403` for the current token (missing `security_events` scope), so
this must be verified in the UI or with a token that has that scope.

**Fix / verify:**

```bash
# Requires a token with the `security_events` scope:
gh api repos/cephalopod-ai/cuttlefish/dependabot/alerts?state=open \
  --jq '.[] | {number, package:.security_vulnerability.package.name, severity:.security_advisory.severity}'
```

If alert 15 is still open against `brace-expansion` despite the override
resolving it at install time, Dependabot may be alerting on a path the pnpm
override doesn't cover (e.g., a dev-only transitive path or a different
manifest). Either:

- add the override to cover the alerted range, or
- dismiss alert 15 as a governed exception (in **Settings → Code security →
  Dependabot → alert 15 → Dismiss**, reason "tolerable risk" or "used in tests
  only"), and record the exception in the governance exception inventory.

**Exit criteria:** full dependency audit has no unaccepted high advisory,
production audit stays clean, lint/tests pass (already true on `80157f6`), and
Dependabot alert 15 is closed or covered by a recorded governed exception.

---

## TST-CUT-004 — Scroll-resize CI (P2) — RESOLVED

**Status:** **satisfied.** The scroll-resize product/test repair is on `main`,
and the GitHub-hosted CI is green on the latest commit (`80157f6`, run
`31923221899`): `build`, `typecheck`, `unit-tests`, `windows`, `e2e`,
`Run Gitleaks Scan`, and `giles` all report `success`. The referenced failure
`31611837069` (2026-08-12, pre-repair) has been superseded by green runs on
2026-08-13 (`31729617879`) and 2026-08-16 (`31923221899`).

**Action:** move to [TODO_HISTORY.md](TODO_HISTORY.md). No further work.
