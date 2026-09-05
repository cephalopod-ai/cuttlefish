/**
 * Canonical role-kind resolution for the orchestration scheduler (finding F2 of
 * `docs/audits/2026-08-31-roles-skills-architecture-review.md`).
 *
 * Role kind drives real execution controls: a reviewer role gets a generated
 * read-only review bundle and a "do not modify files" prompt prefix, and is
 * excluded from becoming the implementation workspace (`run-mode.ts`); an
 * implementer role decides which families the cross-family reviewer policy must
 * avoid (`scheduler.ts`).
 *
 * Historically those kinds were *guessed*, name first: `roleId.includes("review")`
 * classified a role as a reviewer before any declared capability was consulted.
 * That guess is wrong in both directions — a role named `preview-generator` was
 * silently turned into a read-only reviewer purely by its name, and a freely
 * named role such as `verifier` matched nothing, so in the mixed case the
 * cross-family reviewer policy simply did not apply, with no error (fail-open).
 *
 * Resolution order here is therefore:
 *   1. **Declared** — if `roles.yaml` gives the role a `kind:` list, that list is
 *      authoritative and no name or capability is consulted. An explicitly empty
 *      `kind: []` declares "none of these kinds", which is how a role named
 *      `preview-generator` opts out of reviewer treatment.
 *   2. **Undeclared** — fall back to the historical name/capability heuristics
 *      unchanged, so existing `roles.yaml` files keep behaving exactly as before.
 */
import type { RoleDefinition, RoleKind } from "./types.js";

/** Kinds that make a role a reviewer for cross-family/review-bundle purposes. */
const REVIEWER_KINDS: RoleKind[] = ["reviewer", "independent_reviewer", "adversarial_reviewer"];

/** `undefined` means "the role declared no kinds" — the caller falls back to the
 *  heuristics. An explicitly empty list is a declaration, and answers `false`. */
function declares(role: RoleDefinition | undefined, kinds: RoleKind[]): boolean | undefined {
  if (!role?.kind) return undefined;
  return kinds.some((kind) => role.kind!.includes(kind));
}

export function isImplementerRole(roleId: string, role: RoleDefinition | undefined): boolean {
  const declared = declares(role, ["implementer"]);
  if (declared !== undefined) return declared;
  if (roleId.toLowerCase().includes("implementer")) return true;
  if (!role) return false;
  return role.requiredCapabilities.includes("repo_edit") || role.requiredCapabilities.includes("coding");
}

export function isReviewerRole(roleId: string, role: RoleDefinition | undefined): boolean {
  const declared = declares(role, REVIEWER_KINDS);
  if (declared !== undefined) return declared;
  if (roleId.toLowerCase().includes("review")) return true;
  if (!role) return false;
  return role.requiredCapabilities.includes("code_review") || role.familyConstraint === "opposite_of_implementer";
}

export function isArchitectRole(roleId: string, role: RoleDefinition | undefined): boolean {
  const declared = declares(role, ["architect"]);
  if (declared !== undefined) return declared;
  if (roleId.toLowerCase().includes("architect")) return true;
  return Boolean(role?.requiredCapabilities.some((capability) => capability === "architecture" || capability === "system_design"));
}

export function isAdversarialReviewerRole(roleId: string, role: RoleDefinition | undefined): boolean {
  const declared = declares(role, ["adversarial_reviewer"]);
  if (declared !== undefined) return declared;
  if (roleId.toLowerCase().includes("adversarial")) return true;
  return Boolean(role?.requiredCapabilities.some((capability) => capability === "adversarial_review" || capability === "bug_hunt"));
}

/** A reviewer that is not the adversarial pass. Declared kinds keep the same
 *  relationship: an explicit `adversarial_reviewer` is never the independent one. */
export function isIndependentReviewerRole(roleId: string, role: RoleDefinition | undefined): boolean {
  if (role?.kind) {
    return role.kind.includes("independent_reviewer")
      || (role.kind.includes("reviewer") && !role.kind.includes("adversarial_reviewer"));
  }
  const lower = roleId.toLowerCase();
  if (lower.includes("adversarial")) return false;
  if (lower.includes("independent") && lower.includes("review")) return true;
  return isReviewerRole(roleId, role);
}

export function isQaRole(roleId: string, role: RoleDefinition | undefined): boolean {
  const declared = declares(role, ["qa"]);
  if (declared !== undefined) return declared;
  if (roleId.toLowerCase().includes("qa")) return true;
  return Boolean(role?.requiredCapabilities.some((capability) => capability === "validation" || capability === "test_log_triage"));
}

/** True when the role's kind was declared rather than inferred from its name. */
export function hasDeclaredKinds(role: RoleDefinition | undefined): boolean {
  return Boolean(role?.kind);
}
