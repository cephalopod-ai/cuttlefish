import type {
  ReviewPolicyDecision,
  ReviewPolicyExplanation,
  RoleDefinition,
  Worker,
} from "./types.js";

export interface CrossFamilyReviewPolicy {
  sameFamilyReviewerFallback: boolean;
}

export const DEFAULT_CROSS_FAMILY_REVIEW_POLICY: CrossFamilyReviewPolicy = {
  sameFamilyReviewerFallback: false,
};

export function resolveCrossFamilyReviewPolicy(
  value?: Partial<CrossFamilyReviewPolicy> | null,
): CrossFamilyReviewPolicy {
  return {
    sameFamilyReviewerFallback: value?.sameFamilyReviewerFallback === true,
  };
}

export function isImplementerRole(roleId: string, role: RoleDefinition | undefined): boolean {
  if (roleId.toLowerCase().includes("implementer")) return true;
  if (!role) return false;
  return role.requiredCapabilities.includes("repo_edit") || role.requiredCapabilities.includes("coding");
}

export function isReviewerRole(roleId: string, role: RoleDefinition | undefined): boolean {
  if (roleId.toLowerCase().includes("review")) return true;
  if (!role) return false;
  return role.requiredCapabilities.includes("code_review") || role.familyConstraint === "opposite_of_implementer";
}

export function selectedImplementerFamilies(
  selected: Array<{ role: string; worker: Worker }>,
  roleForId: (roleId: string) => RoleDefinition | undefined,
): string[] {
  return uniqueSorted(
    selected
      .filter((entry) => isImplementerRole(entry.role, roleForId(entry.role)))
      .map((entry) => entry.worker.family),
  );
}

export function explainReviewPolicy(args: {
  role: string;
  policy: CrossFamilyReviewPolicy;
  implementerFamilies: string[];
  oppositeCandidates: Worker[];
  sameFamilyCandidates: Worker[];
  selectedWorker?: Worker;
  decision: ReviewPolicyDecision;
}): ReviewPolicyExplanation {
  return {
    role: args.role,
    familyConstraint: "opposite_of_implementer",
    sameFamilyReviewerFallback: args.policy.sameFamilyReviewerFallback,
    implementerFamilies: [...args.implementerFamilies],
    selectedWorkerId: args.selectedWorker?.id,
    selectedWorkerFamily: args.selectedWorker?.family,
    oppositeFamilyCandidateIds: args.oppositeCandidates.map((worker) => worker.id),
    sameFamilyCandidateIds: args.sameFamilyCandidates.map((worker) => worker.id),
    decision: args.decision,
    detail: detailFor(args.decision, args.role, args.selectedWorker),
  };
}

function detailFor(decision: ReviewPolicyDecision, role: string, selectedWorker: Worker | undefined): string {
  if (decision === "opposite_family_selected") {
    return `${role} selected ${selectedWorker?.id ?? "a reviewer"} from an opposite model family.`;
  }
  if (decision === "same_family_fallback_used") {
    return `${role} used explicit same-family fallback with ${selectedWorker?.id ?? "a reviewer"}.`;
  }
  if (decision === "same_family_fallback_forbidden") {
    return `${role} blocked because only same-family reviewers were qualified and fallback is disabled.`;
  }
  return `${role} blocked because no qualified reviewer was available.`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
