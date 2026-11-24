# Meta Muse Code

Cuttlefish includes the optional `muse` engine for text turns on a Muse Code subscription. Use the qualified Muse Code **1.4.25** CLI and sign in with `muse login` to an account with an active subscription. The gateway checks the credential lane and subscription in the same native host that will run the turn. See [Meta authentication and billing](https://dev.meta.ai/docs/muse-code/auth) and [Muse Code subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions).

## Setup

Setup and dashboard engine pickers mark Muse available when its executable passes the version probe. Use an absolute path for an explicit executable override. Existing defaults stay in place. Fresh setup can select Muse explicitly and selects it automatically when Muse is the only usable CLI.

Merge an optional engine entry into `config.yaml`.

```yaml
engines:
  muse:
    bin: muse
    model: muse-spark-1.3
    effortLevel: medium
```

An employee uses the same engine selection and reporting fields as other employees. Configure `mcp: false` for a Muse employee if the global configuration supplies MCP servers.

```yaml
name: muse-engineer
displayName: Muse Engineer
department: engineering
rank: employee
engine: muse
model: muse-spark-1.3
effortLevel: medium
reportsTo: engineering-lead
mcp: false
persona: |
  Implement assigned changes in the workspace.
  Report validation and any unresolved work to your manager.
```

`POST /api/engines/refresh` refreshes model choices without running inference. Cuttlefish prefers the provider catalog from `model/list` and tries the CLI's `exec --list-models` catalog when the host has no live rows. Static Spark 1.3, Wonder 1.0 and Spark 1.2 entries carry a fallback label. The runtime checks that Muse selected the configured model before dispatch. Availability and effort tiers depend on account entitlement. [Meta's model catalog](https://dev.meta.ai/docs/choose-a-model).

## Authentication and allowance

Muse uses the native browser login. Cuttlefish removes `META_API_KEY` and `MODEL_API_KEY` from its child environment. If a stored API key wins Muse's credential selection, the gateway blocks the turn and reports the reason. An unknown or inactive subscription also blocks the turn. Contributor mode is off and Contributor model IDs are rejected.

The Limits dashboard shows one observation per Muse installation used by the gateway. All Muse employees share that observation. Where Muse reports window and weekly usage, Cuttlefish shows the percentages, reset times and age. A subscription verification can succeed while Muse reports no allowance. That state stays unknown for routing and never becomes a zero-percent reading. A positive orchestration headroom threshold requires a fresh allowance reading. An operator can configure a zero threshold to let the scheduler consider unknown headroom. The adapter still checks subscription status and known exhaustion before dispatch.

Context counts and per-turn token counts are recorded when Muse reports them. The ledger identifies terminal totals and totals from observed model calls. The run ledger includes reported token counts alongside native session identity, employee, accepted model, requested effort and transport at settlement. The adapter supplies no token price or dollar estimate.

## Execution and recovery

- Muse owns native conversation history and compaction. Cuttlefish binds the exact native session before submitting a turn and opens a fresh native process for each turn. Continuations use the saved native ID and workspace. A failed resume surfaces an error and keeps the association. Start a new Cuttlefish session when you intend to start a fresh conversation.
- Cuttlefish supplies current employee and workspace instructions in each turn input. The installed host silently ignored an updated MSP developer prompt on resume during qualification. This approach works for fresh and resumed turns and leaves native history with Muse.
- The gateway submits Muse work through its normal session, employee, delegation, cron, connector and lease paths. Muse uses the assigned working directory, including an orchestration worktree. Native subagents and workflow tools are excluded from the adapter's toolset.
- Muse uses its native sandbox and the `:ask-me` profile. Cuttlefish checks the applied permission axes and disables inherited plugin and web tooling. User hooks, configured endpoint overrides, managed settings and workspace Muse configuration cause dispatch to fail closed. The adapter admits only its qualified built-in toolset of `read_file` and `bash`. Native approval requests with a verifiable one-time rejection are denied. Cuttlefish's organizational approvals still apply to dispatch.
- Cuttlefish never automatically replays a failed Muse prompt or escalates it to another engine. If execution was interrupted, reconcile its effects before submitting another prompt. Native context recovery can fail after a provider crash, session expiration or workspace change. The adapter does not resume a different session or enable Muse auto-recovery.
- Sessions that require Cuttlefish-enforced read-only execution, MCP, attachments or arbitrary CLI overrides fail before the prompt is sent. The installed Muse build withheld the local MCP fixture despite accepting its session definition. Shared native skill synchronization, operator grants for native tools, raw terminal view and multimodal inputs remain unqualified.

## Transport decision

| Transport | Qualification | Decision |
| --- | --- | --- |
| Native ACP | Muse 1.4.25 initialized ACP v1 and completed an echo turn. It advertised image prompts, session load and resume, and HTTP MCP. The observed ACP surface lacked a pre-turn account-lane and subscription check. | Deferred. |
| Muse Session Protocol | The installed host provided same-process account and subscription checks, exact resume, explicit model selection, permission inspection, streaming and a durable terminal event. Some required security diagnostics are experimental. The TypeScript SDK is MIT, supports Node 20+, and has no runtime dependencies. Its stable facade does not supply every experimental check used here. | Use stdio MSP via Cuttlefish's existing JSON-RPC transport and subprocess helpers. Pin the qualified executable version until revalidation. |
| Headless `muse exec` | The CLI supports private prompt files, JSONL, a model list and exact session IDs. Gosling validates the root result and strips paid keys. Its separate billing probe can return an indeterminate allowance and its wrapper has no native approval relay. | Use its model-list command for discovery only. |

No new package dependency or Gosling installation is required. The adapter uses independently written TypeScript based on Meta's public protocol schema. The research used Gosling's approach to credential filtering, root-result validation and bounded process cleanup. [Meta's protocol and SDK source](https://github.com/meta-models/muse-code-sdk) · [Gosling's Muse guide](https://github.com/cephalopod-ai/gosling/blob/main/documentation/docs/guides/meta-muse.md).

## Validation and limits

The qualification started on Cuttlefish `25dc3d7` with Muse Code 1.4.25 on macOS, Node 24.22.3 and pnpm 10.6.4. Credential-free echo probes and an authenticated text smoke verified distinct parts of the native protocol. The subscription check reported active while its allowance was absent. The authenticated smoke returned streamed text, resumed the exact native session from a new host, and used updated instructions. Platform-specific Linux and Windows execution, live native file writes, connector and cron delivery, live approval denial, and native MCP tool use remain unverified. The [test ledger](TEST_LEDGER.md) records the Cuttlefish fixture and build results.
