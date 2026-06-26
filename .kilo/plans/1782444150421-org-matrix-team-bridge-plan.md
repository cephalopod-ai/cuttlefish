# Org Matrix Team Bridge Plan

## Goal

Make `software-agent` and `adversarial-reviewer` allocatable matrix-orchestration participants without breaking existing board/manual dispatch flows, then expose a usable implementation-plus-review team through the live orchestration runtime and `/orchestration` UI.

## Current State

- `~/.cuttlefish/orchestration` does not exist.
- `~/.cuttlefish/config.yaml` has no `orchestration:` block.
- The gateway already bridges org employees into orchestration workers via `packages/cuttlefish/src/gateway/org-worker-bridge.ts` and `createGatewayOrchestrationRuntime()`.
- The current bridge emits deterministic hashed exact-match ids/capabilities that are safe for internal use but poor for hand-authored operator YAML.
- Bridged org workers currently derive:
  - `provider` from `employee.engine`
  - `family` from `familyForEngine(engine)`
  - `tools` from MCP declarations only
  - `capabilities` from `board_dispatch`, exact-match identity, rank, and `provides:*`
- `software-agent` and `adversarial-reviewer` currently both use `claude`, so opposite-family review would fail as configured today.
- `/api/orchestration/workers` shows augmented bridged workers only when the runtime is successfully bound; if runtime binding fails, the observe fallback reads base orchestration config only.
- Runtime defaults are slightly inconsistent from an operator perspective:
  - code default `ORCH_WORKTREE_ROOT` is `~/.cuttlefish/worktrees`
  - settings UI placeholder suggests `~/.cuttlefish/orchestration/worktrees`

## Agreed Design Decisions

### Review semantics

- Keep opposite-family review semantics for this team.
- Do not use `sameFamilyReviewerFallback` for the primary path.

### Family split

- Move `adversarial-reviewer` from Anthropic to Codex so the exact implementation/review pair satisfies opposite-family review.
- Keep `software-agent` on Claude.

### Source of truth

- `~/.cuttlefish/org/software/*.yaml` remains the source of truth for the two participants.
- Do not duplicate `software-agent` or `adversarial-reviewer` as base records in `~/.cuttlefish/orchestration/workers.yaml`.

### Bridge compatibility

- Preserve existing hashed synthesized worker ids and role ids for compatibility.
- Add new readable alias surfaces instead of replacing existing ids.

### Human-readable org targeting

- Add stable capability aliases of the form `org_employee:<name>` to synthesized org workers.
- Example targets:
  - `org_employee:software-agent`
  - `org_employee:adversarial-reviewer`

### Generic-role enablement

- Add broader generic orchestration roles, not only dedicated one-off roles.
- Make bridged org workers eligible for those roles through bridge inference.

### Inference policy

- Inference is sourced from employee `name`, `displayName`, and `persona` text.
- The implementation mechanism is explicit phrase matching with tested outputs, not an unspecified runtime semantic parser.
- Tool inference is included, not just capability inference.

### Runtime path explicitness

- Write explicit orchestration paths into `~/.cuttlefish/config.yaml` for:
  - `orchestration.enabled`
  - `orchestration.configDir`
  - `orchestration.dbPath`
  - `orchestration.worktreeRoot`
- This removes ambiguity between actual defaults and UI placeholder text.

## Planned Changes

### 1. Extend the org-worker bridge

Files:

- `packages/cuttlefish/src/gateway/org-worker-bridge.ts`
- `packages/cuttlefish/src/gateway/__tests__/org-worker-bridge.test.ts`
- potentially nearby orchestration/gateway tests that assert worker visibility or dispatch behavior

Changes:

- Keep existing hashed exact-match ids and exact-match capabilities intact.
- Add readable alias capabilities for every synthesized org worker:
  - `org_employee:<employee-name>`
- Add phrase-matched capability inference based on employee name/displayName/persona.
- Add phrase-matched tool inference based on employee name/displayName/persona.
- Keep bridge behavior fail-closed: unmatched employees still get existing minimal capabilities instead of invented elevated ones.
- Preserve board/manual dispatch compatibility because those flows use existing exact worker ids/roles.

Expected inferred profiles for this change set:

- `software-agent`
  - capabilities should include generic implementation-oriented entries such as `repo_edit`, `coding`, and `validation`
  - tools should include at least `git` and `filesystem`, with `shell` added only if required by the selected generic role design
