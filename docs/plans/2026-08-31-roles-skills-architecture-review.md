# Roles + Skills Architecture Proposal — Source-Grounded Review

- **Date:** 2026-08-31
- **Type:** design review (analysis only — no code changed)
- **Subject:** an external proposal to layer `MODE → ROLE → SKILLS → provider adapter`
  onto Cuttlefish via a component named "Tagteam", and to "implement Skills
  before adding more roles"
- **Method:** read-only inspection of this checkout (`packages/cuttlefish/src/orchestration/`,
  `packages/cuttlefish/src/cli/skills.ts`, `packages/cuttlefish/src/gateway/`,
  `docs/orchestration/`, `governance/`). No build, test, or lint run — see
  [Validation status](#8-validation-status).
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
more roles."* The evidence suggests **declarative role traits belong ahead of
both.** Role semantics resolve by declared `requiredCapabilities` but *fall back
to substring matching on role IDs* (`roleId.toLowerCase().includes("review")`).
The proposal's vocabulary — renaming `tester` to `verifier`, adding `debugger`
and `security` — is therefore workable today **only** where each role also
declares the right capabilities; where it does not, the cross-family reviewer
policy and `architecture`-mode preconditions degrade with no error. Adding the
roles first is possible; doing traits first is what makes it safe by
construction rather than by care. See F2 for the precise boundary.

**The headline gap:** skills are delivered **globally, not per role.** The
daemon symlinks *every* installed skill into the two synchronized discovery
homes — `~/.claude/skills` and `~/.agents/skills` (`gateway/watcher.ts`) — with
no filtering by role or session. Engines that read neither home get no skills at
all (F6). So the delivery is all-or-nothing in both directions: unfiltered where
it reaches, absent where it does not. There is no enforcement point where "role
`reviewer` gets skills `code-review`, `adversarial-review`" could take effect.
The proposal's central mechanism — the skill differentiating the role — is the
one piece of machinery that does not exist yet.

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
- **Scope of the impact (stated precisely, cf. F6):** this is global *within
  the two synchronized homes*, not across every engine. For engines that read
  `~/.claude/skills` or `~/.agents/skills`, every session sees every skill —
  that is where the least-privilege concern bites: a read-only reviewer is
  handed the implementation playbooks regardless. For the remaining adapters,
  the problem is the opposite one in F6: they may discover no skills at all.
  Neither case gives a role a *specific* skill set.
- **Impact:** the proposal's core mechanism ("the skill determines how it
  performs the role") has no enforcement point. Writing `skills:` under a role
  in YAML today would be inert documentation.
- **Remediation:** see COA-B (advisory binding via the per-session prompt path)
  and COA-D (hard filesystem scoping).

### F2 — Role semantics fall back to substring matching on role IDs (Medium-High)

- **Observed:** the coordinator and cross-family policy classify roles by name
  first, capabilities second:
  - `isImplementer` — `roleId.includes("implementer")`, else `repo_edit`/`coding` (`coordinator.ts:128-132`)
  - `isReviewer` — `roleId.includes("review")`, else `code_review` or `familyConstraint === "opposite_of_implementer"` (`coordinator.ts:134-138`, duplicated at `cross-family.ts:30-34`)
  - `isArchitect` — `roleId.includes("architect")`, else `architecture`/`system_design` (`coordinator.ts:188-192`)
  - `isAdversarialReviewer` — `roleId.includes("adversarial")` (`coordinator.ts:201-205`)
  - `isQa` — `roleId.includes("qa")` (`coordinator.ts:207-211`)
- **Expected:** role kind is declared, not guessed from the identifier.
- **What still works (stated so this is not overread):** every predicate falls
  back to declared `requiredCapabilities`, and reviewer detection additionally
  accepts `familyConstraint: opposite_of_implementer`. A freely named role such
  as `verifier` therefore works **today**, with no schema change, provided it
  declares `code_review`, `validation`, or the applicable family constraint.
  Renaming roles is not blocked.
- **Impact — a silent, name-driven misconfiguration hazard:**
  - `verifier` matches no reviewer or QA predicate *by name*. Configured with
    the right capabilities it behaves correctly; configured without them,
    `single_worker_with_review` throws `"requires a reviewer role"` — and, in
    the mixed case, the **cross-family reviewer policy simply does not apply**,
    with no error. That path is fail-open, and nothing in the config surface
    warns the operator.
  - `security` and `debugger` match nothing by name; in `architecture` mode
    they are ignored when the required five are selected
    (`coordinator.ts:146-160`).
  - Conversely, a role innocently named `preview-generator` is classified as a
    **reviewer** (contains "review"), and can be handed a cross-family
    constraint it was never meant to carry. This direction is not fixable by
    careful capability declaration — the name alone decides it.
- **Remediation:** add an explicit, optional `kind` (or `traits: []`) field to
  `RoleDefinition`, resolve by `kind` first and fall back to today's heuristics
  for backward compatibility. This is a small, contained change. It is
  **strongly advisable before growing the role vocabulary** — it removes the
  substring fallback and makes the coupling between a role's name and its
  enforced controls explicit — but it is **not a hard prerequisite**: new roles
  can be added safely today by declaring capabilities carefully.

### F3 — Procedure-bearing skills sit outside the registry's current scope (Low-Medium, open question)

- **Observed:** `governance/agent_registry.yaml` declares
  `registry_mode: "authoritative"` and `undeclared_agent_surface: "forbidden"`.
  Each existing orchestration worker has a registry entry pointing at an
  agent-instruction document under `docs/orchestration/agent-instructions/`
  (`codex-architect.md`, `codex-implementer.md`, `claude-reviewer.md`,
  `antigravity-reviewer.md`, `local-worker.md`).
- **Scope, precisely:** the enforcing rule is narrower than the registry
  header suggests. `governance/giles_ruleset.yaml` AGENT-002
  (`undeclared_agent_surface_forbidden`, severity `warn`) defines the surface
  as *"any file under `docs/orchestration/agent-instructions/` not declared in
  `agent_registry.yaml`"*, and `governance/schema_registry.yaml` scopes
  `agent.delegate.v1` to that same directory. Runtime skills under
  `~/.cuttlefish/skills/` are **outside** that scope today.
- **Impact — an open question, not a violation:** a skill that carries
  operating procedure ("Procedure: 1. identify affected components … Output:
  `architecture_review.json`") resembles an agent surface *in substance* while
  falling outside the registry's declared *scope*. Shipping a skill catalogue
  therefore breaches no current rule; the question is whether the registry
  should be extended to cover procedure-bearing skills.
- **Remediation:** treat this as a policy decision to make deliberately, not a
  compliance gap to remediate. No registry entries or
  `governance/exceptions.yaml` entries are required under the rules as written;
  do not add them on the strength of this report alone.

### F4 — Generic roles belong in the template; only program-specific vocabulary goes external (Low)

- **Corrected finding.** An earlier revision claimed that adding the proposal's
  roles to the tracked template would conflict with a stated extension rule, and
  pushed the taxonomy toward an external policy pack. That reasoning does not
  hold and the conflict claim is withdrawn.
- **Observed:** `docs/ARCHITECTURE.md:117-120` excludes *"downstream **program**
  vocabulary, policy examples, and release semantics"* from tracked generic
  source, and says *"**program-specific** specialization belongs in external
  policy packs."* The operative qualifier is program-specific.
- **Why the earlier reading was wrong:** the shipped generic template already
  defines six engineering roles —
  `packages/cuttlefish/template/orchestration/roles.yaml` carries `architect`
  (:5), `seniorImplementer` (:13), `independentReviewer` (:25),
  `adversarialReviewer` (:37), `qaGate` (:47), `localTriage` (:56). The
  proposal's `architect / developer / verifier / reviewer / scout` is the same
  genus of generic engineering vocabulary, and nothing establishes it as
  downstream- or program-specific. The rule does not bite.
- **What the rule does still constrain:** a role set carrying a *particular
  organisation's* program names, policy examples, or release semantics. Keep
  that out of the tracked template.
- **Remediation:** add generic roles through the **existing template extension
  point** (`template/orchestration/roles.yaml` plus a coordinator template),
  which is the documented path and needs no new machinery. Do **not** route
  them through an external policy pack: that delivery mechanism is **not
  implemented** — `skillsAdd()` installs one skill *directory* into `SKILLS_DIR`
  and records only `{name, source, installedAt}`
  (`cli/skills.ts:68-83,239-278`), and no inspected code imports a bundled
  `roles.yaml` into orchestration config. Reserve an external pack for the
  program-specific case, and design the installer path if that case ever
  arrives.

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
- **What screening does *not* cover:** that provenance logic runs only where
  content is explicitly processed — inbound text and run attachments
  (`gateway/server.ts:483,567`, `gateway/run-attachments.ts:17`,
  `gateway/ticket-dispatch.ts:23`). Neither `skillsAdd()` nor
  `syncSkillSymlinks()` invokes it, and an engine reading `SKILL.md` from its
  own skills home never passes through Cuttlefish at all. Installed skill
  content is therefore **unscreened on the normal path**; the control-plane
  protections above guard *who may write* the directory, not *what the file
  says*.
- **Impact:** "make Skills the main extension point" means "grow the number of
  privileged, leniently-screened, prompt-injection-relevant artifacts, installed
  from third-party sources via `npx skills add`." The existing defences are
  sound; the proposal increases the surface they must hold.
- **Skill content is not pinned today.** `SKILLS_NPX_SPEC = "skills@1.5.12"`
  (`cli/skills.ts:16`) pins the *installer CLI*, and only in the `--version`
  probe at `cli/setup.ts:53` — the install path itself spawns
  `npx skills add …` with no version spec (`cli/skills.ts:151,174-177`). The
  manifest stores the caller-supplied `source` with no resolved version and no
  content hash, and `skillsUpdate()` simply re-runs that source
  (`cli/skills.ts:329-361`), so an unpinned source can change content between
  runs.
- **Remediation:** keep provenance-based trust exactly as is; require a human
  review gate for any skill that carries procedure a role will execute; never
  let a role definition install a skill implicitly. If role behaviour is to
  depend on skill content, add real content pinning — immutable source
  references or verified hashes recorded in the manifest. Do not rely on
  `SKILLS_NPX_SPEC` for this: it is installer-only pinning and gives no
  guarantee about the skill being installed.

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
  provider independence. An engine-agnostic fallback — injecting the skill text
  through the per-session prompt path rather than relying on filesystem
  discovery — would close the gap; a precedent exists but is engine-specific
  (`--append-system-prompt` for Claude, `engines/claude-interactive-args.ts:46`
  and `engines/claude-interactive.ts:446-448`; other engines receive context via
  `sessions/context.ts`).
- **Trade-off, stated here so the two findings are read together:** that
  fallback is COA-B2b, and it is not free. Inlining third-party skill text into
  every routed engine's prompt bypasses the provenance-based filesystem
  screening in F5 and creates a new untrusted-content path. Closing F6 this way
  widens F5; the screening gate and content pinning F5 asks for become
  prerequisites, not optional extras.

### F7 — A stale note in `docs/orchestration/README.md` contradicts the shipped CLI (Low)

- **Corrected finding.** An earlier revision of this report claimed the
  orchestration command groups were unregistered and that a CLI-facing rollout
  was therefore blocked. That was wrong: it trusted a document instead of the
  binary. The claim is withdrawn.
- **Observed (source of truth):** `packages/cuttlefish/bin/cuttlefish.ts`
  registers every group — `workers` (:209), `scheduler` (:225), `queue` (:290),
  `run` (:330), `dual-lane` (:342), `worktree` (:489) — alongside `leases`,
  `holds`, `artifacts`, `continuations`, and `recovery`. A regression test
  pins this: `src/cli/__tests__/orchestration-cli-registration.test.ts`
  (TS-RIG-001) builds the shipped binary and asserts all eleven groups appear
  in `--help`. `docs/feature_inventory.md:381-403` documents the commands as
  available.
- **The actual defect:** `docs/orchestration/README.md:3-8` still carries a
  *"CLI exposure note (verified 2026-07-20)"* stating that the binary "does not
  currently register their command groups" and that the CLI examples are
  "blocked until binary registration is repaired." The registration was
  repaired; the note was never removed, and it now contradicts both the binary
  and its own regression test.
- **Impact:** an operator reading the orchestration README is told a working
  CLI surface is unusable, and is steered to the API/dashboard unnecessarily.
  This is the failure mode `AGENTS.md` targets with *"keep documentation
  aligned with current behavior."* It is also how this report went wrong, which
  is the more transferable lesson: verify against source, not against a doc.
- **Remediation:** delete the stale note from `docs/orchestration/README.md`.
  Deliberately **not** done in this change set — it is an unrelated
  documentation fix and belongs in its own commit rather than inside a review
  report. No constraint on a role/skill rollout follows from this finding.

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
   resolve names against the **installed skill directories** and inject an
   explicit "for this role, apply these skills" block through the existing
   per-session prompt path. Advisory (the model is *told* which skills apply); the global
   symlink set is unchanged.

**B2 must choose what the block carries — the two variants differ in both
reach and trust, and no single option has both properties:**

- **B2a — names only.** The block names the skills; the engine loads the
  content from its own skills home. **Reach:** only engines that read
  `~/.claude/skills` or `~/.agents/skills`; elsewhere the named skill is a
  dangling reference, so this does **not** mitigate F6. **Trust:** adds no new
  path — but note what the existing path is *not*. Native discovery is
  **unscreened**: neither `skillsAdd()` nor `syncSkillSymlinks()` invokes
  content screening, and the engine reads `SKILL.md` from its own home without
  Cuttlefish seeing it. `screenUntrustedText` / `screenAttachmentContent` are
  wired into inbound text and run attachments
  (`gateway/server.ts:483,567`, `gateway/run-attachments.ts:17`,
  `gateway/ticket-dispatch.ts:23`), not into skill installation or sync. So B2a
  leaves F5's *surface* unchanged while inheriting an already-unscreened route;
  F5's human review gate is needed either way, and an earlier revision of this
  report wrongly described this route as screened.
- **B2b — inlined content.** The block carries the `SKILL.md` text.
  **Reach:** engine-agnostic, so it does mitigate F6. **Trust:** this creates a
  **new** path injecting third-party procedural content into the prompt of every
  routed engine, bypassing the provenance-based filesystem screening that F5
  documents. F5 is **not** unchanged, and the review/screening gate F5 asks for
  must be applied to this path specifically, before a role can bind a skill.

- **Pros:** no new orchestration layer, exactly as the proposal advocates;
  reuses the shipped skills subsystem, scheduler, leases, artifacts and
  recovery; B1 removes the fail-open control in F2 *before* anyone grows the
  role vocabulary; role data can go through the existing template extension
  point (F4).
- **Cons:** advisory only — a model may ignore the block, so this is **not**
  least-privilege and does not satisfy anyone who reads "role gets these skills"
  as an isolation guarantee; adds a validation seam (unknown skill names) and a
  new failure mode (role references an uninstalled skill). **B2a leaves F6
  unaddressed; B2b widens the F5 surface.** An earlier revision of this report
  claimed both engine-agnostic delivery *and* an unchanged F5 surface; those are
  mutually exclusive and the claim is withdrawn.
- **Effort:** small-to-medium. **Risk:** low for **B2a**; **medium for B2b**,
  which is a new untrusted-content path, not a packaging change.
  **Reversible:** yes — both fields are optional and additive.
- **Mitigations:** validate `skills:` at config load and fail loudly, not
  silently — but build the catalogue from **`SKILLS_DIR` on disk**, using
  `skills.json` only as optional source metadata. Manifest-only validation
  would reject legitimately installed skills: `cuttlefish setup` copies the ten
  bundled template skills into `SKILLS_DIR` (`cli/setup.ts:716`) while seeding
  `skills.json` as `{"installed": {}}` (`template/skills.json`), and
  `skillsList()` already treats a directory with no manifest entry as a valid
  `(local)` skill (`cli/skills.ts:293-326`). On a fresh install, manifest-only
  validation would reject every shipped skill — including `onboarding`, which
  `sessions/context.ts:817` actively invokes. Also state plainly in docs that
  binding is advisory.
  If **B2b** is chosen, screen inlined skill text on that path and gate
  procedure-bearing skills behind human review (F5), and pin skill content
  (also F5) so a role's behaviour cannot change under it.

### COA-C — Full three-axis Mode / Role / Skill model as proposed

- **Pros:** conceptually clean; matches the proposal as written; the
  decomposition is genuinely good design *in the abstract*.
- **Cons:** collides with two existing mode vocabularies (F8) and a third
  role-ish vocabulary in the org system; raises the registry-scope question
  (F3); still requires B1 and B2 as substrate, so it is strictly more work than
  COA-B with no additional near-term capability.
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
2. **COA-B1 next, ahead of growing the role vocabulary** — declarative role
   traits. This reorders the proposal's sequencing for a concrete reason: the
   proposal's own vocabulary (`verifier`, `security`, `debugger`) depends
   entirely on capabilities being declared correctly, and where they are not,
   the degradation is silent. Adding roles first is *possible* (see F2); doing
   traits first is what makes it safe by construction rather than by care.
3. **COA-B2 after that** — advisory role↔skill binding, with `skills:`
   validated against the manifest at load, and generic roles added through the
   existing template extension point rather than an unimplemented policy pack
   (F4). Decide **B2a vs B2b** explicitly at this step: B2a (names only) is the
   lower-risk default but leaves F6 unaddressed; B2b (inlined skill text) is the
   only variant that reaches every engine, and it must ship with the F5
   screening gate and content pinning, because it is a new untrusted-content
   path.
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
  Both trees are git-ignored (`.gitignore:27-28`), and `AGENTS.md` states the
  intent explicitly: audit files there *"live only on the machine that produced
  them and are not part of the published repo."* A review that must be committed
  and pushed therefore cannot live in `docs/audits/` without contradicting that
  rule rather than satisfying it.
- **Classification.** This document is a **design review of an externally
  supplied proposal**, not an audit of this repository's code — it evaluates a
  proposed architecture against the current implementation. It is placed in the
  tracked `docs/plans/` tree, whose contents already include review and
  verification artifacts (`2026-06-24-auth-ux-verification-plan.md`,
  `2026-06-24-security-hardening-verification.md`), and is listed under
  **Current Operator Docs** in `docs/INDEX.md` — not under that index's
  *Historical Design And Planning Archives* heading, which describes the older
  material in the same directory. If the operator prefers this to be classified
  and retained as an audit artifact, the correct move is a local copy under
  `docs/audits/`, which by design would not be published.
- A local-only session note was also written under `docs/logs/session/082026/`
  on the machine that produced this report; it is not part of the published
  repo.
- **No decision is recorded.** Nothing here is entered in
  `docs/DECISION_LOG.md`; selecting a course of action is the operator's call.
