# Roles + Skills Architecture Proposal — Source-Grounded Review

- **Date:** 2026-08-31
- **Type:** design review (analysis only — no code changed)
- **Subject:** an external proposal to layer `MODE → ROLE → SKILLS → provider adapter`
  onto Cuttlefish via a component named "Tagteam", and to "implement Skills
  before adding more roles"
- **Method:** read-only inspection of this checkout (`packages/cuttlefish/src/orchestration/`,
  `packages/cuttlefish/src/cli/skills.ts`, `packages/cuttlefish/src/gateway/`,
  `docs/orchestration/`, `governance/`). No build, test, or lint run — see
  [Validation status](#validation-status).
- **Status of conclusions:** findings are source-grounded with file/line evidence.
  Courses of action are proposals, not decisions; nothing here is implemented.

---

## 1. Executive summary

The proposal's **direction is right and its core recommendation is already
largely satisfied**: Cuttlefish ships a skills subsystem, and its orchestration
roles are already open and config-driven. The proposal's stated premises,
however, do not match this checkout in four places, and one of those mismatches
inverts its sequencing advice.

**The headline correction:** the proposal says *"implement Skills before adding
more roles."* The evidence says **implement declarative role traits before
either.** Role semantics today are inferred by *substring matching on role IDs*
(`roleId.toLowerCase().includes("review")`). Adopting the proposal's own
vocabulary — renaming `tester` to `verifier`, adding `debugger` and `security` —
would silently disable the cross-family reviewer policy and the `architecture`
mode preconditions. That is a fail-open quality control, and it triggers on the
proposal's very first rename.

**The headline gap:** skills are delivered **globally, not per role.** The
daemon symlinks *every* installed skill into *every* engine home
(`gateway/watcher.ts`). There is no enforcement point where "role `reviewer`
gets skills `code-review`, `adversarial-review`" could take effect. The
proposal's central mechanism — the skill differentiating the role — is the one
piece of machinery that does not exist yet.

Recommended path: **COA-B** (data-only role↔skill binding + declarative role
traits), deferring the full three-axis model.

---

## 2. Claims in the proposal vs. what this checkout contains

| # | Proposal claim | Verified status | Evidence |
|---|---|---|---|
| C1 | "Cuttlefish … already integrates Tagteam" | **Not found.** A case-insensitive search for `tag.?team` across the repo (excluding `node_modules`/`.git`) returns zero matches. The capabilities attributed to Tagteam (run loop, artifacts, role dispatch, capability routing, recovery, quality gates) all exist — inside Cuttlefish's own `orchestration` package. | `packages/cuttlefish/src/orchestration/{scheduler,coordinator,artifacts,recovery-requeue,store-recovery}.ts` |
| C2 | "Tagteam's current architecture already has a closed Role vocabulary" | **Inverted.** The role vocabulary is *open*: roles are parsed from an operator-supplied `roles.yaml`, and `RoleDefinition.id` is a free string. What *is* closed is the **mode** vocabulary — five allocation modes and five live-run modes. | `orchestration/config.ts:42`; `orchestration/types.ts` (`RoleDefinition`); `orchestration/coordinator.ts:15`; `orchestration/live-run.ts:1` |
| C3 | "supervisor / worker / scout" are the current Tagteam roles | **Not the shipped vocabulary.** The template roles are `architect`, `seniorImplementer`, `independentReviewer`, `adversarialReviewer`, `qaGate`, `localTriage`. `supervisor` is a concept in the *org* system (`reportsTo` chains), not the orchestration role set; `scout` does not appear. | `docs/orchestration/examples/roles.yaml`; `packages/cuttlefish/template/orchestration/roles.yaml`; `gateway/org-validation.ts:36,388` |
| C4 | "I would make Skills the main extension … implement Skills before adding more roles" | **Already shipped, in part.** Skills exist as a CLI (`add`/`find`/`list`/`update`), a pinned manifest, a filesystem convention, live hot-reload, HTTP routes, a dashboard catalog, and a dedicated prompt-injection screening path. | `cli/skills.ts` (400 lines); `gateway/api/routes/skills.ts`; `gateway/watcher.ts:123-137`; `gateway/content-screening.ts`; `docs/USER_MANUAL.md:91-102`; `README.md:307` |
| C5 | "skills should be provider-independent … the provider supplies intelligence" | **True in format, not in delivery.** Skills *are* provider-neutral Markdown (`SKILL.md`). Delivery is provider-*specific*: the sync writes symlinks into exactly two well-known homes. | `gateway/watcher.ts:29`; `shared/paths.ts:95-96` |

**C1 is the one to resolve first.** Three of the proposal's design decisions
are justified by "Tagteam already has X". If Tagteam is an external system not
present in this checkout, those justifications are unverified; if "Tagteam" is
a name for Cuttlefish's own orchestration package, the proposal is describing a
component whose actual role model differs from the one it assumes (C2, C3).
Either way, name the real component before building on it.

---

## 3. What actually exists today

Three overlapping vocabularies already describe "who does what". Any new
taxonomy must be mapped onto these, not laid beside them.

1. **Capability** (`orchestration/types.ts`) — a free-form string on both
   `Worker.capabilities` and `RoleDefinition.requiredCapabilities`. This is the
   **routing** vocabulary: the scheduler admits a worker to a role iff
   `role.requiredCapabilities ⊆ worker.capabilities`
   (`orchestration/scheduler.ts:424`). Examples in use: `repo_edit`, `coding`,
   `architecture`, `system_design`, `code_review`, `adversarial_review`,
   `bug_hunt`, `validation`, `triage`, `test_log_triage`, `duplicate_detection`.
2. **Role** (`roles.yaml`) — a named bundle of required capabilities, required
   tools, and routing constraints (`familyConstraint: opposite_of_implementer`,
   `preferredTiers`, `preferredCostClasses`), consumed by coordinator templates.
3. **Employee** (`shared/types/operations.ts:86-111`) — the org system's
   `rank` (`executive|manager|senior|employee`), `department`, `persona`,
   `engine`, `model`, `reportsTo`. This is where "supervisor" actually lives.

And separately:

4. **Skill** — a Markdown playbook in `~/.cuttlefish/skills/<name>/SKILL.md`,
   installed via `cuttlefish skills add`, pinned in `~/.cuttlefish/skills.json`,
   and symlinked into `~/.claude/skills/` and `~/.agents/skills/` by the daemon
   watcher on change.

**The critical observation:** capabilities answer *"can this provider do it?"*
(routing). The proposal's skills answer *"how is it done?"* (procedure). Both
are legitimate and both are needed — but the proposal's skill list
(`system-design`, `dependency-analysis`, `architecture-review`, `implementation`,
`testing`, `debugging`, `code-review`, `regression-analysis`) overlaps the
existing capability list almost token-for-token. Introduced without an explicit
mapping, it becomes a **second routing vocabulary that silently disagrees with
the first**.

---

## 4. Findings

### F1 — Skills are globally scoped; there is no role↔skill binding point (High)

- **Observed:** `syncSkillSymlinks()` enumerates every directory under
  `SKILLS_DIR` and links each one into `CLAUDE_SKILLS_DIR` and
  `AGENTS_SKILLS_DIR` (`gateway/watcher.ts:28-76`), with a recursive-copy
  fallback where symlinks are unavailable. Stale links are pruned; nothing is
  filtered. There is no session-, role-, or employee-scoped skill set anywhere
  in the tree.
- **Expected under the proposal:** a `reviewer` invocation sees
  `code-review`, `architecture-review`, `adversarial-review` and *not*
  `implementation`.
- **Impact:** the proposal's core mechanism ("the skill determines how it
  performs the role") has no enforcement point. Writing `skills:` under a role
  in YAML today would be inert documentation. It also forecloses least-privilege:
  a read-only reviewer is handed the implementation playbooks regardless.
- **Remediation:** see COA-B (advisory binding via the per-session prompt path)
  and COA-D (hard filesystem scoping).

### F2 — Role semantics are inferred by substring matching on role IDs (High)

- **Observed:** the coordinator and cross-family policy classify roles by name
  first, capabilities second:
  - `isImplementer` — `roleId.includes("implementer")`, else `repo_edit`/`coding` (`coordinator.ts:128-132`)
  - `isReviewer` — `roleId.includes("review")`, else `code_review` or `familyConstraint === "opposite_of_implementer"` (`coordinator.ts:134-138`, duplicated at `cross-family.ts:30-34`)
  - `isArchitect` — `roleId.includes("architect")`, else `architecture`/`system_design` (`coordinator.ts:188-192`)
  - `isAdversarialReviewer` — `roleId.includes("adversarial")` (`coordinator.ts:201-205`)
  - `isQa` — `roleId.includes("qa")` (`coordinator.ts:207-211`)
- **Expected:** role kind is declared, not guessed from the identifier.
- **Impact — this fires on the proposal's own vocabulary:**
  - `verifier` matches **no** reviewer or QA predicate by name. Unless it
    declares `code_review`/`validation` capabilities, `single_worker_with_review`
    throws `"requires a reviewer role"`, and — worse — the **cross-family
    reviewer policy is a quality/independence control that would simply not
    apply**, without an error. Fail-open.
  - `security` and `debugger` match nothing at all; in `architecture` mode they
    are ignored when the required five are selected (`coordinator.ts:146-160`).
  - Conversely, a role innocently named `preview-generator` is classified as a
    **reviewer** (contains "review"), and can be handed a cross-family
    constraint it was never meant to carry.
- **Remediation:** add an explicit, optional `kind` (or `traits: []`) field to
  `RoleDefinition`, resolve by `kind` first and fall back to today's heuristics
  for backward compatibility. This is a small, contained change and it is the
  **prerequisite for any new role name**, including the proposal's.

### F3 — New roles/skills are a governed agent surface (Medium-High)

- **Observed:** `governance/agent_registry.yaml` declares
  `registry_mode: "authoritative"` and `undeclared_agent_surface: "forbidden"`.
  Each existing orchestration worker has a registry entry pointing at an
  agent-instruction document under `docs/orchestration/agent-instructions/`
  (`codex-architect.md`, `codex-implementer.md`, `claude-reviewer.md`,
  `antigravity-reviewer.md`, `local-worker.md`).
- **Impact:** a skill that carries operating procedure ("Procedure: 1. identify
  affected components … Output: architecture_review.json") is an agent surface
  in substance. Shipping a skill catalogue without registry entries would put
  the repo in violation of its own governance posture.
- **Remediation:** decide up front whether skills are (a) registry-declared
  surfaces with instruction docs, or (b) explicitly out of registry scope with
  a documented rationale under `governance/exceptions.yaml`. Do not leave it
  implicit.

### F4 — A checked-in engineering-role taxonomy conflicts with a stated extension rule (Medium)

- **Observed:** `docs/ARCHITECTURE.md:117-120` — *"Keep downstream program
  vocabulary, policy examples, and release semantics out of tracked generic
  source, templates, and operator docs; program-specific specialization belongs
  in external policy packs."*
- **Impact:** baking `architect / developer / verifier / reviewer / scout` and
  their skill sets into `packages/cuttlefish/template/orchestration/roles.yaml`
  is exactly the specialization that rule pushes outward. Cuttlefish is
  described in `AGENTS.md` as *"a bus, not a brain."*
- **Remediation:** ship the taxonomy as an **external, versioned policy pack**
  (a roles/skills bundle installable via the existing skills manifest), leaving
  the tracked template minimal. This also preserves the proposal's own goal:
  different teams want different role sets.

### F5 — Skills are privileged control-plane state, and the proposal multiplies them (Medium)

- **Observed:** the skills directory is defended as control plane —
  `gateway/hook-endpoint.ts:50,76` list it among protected paths; `:241` returns
  `451` for direct writes ("use the approval pipeline"); `:265` blocks Bash
  commands that read or write it. `gateway/scoped-token.ts:109` treats any
  non-`GET` on `/api/skills` as an operator-wide mutation.
  `gateway/content-screening.ts:123-131` grants lenient screening to skill files
  **by provenance only** — a comment there records the audit finding (D-F3/G-07)
  that naming an uploaded file `skill.md` or nesting it under any `skills/` path
  must not confer trust.
- **Impact:** "make Skills the main extension point" means "grow the number of
  privileged, leniently-screened, prompt-injection-relevant artifacts, installed
  from third-party sources via `npx skills add`." The existing defences are
  sound; the proposal increases the surface they must hold.
- **Remediation:** keep provenance-based trust exactly as is; require a human
  review gate and manifest pinning (`SKILLS_NPX_SPEC` is already version-pinned
  at `cli/skills.ts:16`) for any skill that carries procedure a role will
  execute; never let a role definition install a skill implicitly.

### F6 — "Provider-independent" is true of the format, not the delivery (Medium)

- **Observed:** `packages/cuttlefish/src/engines/` contains adapters for
  claude, codex, antigravity, aider, grok, hermes, kilo, kiro, ollama, pi, vibe,
  mock. The watcher syncs skills into exactly two homes: `~/.claude/skills` and
  `~/.agents/skills` (`shared/paths.ts:95-96`). Note the asymmetry: the skills
  CLI *reads* `~/.codex/skills` when detecting already-installed skills
  (`cli/skills.ts:20-23`) but the daemon never *writes* there.
- **Impact:** the proposal's "provider adapter" box at the bottom of its diagram
  is, in practice, a filesystem convention that two engine families honour. A
  role whose behaviour depends on a skill will behave differently — silently —
  depending on which engine the scheduler routes it to. That directly undercuts
  cross-family review, where the *point* is that a different provider looks at
  the work.
- **Remediation:** publish a per-engine skill-delivery matrix before promising
  provider independence, and add an engine-agnostic fallback: inject the skill
  text through the per-session prompt path rather than relying on discovery.
  A precedent exists but is engine-specific — `--append-system-prompt` for
  Claude (`engines/claude-interactive-args.ts:46`,
  `engines/claude-interactive.ts:446-448`); other engines receive context via
  `sessions/context.ts`.

### F7 — Orchestration CLI command groups are not registered (Low-Medium)

- **Observed:** `docs/orchestration/README.md` carries a verified (2026-07-20)
  note that the handlers exist but the binary does not register `workers`,
  `scheduler`, `run`, `queue`, `dual-lane`, or `worktree`; operations must go
  through the authenticated API/dashboard.
- **Impact:** any role/skill workflow documented as CLI steps is blocked today.
- **Remediation:** treat binary registration as a prerequisite for a
  CLI-facing rollout, or scope the rollout to API/dashboard.

### F8 — The proposal's "Mode" axis collides with two existing mode vocabularies (Low)

- **Observed:** `CoordinatorMode = matrix | single_worker |
  single_worker_with_review | architecture | local_heavy`
  (`coordinator.ts:15`); `LIVE_RUN_MODES = single_worker |
  single_worker_with_review | dual_lane | architecture | local_heavy`
  (`live-run.ts:1`). These are **allocation shapes** (how many workers, in which
  roles, under which family constraint).
- **Impact:** the proposal's modes (`supervisor`, `relay`, `solo`,
  `adversarial`) are **collaboration protocols** — a different axis wearing the
  same word. `solo` ≈ `single_worker` and `adversarial` ≈ part of `architecture`,
  so the overlap is partial and therefore more confusing than a clean split.
- **Remediation:** if the axis is wanted, name it something else
  (`collaboration` / `protocol`) and state its relationship to the existing
  modes explicitly.

---

## 5. Courses of action

### COA-A — Document only; change no code

Write down the existing Capability / Role / Employee / Skill model, correct the
"Tagteam" naming, and close the vocabulary gap in `docs/ARCHITECTURE.md`.

- **Pros:** zero risk; resolves C1-C5 (the misunderstandings that generated the
  proposal); cheapest; makes any later decision better informed.
- **Cons:** delivers no new behaviour; the F1 and F2 defects remain latent.
- **Effort:** small. **Risk:** none. **Reversible:** trivially.

### COA-B — Declarative role traits + data-only role↔skill binding *(recommended)*

Two contained changes, in this order:

1. **B1 (prerequisite):** add optional `kind`/`traits` to `RoleDefinition`;
   have `coordinator.ts` and `cross-family.ts` resolve by declaration first and
   fall back to the current heuristics. Fixes F2. Independently worth doing.
2. **B2:** add optional `skills: string[]` to `RoleDefinition`; at dispatch,
   resolve names against the installed manifest and inject an explicit
   "for this role, apply these skills" block through the existing per-session
   prompt path. Advisory (the model is *told* which skills apply); the global
   symlink set is unchanged.

- **Pros:** no new orchestration layer, exactly as the proposal advocates;
  reuses the shipped skills subsystem, scheduler, leases, artifacts and
  recovery; B1 removes the fail-open control in F2 *before* anyone introduces
  `verifier`; delivery is engine-agnostic (mitigates F6); no new privileged
  surface (F5 unchanged); role/skill data can ship as an external pack (F4).
- **Cons:** advisory only — a model may ignore the block, so this is **not**
  least-privilege and does not satisfy anyone who reads "role gets these skills"
  as an isolation guarantee; adds a validation seam (unknown skill names) and a
  new failure mode (role references an uninstalled skill).
- **Effort:** small-to-medium. **Risk:** low. **Reversible:** yes — both fields
  are optional and additive.
- **Mitigations:** validate `skills:` against the manifest at config load and
  fail loudly, not silently; state plainly in docs that binding is advisory.

### COA-C — Full three-axis Mode / Role / Skill model as proposed

- **Pros:** conceptually clean; matches the proposal as written; the
  decomposition is genuinely good design *in the abstract*.
- **Cons:** collides with two existing mode vocabularies (F8) and a third
  role-ish vocabulary in the org system; needs registry work (F3) and conflicts
  with the "no downstream vocabulary in tracked source" rule (F4); still
  requires B1 and B2 as substrate, so it is strictly more work than COA-B with
  no additional near-term capability.
- **Effort:** large. **Risk:** medium-high (touches coordinator, scheduler
  inputs, config schema, docs, governance). **Reversible:** partly — a config
  schema change is a compatibility commitment.
- **Verdict:** defer until COA-B is in use and a concrete need for the third
  axis has been observed.

### COA-D — Hard per-session skill scoping

Replace the global symlink fan-out with a per-session skills directory
containing only the skills bound to the invocation's role.

- **Pros:** the only option that makes role↔skill binding *real*; enables
  least-privilege (a read-only reviewer never sees implementation playbooks);
  directly fixes F1.
- **Cons:** largest blast radius — rewrites `syncSkillSymlinks()` and its
  Windows copy fallback, changes engine home layout, and risks breaking skill
  discovery for interactive (non-orchestrated) sessions; per-session
  materialisation costs I/O on every session start; the copy fallback duplicates
  skill content per session on platforms without symlink permission.
- **Effort:** large. **Risk:** high. **Reversible:** yes, but only with care.
- **Mitigations if pursued:** keep the global set as the default and make
  scoping opt-in per role; land it behind the existing `orchestration.enabled`
  daemon gate; add regression cover for the Windows copy path before touching it.

---

## 6. Recommendation

1. **COA-A now** — correct the record (C1-C5). Cheap, and it prevents a design
   built on a component that is not in this checkout.
2. **COA-B1 next, before any new role names** — declarative role traits. This
   inverts the proposal's sequencing for a concrete reason: the proposal's own
   vocabulary (`verifier`, `security`, `debugger`) trips F2 on introduction, and
   the failure is silent.
3. **COA-B2 after that** — advisory role↔skill binding, shipped as an external
   policy pack rather than checked into the template (F4), with `skills:`
   validated against the manifest at load.
4. **Defer COA-C.** Revisit only if the collaboration axis proves necessary in
   practice, and rename it to avoid the `mode` collision.
5. **Treat COA-D as a separate, later decision** driven by a least-privilege
   requirement, not by the desire for role differentiation — COA-B already
   delivers the differentiation.

**Endorsed without reservation from the proposal:** do not create thirty
engineering roles; do not create one agent per test type; keep skills
provider-neutral in content; keep capability in reusable playbooks rather than
in new worker implementations. Those instincts match this repo's existing
design, including its already-shipped skills subsystem.

---

## 7. Potential problems and open questions

1. **What is Tagteam?** External product, internal codename, or a name for
   Cuttlefish's `orchestration` package? Every "Tagteam already does X"
   justification in the proposal is unverified until this is answered.
2. **Do skills route, or only instruct?** If a role requires skill
   `numerical-validation`, does that constrain *worker selection* (making skills
   a routing vocabulary that duplicates `Capability`) or only the prompt? The
   proposal is silent; COA-B assumes prompt-only. Answer this before schema work.
3. **What happens when a bound skill is missing?** Fail the allocation, or
   degrade and proceed? There is precedent for explicit degradation policy —
   `reviewerLossPolicy: replace_then_degrade`
   (`shared/types/operations.ts:240-241`) — and it should be followed rather
   than improvised.
4. **Which vocabulary wins on conflict?** A role declaring
   `requiredCapabilities: [code_review]` and `skills: [implementation]` is
   incoherent. Validation should reject it; today nothing would.
5. **Third-party skill trust.** If skills carry the operating procedure for
   roles that edit repositories, an installed skill becomes remote code
   influence over an agent with `repo_edit`. The provenance model in
   `content-screening.ts` is the right foundation; a review gate on
   procedure-bearing skills is a necessary addition.
6. **Org system vs. orchestration roles.** `Employee.rank`/`persona` and
   `RoleDefinition` are two separate answers to "who is this agent". The
   proposal addresses only the second. Left unreconciled, operators will have to
   configure the same intent twice.
7. **Skill versioning.** `README.md:327` lists skill versioning as roadmap, not
   shipped. Binding roles to skill *names* without versions means a
   `skills update` can change a role's behaviour with no diff in the role
   config. Pin skills in `skills.json` if roles depend on them.

---

## 8. Validation status

- **Ran:** nothing. This is an analysis task under `AGENTS.md` audit rules
  ("write findings and evidence; do not patch code unless explicitly
  instructed"). `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build`
  were **not** run, and no source file was modified — only this document and the
  `docs/INDEX.md` link to it.
- **Evidence basis:** direct file reads at the paths and lines cited above,
  in this checkout at branch `claude/cuttlefish-roles-skills-euxbrt`.
- **Not verified:** runtime behaviour of the symlink sync on Windows; whether
  any engine outside the Claude and AGENTS families discovers skills by another
  mechanism not visible in the source; anything about "Tagteam" as an external
  system.

## 9. Residual risks and disclosures

- **Giles / Dory waived.** Per `CLAUDE.md`, cloud/remote agents without local
  Giles access may skip the `.giles/feature-ledger/` requirement; no ledger
  entry was written and no compliance status is claimed here. Canonical
  compliance data remains under `governance/logs/`.
- **Artifact placement deviation, disclosed.** `AGENTS.md` routes durable audit
  summaries to `docs/audits/` and session logs to `docs/logs/session/<MMYYYY>/`.
  Both trees are git-ignored (`.gitignore:27-28`), so a report that must be
  committed and pushed cannot live there. This review is therefore placed in the
  tracked `docs/plans/` tree alongside the existing design and verification
  plans, and linked from `docs/INDEX.md` as the documentation rules require. A
  local-only session note was also written under
  `docs/logs/session/082026/` on the machine that produced this report; it is
  not part of the published repo.
- **No decision is recorded.** Nothing here is entered in
  `docs/DECISION_LOG.md`; selecting a course of action is the operator's call.