- `adversarial-reviewer`
  - capabilities should include `code_review`, `adversarial_review`, and `bug_hunt`
  - tools should include at least `filesystem`

Guardrails:

- Do not let free-form persona matching expand into unbounded behavior.
- Keep the phrase map explicit in code and covered by tests.
- Ensure unknown employees are not accidentally granted implementation/review capabilities just because they contain vague words.

### 2. Update org employee runtime definitions

Files:

- `~/.cuttlefish/org/software/adversarial-reviewer.yaml`

Changes:

- Change `engine` from `claude` to `codex`.
- Set a Codex-backed model that matches the locally configured models.
- Preserve employee name, department, and persona unless a model-specific adjustment is truly necessary.

Reason:

- The bridge derives worker family from `employee.engine`.
- Opposite-family review cannot succeed until the reviewer is no longer in the Anthropic family.

### 3. Bootstrap orchestration config directory

Files to create under `~/.cuttlefish/orchestration/`:

- `workers.yaml`
- `roles.yaml`
- `coordinators.yaml`
- optionally `quotas.yaml`

#### `workers.yaml`

- Keep this minimal because org employees are the source of truth for the two target participants.
- Valid minimal structure is acceptable, for example an empty workers map.
- Do not duplicate `software-agent` or `adversarial-reviewer` here.

#### `roles.yaml`

- Add broader generic roles that can now match bridged org workers because of the new alias + phrase-matched inference.
- Minimum role set for this change:
  - a generic implementation role requiring implementation capabilities/tools
  - a generic adversarial review role requiring review capabilities/tools
  - if needed for the chosen coordinator mode, a generic independent reviewer role with `familyConstraint: opposite_of_implementer`
- Use `org_employee:<name>` capability aliases only where exact employee targeting is required.

Recommended shape:

- Generic implementation role:
  - capabilities like `repo_edit`, `coding`
  - tools like `git`, `filesystem`
- Generic adversarial review role:
  - capabilities like `adversarial_review`, `bug_hunt`
  - tools like `filesystem`
- If the team must target these exact two employees rather than any future generic matches, add dedicated roles that combine generic capabilities with the exact alias capability:
  - `org_employee:software-agent`
  - `org_employee:adversarial-reviewer`

#### `coordinators.yaml`

- Add a coordinator template that uses the implementation and review roles together.
- Because opposite-family review is required, the chosen reviewer role must either:
  - itself carry `familyConstraint: opposite_of_implementer`, or
  - be paired with a distinct independent-review role that carries the opposite-family rule
- Prefer one operator-facing team template that clearly communicates this pair's purpose.

Possible template shape:

- purpose: implementation with adversarial review
- required roles:
  - implementation role
  - reviewer role
- optional roles:
  - keep empty unless an extra QA/reviewer layer is explicitly desired

#### `quotas.yaml`

- Optional for bootstrap.
- Add only if runtime needs explicit family/provider concurrency caps from day one.
- Skip if unnecessary to keep initial config minimal.

### 4. Enable orchestration in runtime config

File:

- `~/.cuttlefish/config.yaml`

Add an explicit `orchestration:` block with at least:

- `enabled: true`
- `configDir: ~/.cuttlefish/orchestration`
- `dbPath: ~/.cuttlefish/orchestration.db`
- `worktreeRoot: ~/.cuttlefish/orchestration/worktrees`

Optional fields such as `maxWorktrees` can remain unset unless runtime behavior requires them.

Reason:

- The runtime will not bind without orchestration being enabled.
- `loadOrchestrationConfig()` requires `workers.yaml`, `roles.yaml`, and `coordinators.yaml`.
- Explicit paths eliminate ambiguity and align the runtime with the intended operator layout.

### 5. Verify runtime binding and worker visibility

Validation should prove:

- orchestration config loads cleanly
- runtime binds successfully on gateway boot
- bridged workers appear in runtime-backed worker listings
- no existing navigation or UI behavior regresses

Primary checks:

- rebuild Cuttlefish
- restart gateway/Cuttlefish runtime
- inspect `/api/orchestration/status`
- inspect `/api/orchestration/workers`
- inspect `/orchestration` dashboard worker list

Expected outcome:

- `runtimeBound: true`
- worker count includes the synthesized org workers
- worker entries for `software-agent` and `adversarial-reviewer` reflect their bridged families and inferred capabilities/tools

