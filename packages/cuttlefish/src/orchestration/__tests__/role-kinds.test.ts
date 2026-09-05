/**
 * F2 (`docs/audits/2026-08-31-roles-skills-architecture-review.md`): role kind
 * must be declarable, not guessed from the role's identifier.
 *
 * The audit recorded two failure directions, and both are pinned here:
 *   - **False positive, unfixable by careful config.** A role named
 *     `preview-generator` contains "review", so `isReviewerRole` classified it as
 *     a reviewer. That classification drives real execution behaviour in
 *     `run-mode.ts` — a generated read-only review bundle instead of a working
 *     directory, a "Review-only pass. Do not modify files." prompt prefix, and
 *     exclusion from becoming the implementation workspace. No capability
 *     declaration could undo it, because the name alone decided.
 *   - **False negative, silent (fail-open).** A freely named role such as
 *     `verifier` matched no reviewer predicate by name; declared without a
 *     matching capability, the cross-family reviewer policy simply did not apply
 *     and nothing warned the operator.
 *
 * Roles that declare no `kind` must keep their existing behaviour exactly, so the
 * heuristic cases below are regression pins, not aspirations.
 */
import { describe, expect, it } from "vitest";
import {
  hasDeclaredKinds,
  isAdversarialReviewerRole,
  isArchitectRole,
  isImplementerRole,
  isIndependentReviewerRole,
  isQaRole,
  isReviewerRole,
} from "../role-kinds.js";
import { parseRoles } from "../schemas.js";
import type { RoleDefinition } from "../types.js";

function role(partial: Partial<RoleDefinition> & { id: string }): RoleDefinition {
  return { requiredCapabilities: [], requiredTools: [], ...partial };
}

describe("declared role kinds win over the name heuristic", () => {
  it("does not classify preview-generator as a reviewer when it declares no kinds", () => {
    const previewGenerator = role({ id: "preview-generator", kind: [], requiredCapabilities: ["coding"] });
    expect(isReviewerRole(previewGenerator.id, previewGenerator)).toBe(false);
    expect(isIndependentReviewerRole(previewGenerator.id, previewGenerator)).toBe(false);
    expect(isAdversarialReviewerRole(previewGenerator.id, previewGenerator)).toBe(false);
  });

  it("still classifies preview-generator as a reviewer when it declares nothing (unchanged legacy behaviour)", () => {
    const legacy = role({ id: "preview-generator", requiredCapabilities: ["coding"] });
    expect(hasDeclaredKinds(legacy)).toBe(false);
    expect(isReviewerRole(legacy.id, legacy)).toBe(true);
  });

  it("classifies a freely named verifier as a reviewer once it declares the kind", () => {
    const verifier = role({ id: "verifier", kind: ["reviewer"], requiredCapabilities: ["triage"] });
    expect(isReviewerRole(verifier.id, verifier)).toBe(true);
    expect(isIndependentReviewerRole(verifier.id, verifier)).toBe(true);
  });

  it("leaves an undeclared verifier matching nothing, as before", () => {
    const verifier = role({ id: "verifier", requiredCapabilities: ["triage"] });
    expect(isReviewerRole(verifier.id, verifier)).toBe(false);
  });

  it("declares an implementer that neither its name nor its capabilities imply", () => {
    const builder = role({ id: "builder", kind: ["implementer"], requiredCapabilities: ["triage"] });
    expect(isImplementerRole(builder.id, builder)).toBe(true);
  });

  it("keeps an explicit non-implementer out of the implementer set despite its name", () => {
    const notReally = role({ id: "implementer-liaison", kind: [], requiredCapabilities: ["triage"] });
    expect(isImplementerRole(notReally.id, notReally)).toBe(false);
  });

  it("separates the adversarial pass from the independent reviewer by declaration", () => {
    const adversarial = role({ id: "secondOpinion", kind: ["adversarial_reviewer"], requiredCapabilities: ["triage"] });
    expect(isAdversarialReviewerRole(adversarial.id, adversarial)).toBe(true);
    expect(isReviewerRole(adversarial.id, adversarial)).toBe(true);
    expect(isIndependentReviewerRole(adversarial.id, adversarial)).toBe(false);

    const independent = role({ id: "secondPair", kind: ["independent_reviewer"], requiredCapabilities: ["triage"] });
    expect(isIndependentReviewerRole(independent.id, independent)).toBe(true);
    expect(isAdversarialReviewerRole(independent.id, independent)).toBe(false);
  });

  it("declares architect and qa kinds independently of name and capability", () => {
    const planner = role({ id: "planner", kind: ["architect"], requiredCapabilities: ["triage"] });
    expect(isArchitectRole(planner.id, planner)).toBe(true);

    const gate = role({ id: "shipGate", kind: ["qa"], requiredCapabilities: ["triage"] });
    expect(isQaRole(gate.id, gate)).toBe(true);

    const notQa = role({ id: "qaLiaison", kind: [], requiredCapabilities: ["triage"] });
    expect(isQaRole(notQa.id, notQa)).toBe(false);
  });

  it("allows a role to declare several kinds at once", () => {
    const both = role({ id: "soloWorker", kind: ["implementer", "qa"], requiredCapabilities: ["triage"] });
    expect(isImplementerRole(both.id, both)).toBe(true);
    expect(isQaRole(both.id, both)).toBe(true);
    expect(isReviewerRole(both.id, both)).toBe(false);
  });
});

