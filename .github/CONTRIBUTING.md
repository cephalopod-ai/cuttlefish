# Contributing to Cuttlefish

Thanks for your interest in contributing. This guide covers the basics.

## Prerequisites

- Node.js 24.x (the repo pins 24.13.0 via `.nvmrc` and root tooling enforces `>=24 <25`)
- pnpm 10+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)

## Development Setup

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Initialize Cuttlefish (one-time - builds all packages and creates `~/.cuttlefish`):
   ```bash
   pnpm setup
   ```
   This is safe to re-run; it skips files that already exist.
4. Start development mode:
   ```bash
   pnpm dev
   ```
   For the production-like local daemon path, use `pnpm start` and open
   [http://localhost:8888](http://localhost:8888). The web package itself is a
   Vite app, so package-local UI development uses the Vite dev server from
   `packages/web`.

## Submitting Pull Requests

- Create a feature branch from `main`.
- Keep commits focused and descriptive.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before submitting. Run
  `pnpm build` before release-sensitive changes.
- Open a pull request against `main` with a clear description of your changes.

## Code Style

- TypeScript with strict mode enabled.
- ESM modules (no CommonJS).
- Tailwind CSS for styling in the web package.
- Follow existing patterns in the codebase.

## Project Layout

- `packages/cuttlefish` -- Core gateway daemon and CLI (package dir).
- `packages/web` -- Web dashboard frontend.
- `docs/INDEX.md` -- Canonical documentation index.
- `docs/TEST_LEDGER.md` -- Current validation evidence and gaps.

## Questions?

Open an issue on GitHub if you have questions or run into problems.
