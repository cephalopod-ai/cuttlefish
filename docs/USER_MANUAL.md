# User Manual

## What Cuttlefish Does

Cuttlefish is a local gateway daemon and web dashboard for coordinating professional AI
coding CLIs. It runs external engines such as Claude Code, Codex, Grok,
Antigravity, Pi, Hermes, and Kiro through a shared org/delegation model.

## Who It Is For

- Operators who already use coding-agent CLIs and want one local dashboard.
- Teams experimenting with AI "employees", departments, cron jobs, connectors,
  and controlled delegation.
- Developers who want local orchestration without replacing official engine CLIs.

## Core Concepts

- **Gateway daemon:** local Node process that serves the API and dashboard.
- **Engine:** external CLI Cuttlefish invokes for model work.
- **Employee:** configured persona/role with an engine/model/department.
- **Session:** persisted conversation or work run.
- **Connector:** Slack, WhatsApp, Twilio SMS, or similar integration.
- **Skill:** reusable Markdown playbook synced into agent workflows.
- **Orchestration:** scheduler/runtime for multi-role tasks, leases,
  continuations, holds, worktrees, and dual-lane operations.

## Installation And Setup

Canonical install instructions (Windows, macOS, Linux; npm, archives, source):
**[INSTALL.md](INSTALL.md)**.

1. Install Node.js 24.x. This repo pins Node 24.13.0 via `.nvmrc` and declares `>=24 <25` in its manifest. Installation warns rather than enforcing that range; use the pinned version for native modules.
2. Install and sign in to at least one engine CLI.
3. Install Cuttlefish:

   - **npm** (after a published release): `npm install -g cuttlefish-cli`
   - **Windows** (source or release zip): `.\scripts\install.ps1 -FromSource -Force` or
     `.\scripts\install.ps1 -FromRelease -Force` from a clone / downloaded script
   - **Source** (all platforms, supported before npm publication): see the root
     README / `INSTALL.md`

4. Initialize the local Cuttlefish home (skipped automatically by `install.ps1` unless `-SkipSetup`):

```bash
cuttlefish setup
```

5. Start the gateway:

```bash
cuttlefish start
```

By default, the dashboard is served by the gateway at `http://localhost:8888`
unless the configured gateway port differs.

Setup requires the sessions database to initialize successfully. If initialization
fails, setup reports failure; repair the named database path or its access and
rerun setup before starting. Optional engine probes and optional documentation
downloads can warn without preventing local initialization. A reachable dashboard
still needs a signed-in engine to execute work.

## Common Workflows

### Start And Stop

```bash
cuttlefish start
cuttlefish status
cuttlefish stop
cuttlefish restart
```

For a source-checkout upgrade, stop the gateway before `pnpm build`, then start
it after the build completes. The CLI build replaces `dist`; a daemon still
using that directory can fail a later lazy import while files are absent.
Use the same `CUTTLEFISH_HOME` for stop and start, and preserve runtime state.

Use `cuttlefish help` or `cuttlefish help <command>` to discover commands.
If startup reports an occupied port, choose a free port with
`cuttlefish start -p <port>`, or update `gateway.port` in `config.yaml`.
The CLI refuses to take over a process without its owned PID file.
Malformed gateway PID contents produce a named refusal and remain on disk for
inspection; stop sends no signal for an invalid identity. Strict PID parsing
does not distinguish reuse of a valid positive PID after abrupt termination.
Help exits successfully; missing subcommands and unknown help targets retain
error exit codes.

### Pair Another Browser

```bash
cuttlefish pair
cuttlefish unpair --json
```

From a source checkout, run JSON-producing commands with pnpm's quiet mode so
the script banner does not pollute stdout: `pnpm --silent cuttlefish unpair --json`.

Creating pairing codes requires an authenticated operator with administrator
authority. A session-scoped agent token cannot create them. Use the local
authenticated dashboard or `cuttlefish pair`; revoking a paired browser ends
that browser's access without revoking other paired browsers.

### Instance Model

```bash
cuttlefish list
```