describe("undeclared roles keep the historical heuristics", () => {
  it("infers an implementer from repo_edit or coding", () => {
    expect(isImplementerRole("worker", role({ id: "worker", requiredCapabilities: ["repo_edit"] }))).toBe(true);
    expect(isImplementerRole("worker", role({ id: "worker", requiredCapabilities: ["coding"] }))).toBe(true);
  });

  it("infers a reviewer from code_review or the cross-family constraint", () => {
    expect(isReviewerRole("checker", role({ id: "checker", requiredCapabilities: ["code_review"] }))).toBe(true);
    expect(isReviewerRole("checker", role({
      id: "checker",
      requiredCapabilities: ["triage"],
      familyConstraint: "opposite_of_implementer",
    }))).toBe(true);
  });

  it("infers architect, adversarial reviewer and qa from their capabilities", () => {
    expect(isArchitectRole("planner", role({ id: "planner", requiredCapabilities: ["system_design"] }))).toBe(true);
    expect(isAdversarialReviewerRole("hunter", role({ id: "hunter", requiredCapabilities: ["bug_hunt"] }))).toBe(true);
    expect(isQaRole("gate", role({ id: "gate", requiredCapabilities: ["test_log_triage"] }))).toBe(true);
  });

  it("keeps name-based classification for roles that relied on it", () => {
    expect(isImplementerRole("seniorImplementer", undefined)).toBe(true);
    expect(isReviewerRole("independentReviewer", undefined)).toBe(true);
    expect(isAdversarialReviewerRole("adversarialReviewer", undefined)).toBe(true);
    expect(isIndependentReviewerRole("adversarialReviewer", undefined)).toBe(false);
    expect(isQaRole("qaGate", undefined)).toBe(true);
    expect(isArchitectRole("architect", undefined)).toBe(true);
  });
});

describe("roles.yaml parsing of the kind field", () => {
  it("parses declared kinds, including an explicitly empty list", () => {
    const roles = parseRoles({
      roles: {
        verifier: { kind: ["reviewer"], requiredCapabilities: ["triage"] },
        previewGenerator: { kind: [], requiredCapabilities: ["coding"] },
        legacy: { requiredCapabilities: ["coding"] },
      },
    });
    expect(roles.find((r) => r.id === "verifier")?.kind).toEqual(["reviewer"]);
    expect(roles.find((r) => r.id === "previewGenerator")?.kind).toEqual([]);
    expect(roles.find((r) => r.id === "legacy")?.kind).toBeUndefined();
  });

  it("rejects an unknown kind rather than silently ignoring it", () => {
    expect(() => parseRoles({
      roles: { odd: { kind: ["supervisor"], requiredCapabilities: ["triage"] } },
    })).toThrow();
  });
});
