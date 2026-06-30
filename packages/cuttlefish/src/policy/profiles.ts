import type { PolicyProfile, PolicyRule } from "./types.js";

export function buildDefaultProfile(): PolicyProfile {
  return { rules: [] };
}

export function buildStrictExportProfile(): PolicyProfile {
  const rules: PolicyRule[] = [
    { id: "deny-all-export", action: "export", allow: false },
  ];
  return { rules };
}
