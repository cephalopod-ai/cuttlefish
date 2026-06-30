export type PolicyAction = "export" | "retain" | "quarantine" | "register";

export interface PolicyArtifactDescriptor {
  kind: string;
  locator: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  producingRunId: string | null;
}

export interface PolicyEvalContext {
  descriptor: PolicyArtifactDescriptor;
  action: PolicyAction;
}

export interface PolicyVerdict {
  allowed: boolean;
  rule?: string;
  reason: string;
}

export interface PolicyRule {
  id: string;
  action?: PolicyAction;
  kindPattern?: string;
  locatorPattern?: string;
  allow: boolean;
}

export interface PolicyProfile {
  rules: PolicyRule[];
}