Cuttlefish supports one canonical instance name per active home. The supported
runtime home is `~/.cuttlefish` by default (or the same `CUTTLEFISH_HOME` used
by every lifecycle command) and the default dashboard port is `8888`. Repeated
restart requests coalesce while a detached restart is already in progress. The
inherited `create`, `remove`, and `nuke` surfaces are disabled or limited so
automation cannot silently create additional named instances.

### Manage Skills

```bash
cuttlefish skills find testing
cuttlefish skills add <package>
cuttlefish skills list
cuttlefish skills update
```

`skills add` detects skills already installed in the selected Cuttlefish
instance and reports that state without rerunning the global installer. If an
installer exits nonzero but the requested skill is discovered and recorded,
the command reports the successful final state and retains the installer detail.

### Use The Dashboard

Routes are defined in `packages/web/src/main.tsx`:

- `/?lane=team`: project/session Team workspace with unified feeds, a recipient pulldown with guarded message-all delivery, session inspection, and guarded project deletion
- `/?lane=management`: global Management feed with optional project context and lead-first routing
- `/talk`: compatibility redirect to the Team workspace
- `/command`: Orchestration Command Center overview dashboard
- `/kanban`: department boards and ticket dispatch
- `/approvals`: human approval/checkpoint queue
- `/archive`: archived sessions
- `/orchestration`: orchestration operations
- `/cron`: scheduled jobs
- `/activity`: runtime log inspection; `/logs` redirects here
- `/limits`: usage/rate-limit visibility
- `/org`: organization and employee configuration
- `/settings`: gateway/engine/connector/email settings
- `/skills`: local skill browsing and management
- `/file`: file viewer

Unknown client paths redirect to `/` so stale deep links recover to the primary
chat workspace instead of leaving an empty dashboard shell.

### Sending messages and files

The chat composer keeps your draft and attachments until the gateway accepts
the request. If an upload or message request fails, correct the problem and
retry from the composer. Sending files without text supplies the visible prompt
"Please review the attached files." File screening and checkpoints still apply.

Resources belong to the session. Later messages and durable queue replay reuse
the saved file references and screened context. Concurrent resource additions
are merged. A rejected attachment request leaves the current engine turn able
to finish; an accepted follow-up checks the current session state before
interrupting it. Queue replay follows the existing pause and boot-resume policy.

Session-scoped callers may add artifacts from their own managed session uploads.
New references to another session's uploads or artifacts whose session ownership
cannot be established are refused before dispatch. Operator attachment workflows
retain their wider access. Existing stored references remain subject to the
existing replay policy; this change does not remove historical attachments.

## Configuration

Cuttlefish reads instance configuration from the active Cuttlefish home, normally
`~/.cuttlefish` or the path set by `CUTTLEFISH_HOME`. Lifecycle commands and
`cuttlefish list` use that same active home.
Engine CLIs keep their own authentication state. Cuttlefish does not replace engine
sign-in flows; run each engine once and authenticate before routing work to it.

Dashboard saves merge into the existing `config.yaml`. Invalid request values
return `400`. An unreadable file or YAML that is not a valid mapping returns
`409` (`CONFIG_UNREADABLE` or `CONFIG_INVALID_ON_DISK`) without replacing the
existing bytes. Preserve a copy and repair the file or its access, then reload
Settings before saving again.

### Scheduled jobs

Cron job IDs must be safe, unique identifiers. A duplicate ID or a collision with
a legacy job's normalized run-log name returns `409 CRON_ID_CONFLICT`. Existing
legacy IDs remain readable, including their run history.

If `cron/jobs.json` has invalid JSON, a non-array root or invalid stored entries,
runtime reads can show zero jobs or only the valid subset. Creates, updates,
deletes and persisted enable changes refuse to replace that partial state;
the API returns `409 CRON_INVALID_ON_DISK`. Stop the gateway, preserve the
original file, repair it and restart before modifying jobs. Logs say whether a
backup copy succeeded; a failed backup leaves the original available for repair.

### Changing a chat model

The chat composer applies an explicit model or effort selection to the next
queued turn, including when continuing the reusable HR / Org Steward chat.
That HR singleton retains its engine and working directory; start a non-HR chat
when either of those needs to change.

The virtual COO uses the saved default engine, model, and effort selection.
Fresh installations start with Claude Fable 5.1 at Medium effort, but the
onboarding picker and Settings let you choose another engine or model; that
choice remains the COO profile. Configure any fallback policy
separately from the selected primary model.

