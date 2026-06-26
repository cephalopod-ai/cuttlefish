# Convention Baseline

## Existing Conventions

- The monorepo uses `pnpm`, Turborepo, TypeScript, Vite/React, and Vitest.
- Backend modules live under `packages/cuttlefish/src`, grouped by domain such as `cli`, `gateway`, `sessions`, `engines`, `orchestration`, and `connectors`.
- Web modules live under `packages/web/src`, grouped by `components`, `routes`, `lib`, `hooks`, and `context`.
- Source filenames are predominantly `kebab-case.ts` / `kebab-case.tsx`; tests use `*.test.ts` or `*.test.tsx`.
- CLI output intentionally uses `console.log`; it is not a debug-remnant signal in CLI command files.
- Unused imports are treated as polish defects even when the current lint profile does not flag them.
- Markdown docs use `kebab-case.md` with date prefixes for plans/specs where applicable.
- Generated/build/runtime outputs are expected to stay untracked: `dist/`, `out/`, `.giles/`, `governance/logs/`, `docs/audits/`, `docs/logs/`, `state/`, and `logs/`.

## Inconsistencies Found

- `.playwright-mcp/` browser-run logs and snapshots were tracked even though they are generated local artifacts.
- Active source files do not use source headers consistently; no existing repo-wide header style is established.
- Historical planning docs contain TODO/example snippets that are archival rather than active engineering debt.

## Proposed Normalization Rules

- Keep generated/local browser automation artifacts out of Git via `.gitignore`.
- Avoid repo-wide header churn until the project adopts a source-header convention deliberately.
- Preserve intentional CLI `console.log` output; flag only non-CLI debug remnants.
- Keep TODO debt tracking focused on active source and operator-facing docs, not archived implementation-plan snippets.

## High-Risk Exclusions

- No public package names, CLI commands, API routes, database migrations, schema keys, dashboard URLs, or runtime config keys were renamed in this polish pass.
- No production source files were reformatted or header-churned.
- No generated build outputs, vendored dependencies, lockfiles, migrations, or template compatibility surfaces were edited.

## Generated/Vendor Exclusions

- Excluded: `node_modules/`, `.turbo/`, `packages/*/dist/`, `packages/web/out/`, `.giles/`, `governance/logs/`, `docs/audits/`, `docs/logs/`, `state/`, `logs/`, `.playwright-mcp/`, caches, and package-manager lockfiles.
