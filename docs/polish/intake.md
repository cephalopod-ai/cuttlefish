# Code Polish Intake

- Repo: `/home/ericl/Work/vscode/public_share/cuttlefish`
- Branch: `main`
- Date: 2026-06-25T21:57:16-04:00
- Dirty state: staged GitHub-staging cleanup for `.playwright-mcp/` artifacts; no unrelated source-code edits observed.
- Primary languages: TypeScript, TSX, JavaScript/MJS, Markdown, YAML.
- Formatter/linter tools: ESLint via `pnpm lint`; TypeScript compiler via `pnpm typecheck`; Vitest and Playwright for tests.
- Test commands: `pnpm test`, package-level `vitest run`, and `pnpm test:e2e`.
- Existing naming conventions: `kebab-case` source files for most TypeScript modules, `PascalCase` React components only where established, dated `YYYY-MM-DD-topic.md` docs, and package-scoped source trees under `packages/cuttlefish/src` and `packages/web/src`.
- Header convention found: no broad source-header convention in active TypeScript/TSX files; adding headers repo-wide would create high-noise churn.
- High-risk public surfaces: published `cuttlefish-cli` package, CLI commands, API routes, dashboard routes, templates/migrations, config schemas, database migrations, and docs linked from `README.md` / `docs/INDEX.md`.