### Email inboxes

- Operators can configure up to 3 IMAP inboxes in `/settings`.
- Cuttlefish polls configured inboxes, caches normalized messages plus
  attachments, and can auto-ingest new mail into COO-owned sessions.
- Email is inbound-only in this version. It does not send or reply to email.

### Twilio SMS

Twilio SMS can create or continue a session from an allowlisted phone number
and return the completed response by SMS. Follow [the Twilio SMS setup guide](TWILIO_SMS.md)
to configure credentials, an SMS-capable sender, and the signed inbound webhook.

## Persistence And Files

- Sessions, messages, registry data, queue state, files, archives, approvals, and
  orchestration state are persisted in the active Cuttlefish home.
- Uploaded files are managed by the gateway files API and protected by managed
  storage/read policies.
- Local audit/session/Giles/runtime artifacts in the source checkout are not part
  of runtime persistence and are ignored by Git.

## Error Handling And Recovery

- `cuttlefish status` reports daemon state and useful gateway details.
- Rate-limit and engine-unavailable paths are handled through session metadata and
  configured fallback behavior where supported.
- Orchestration recovery manifests are operator-reviewed; recovery requeue leaves
  work paused until explicitly resumed.
- File reads and downloads are constrained to allowed roots and managed paths.
- `/file` previews supported raster images and shows a download for other binary
  files. `download=1` on the read API returns file bytes after the same policy
  checks; text retains preview redaction. Inline reads/downloads keep the 5 MiB
  cap; larger managed files use their `/api/files/:id` download. Image decode
  failure shows a message with download available. SVG stays a binary download.
- `/api/healthz` reports HTTP-process liveness; `/api/readyz` reports dependency
  readiness. Readiness can return `503` while the dashboard is reachable. Inspect
  the named checks in `/api/status` rather than treating liveness as readiness.
- An interrupted department rename keeps its recovery intent until completion.
  If both department directories exist or recovery cannot finish, further
  renames return `409`. Preserve the org files and inspect the pending intent;
  resolve the conflicting state before retrying. Recovery does not merge or
  overwrite a second department.
- Generated MCP credential files are excluded from inline file reads, including
  canonical directory aliases and the arbitrary-read opt-in. This does not
  establish provenance for arbitrary hard links to sensitive files.

## Troubleshooting

| Symptom | Likely Cause | Next Step |
|---|---|---|
| Engine not available | CLI missing, broken, or not signed in | Run the engine binary directly and authenticate. Cuttlefish advertises a CLI only when it can complete a bounded `--version` probe; this does not verify account access or quota. |
| Dashboard unreachable | Gateway not running or different port | Run `cuttlefish status`; check `gateway.port`. |
| Claude sessions cannot reach models | Claude CLI not logged in | Run `claude`, use `/login`, then restart Cuttlefish. |
| Hermes hidden or failing | `hermes` not on `PATH` or provider credentials missing | See `docs/engines-hermes.md`. |
| Orchestration controls disabled | Runtime disabled or unavailable | Check `orchestration.enabled` and `/orchestration` status. |

## Known Limitations

- Hermes is metered by its configured provider, unlike subscription-wrapped engines.
- Kiro credit usage is an estimate; see `docs/known-diagnostics.md`.
- Historical plan/spec docs may describe earlier intended designs and should not
  override current source, tests, README, or feature inventory.
- The September 16 audit exercised a disposable gateway with providers disabled
  and Chromium browser workflows, plus the fixture E2E suite. These runs do not
  verify signed-in engine turns, external connector delivery, Windows or hosted
  CI. See [the test ledger](TEST_LEDGER.md) for results and coverage limits.
- The prior native Claude background-result observation remains open as
  `PLAY-RESUME-20260905-R22` in [the TODO ledger](TODO_LEDGER.md); the September 16
  no-provider run does not supersede that live observation.

## See Also

- `docs/ARCHITECTURE.md`
- `docs/SPECIFICATION.md`
- `docs/IMPLEMENTATION_DIAGRAMS.md`
- `docs/TEST_LEDGER.md`
- `docs/feature_inventory.md`