### 6. Preserve existing flows

Regression targets:

- board/manual dispatch using exact synthesized org-worker ids/roles
- gateway startup/reload with orchestration enabled
- orchestration observe routes fallback behavior

Specific concern:

- additive aliasing must not break `ticket-dispatch.ts`, `manager-auth.ts`, or any tests that depend on existing hashed org worker ids.

## Validation Plan

### Code-level validation

Run the most relevant tests first:

- org bridge unit tests
- ticket-dispatch orchestration tests
- orchestration run-mode/runtime tests affected by worker capability matching
- any route tests that assert worker visibility or runtime binding

Recommended commands from repo root:

```bash
pnpm --filter cuttlefish-cli test -- src/gateway/__tests__/org-worker-bridge.test.ts
pnpm --filter cuttlefish-cli test -- src/gateway/__tests__/ticket-dispatch-orchestration.test.ts
pnpm --filter cuttlefish-cli test -- src/orchestration/__tests__/run-mode.test.ts
pnpm --filter cuttlefish-cli test -- src/gateway/__tests__/orchestration-routes.test.ts
```

Then run broader required checks as appropriate for confidence:

```bash
pnpm typecheck
pnpm test
pnpm build
```

### Runtime validation

After config changes and rebuild:

1. Restart Cuttlefish/gateway.
2. Confirm startup does not log orchestration config load failures.
3. Open `/api/orchestration/status` and confirm runtime is bound.
4. Open `/api/orchestration/workers` and confirm bridged workers are visible.
5. Open `/orchestration` and confirm the worker list renders without UI regression.

### Functional validation

Use a concrete task brief through live runtime, for example `single_worker_with_review` against the new team template.

Success criteria:

- implementation role allocates to `software-agent`
- review role allocates to `adversarial-reviewer`
- reviewer family is opposite the implementer family
- allocation completes without fallback
- resulting sessions and review-policy output match the configured expectations

## Usage To Report After Implementation

The final implementation report should give the operator an exact usage path, not just file names.

At minimum, report:

- the final coordinator template id
- the final role ids
- the final engine/model selected for `adversarial-reviewer`
- the exact config paths written
- the exact command or API payload to run the team

Expected operator flow after implementation:

1. Ensure Cuttlefish is rebuilt and restarted with orchestration enabled.
2. Use a task file or API payload that references the new coordinator template.
3. Run the team through `cuttlefish run --mode single_worker_with_review --task <file>` or the `/orchestration` UI.
4. Verify both workers are visible in `/orchestration` and that the reviewer is cross-family.

## Risks And Mitigations

### Risk: persona inference is too broad

- Mitigation: use phrase-matched inference with explicit tests.
- Mitigation: keep unmatched employees on minimal capabilities/tools.

### Risk: additive aliasing accidentally changes current dispatch behavior

- Mitigation: do not replace or rename existing hashed ids/roles.
- Mitigation: keep exact board/manual dispatch tests green.

### Risk: opposite-family review still blocks

- Mitigation: explicitly move `adversarial-reviewer` to Codex before runtime verification.
- Mitigation: inspect `/api/orchestration/workers` for the bridged `family` values before running a task.

### Risk: operator confusion around worktree location

- Mitigation: set `orchestration.worktreeRoot` explicitly to the intended path in `config.yaml`.

### Risk: fallback observe routes hide missing bridged workers when runtime is not bound

- Mitigation: verify `runtimeBound: true` before using `/orchestration` worker visibility as proof of success.

## Out Of Scope

- broad redesign of orchestration core vocabulary
- replacing hashed internal ids with a new canonical identity system
- adding speculative policy beyond this bridge/bootstrap path
- changing unrelated org employees

## Definition Of Done

- `adversarial-reviewer` is moved to a Codex family engine/model.
- org-worker bridge emits readable `org_employee:<name>` aliases while preserving existing hashed ids.
- bridged workers infer the capabilities and tools needed for the agreed generic roles.
- `~/.cuttlefish/orchestration/{workers,roles,coordinators}.yaml` exists and loads.
- `~/.cuttlefish/config.yaml` explicitly enables orchestration and points to the intended paths.
- runtime binds successfully after rebuild/restart.
- `/api/orchestration/workers` and `/orchestration` show the bridged workers.
- a live implementation+review run can allocate the two participants under opposite-family review semantics.
- existing board/manual org dispatch behavior remains intact.
