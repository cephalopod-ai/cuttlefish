# Feature Ledger: windows-11-x64-safeguards

**feature id:** `windows-11-x64-safeguards`

## Windows 11 (x86_64) runtime safeguards + CI gate (2026-08-05)

**action summary:** Closed the Windows runtime gaps found by a full win32
compatibility audit while leaving macOS/Linux behavior untouched by
construction. Added `shared/windows-exec.ts` — a cmd.exe spawn-compatibility
layer (cross-spawn-style caret escaping, so engine args carrying user prompt
text cannot inject into the shell line) plus `killProcessTree` (POSIX
process-group kill / `taskkill /T /F` on Windows). Engine detection
(`isInstalled`) now recognizes npm's `.cmd`-shim-only installs — previously a
stock Windows machine reported zero engines despite the docs prescribing
`npm i -g` — and all non-PTY engine spawn/execFile sites route through the
compat layer (PTY sessions already launch shims natively via ConPTY). Engine
termination now kills the whole process tree on Windows instead of orphaning
grandchildren. Fixed the POSIX-only `dev` script (`( … &)` → cross-platform
`scripts/dev.mjs`), `~\` tilde expansion in the dashboard file browser and
file storage, and `path.join` for PID-file paths in `remove`/`nuke`. Added a
`windows-2022` CI job (typecheck, full build, Windows-focused unit tests, CLI
smoke) running under the native shells — previously no test job ran on
Windows at all. Documented the Windows support status and known limitations
(hard-stop semantics of `cuttlefish stop`, Linux-only autostart, inert POSIX
permission hardening, curl dependency for voice, WSL2 alternative) in
`docs/INSTALL.md`, and corrected stale `posix_only` claims in
`docs/script-surface-map.md`.

**status:** implemented and validated on Linux (`completed`, residuals
below); Windows-runner verification pends the first CI run of the new
`windows` job on the PR.

**provenance:** direct — audit and changes authored this session against the
working tree on branch `claude/cuttlefish-windows-safeguards-v61qms`; no
history reconstruction. Cross-platform target baseline taken from the
agent-skills catalog (`000_common/platform-compatibility-base/`), narrowed
to Windows 11 x86_64 per the repo's existing win32-x64 release lane (ARM64
recorded as an explicit non-target).

**touched files:**

Spawn compatibility layer:
- `packages/cuttlefish/src/shared/windows-exec.ts` (new)
- `packages/cuttlefish/src/shared/__tests__/windows-exec.test.ts` (new)
- `packages/cuttlefish/src/shared/resolve-bin.ts`
- `packages/cuttlefish/src/shared/__tests__/resolve-bin.test.ts`

Non-PTY spawn sites wired through the compat layer:
- `packages/cuttlefish/src/engines/{kilo,kiro,aider,pi,codex,grok,ollama,hermes-acp}.ts`
  (also process-tree kill in their signal paths)
- `packages/cuttlefish/src/shared/{codex-app-server,engine-limits,pi-models,grok-models,hermes-models}.ts`
- `packages/cuttlefish/src/sessions/fork.ts`
- `packages/cuttlefish/src/cli/setup.ts`

Script/path portability:
- `packages/cuttlefish/scripts/dev.mjs` (new)
- `packages/cuttlefish/package.json` (`dev` script)
- `packages/cuttlefish/src/gateway/fs-browse.ts`
- `packages/cuttlefish/src/gateway/files/storage.ts`
- `packages/cuttlefish/src/cli/remove.ts`
- `packages/cuttlefish/src/cli/nuke.ts`

CI + docs:
- `.github/workflows/ci.yml` (new `windows` job)
- `docs/INSTALL.md` (Windows support status section)
- `docs/script-surface-map.md` (stale posix_only claims corrected)
- `CHANGELOG.md`

**post-review amendments (same session):** (1) This ledger file is inside
git-ignored `.giles/` — the initial commit silently dropped it (caught by
Codex review); force-added like the prior 0094–0099 entries. (2) Pinned the
PATHEXT list in the `executableCandidates` test — a real Windows host's own
PATHEXT (.VBS/.MSC/…) broke the fallback-default expectation on the first
windows CI run. (3) Codex finding, confirmed valid: for shimmed `execFile`
calls, Node's `timeout` killed only the cmd.exe wrapper and `taskkill /T`
cannot walk a dead parent — `execFileCompat` now takes over the timeout and
tree-kills while the wrapper is alive, with a Windows-runner-only regression
test; the sync variant's equivalent residual (bounded `--version` probes
only) is documented in-code. (4) Codex follow-up finding, confirmed valid
and generalized: timeout/cleanup paths that called single-process
`child.kill()` on spawnCompat children (codex-app-server killChild,
pi/grok/hermes model-discovery timers) would kill only the cmd.exe wrapper
of a shimmed spawn — swept all four through a new `killChildTree` helper
(tree kill by PID; on POSIX a non-detached child is not a group leader, so
`kill(-pid)` ESRCHes into the same single-process kill as before — POSIX
behavior unchanged).

**validation run:** from repo root on Linux (Node 22 host; engines field
targets 24 — warning only): `pnpm typecheck` (4/4 tasks pass), `pnpm lint`
(3/3 pass), `pnpm test` (314 files, 2621 passed / 1 skipped), `pnpm build`
(2/2 pass), `node --check` on `scripts/dev.mjs`. New windows-exec suite: 12
tests passing, including escaping/injection cases. Not run here: anything on
an actual Windows host — the new CI `windows` job is the verification
vehicle for that, on this branch's PR.

**remaining open items:**
- Graceful daemon shutdown on Windows: `cuttlefish stop` still hard-kills
  (TerminateProcess semantics). A cooperative channel (e.g. an authenticated
  localhost shutdown endpoint the CLI calls before falling back to kill) is
  a plan-level decision — new outward-facing surface — deliberately not
  taken unilaterally; documented as a known limitation in INSTALL.md.
- `cuttlefish startup` has no Windows Task Scheduler equivalent (guarded,
  documented).
- Full vitest suite on Windows: many suites assume a POSIX host; the CI job
  runs the Windows-focused subset plus typecheck/build/smoke. Broadening the
  suite is follow-up work.
- Windows 11 ARM64: no native build or testing; recorded as a non-target.
- `curl.exe` dependency for voice model downloads is documented but not yet
  replaced with a `fetch()` fallback.
