/**
 * Validation for the `workspaces` config section: workspace roots, the default
 * cwd, profile definitions (mapping or array form), the per-profile
 * `autonomousMode` block, and the structural "at most one autonomous profile"
 * invariant enforced at config-load time.
 *
 * Extracted from `packages/cuttlefish/src/shared/config-schema.ts` in a
 * behavior-preserving modularization. `validateWorkspaces` and
 * `validateAutonomousModeSingleton` are the two entry points the facade calls;
 * the rest are exported only within this module's own call chain.
 */
import {
  isPlainObject,
  pushUnknownKeys,
  validateBoolean,
  validateNumber,
  validateString,
  validateStringArray,
  validateStringOrStringArray,
} from "./config-schema-primitives.js";

function validateAutonomousModeBlock(problems: string[], path: string, value: unknown, cwd: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(
    problems,
    value,
    ["enabled", "toolReview", "orgChangeOverride", "continuousDispatch", "maxAutoDispatchesPerHour"],
    path,
  );
  if (value.enabled !== undefined) validateBoolean(problems, `${path}.enabled`, value.enabled);
  if (value.toolReview !== undefined) validateBoolean(problems, `${path}.toolReview`, value.toolReview);
  if (value.orgChangeOverride !== undefined) validateBoolean(problems, `${path}.orgChangeOverride`, value.orgChangeOverride);
  if (value.continuousDispatch !== undefined) validateBoolean(problems, `${path}.continuousDispatch`, value.continuousDispatch);
  if (value.maxAutoDispatchesPerHour !== undefined) {
    validateNumber(problems, `${path}.maxAutoDispatchesPerHour`, value.maxAutoDispatchesPerHour);
  }
  // An autonomous project with no fixed cwd has no bounded blast radius —
  // that defeats the entire premise of "scoped to one project."
  if (value.enabled === true && (typeof cwd !== "string" || cwd.trim() === "")) {
    problems.push(`${path.replace(/\.autonomousMode$/, "")}.cwd is required when autonomousMode.enabled is true`);
  }
}

function validateWorkspaceProfile(problems: string[], path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be a mapping`);
    return;
  }
  pushUnknownKeys(problems, value, ["id", "label", "cwd", "instructions", "employee", "autonomousMode"], path);
  if (value.id !== undefined) validateString(problems, `${path}.id`, value.id);
  if (value.label !== undefined) validateString(problems, `${path}.label`, value.label);
  if (value.cwd !== undefined) validateString(problems, `${path}.cwd`, value.cwd);
  if (value.instructions !== undefined) validateStringOrStringArray(problems, `${path}.instructions`, value.instructions);
  if (value.employee !== undefined) validateString(problems, `${path}.employee`, value.employee);
  if (value.autonomousMode !== undefined) {
    validateAutonomousModeBlock(problems, `${path}.autonomousMode`, value.autonomousMode, value.cwd);
  }
}

function validateWorkspaceProfiles(problems: string[], value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateWorkspaceProfile(problems, `workspaces.profiles[${index}]`, entry));
    return;
  }
  if (!isPlainObject(value)) {
    problems.push("workspaces.profiles must be a mapping or array");
    return;
  }
  Object.entries(value).forEach(([id, entry]) => validateWorkspaceProfile(problems, `workspaces.profiles.${id}`, entry));
}

/** Structural enforcement of "scoped to exactly one project" — a config-load
 *  error, not an operator convention, so a copy-pasted profile block can't
 *  silently widen autonomous mode's blast radius to a second project. */
export function validateAutonomousModeSingleton(problems: string[], workspaces: unknown): void {
  if (!isPlainObject(workspaces) || workspaces.profiles === undefined) return;
  const profiles = workspaces.profiles;
  const entries: unknown[] = Array.isArray(profiles)
    ? profiles
    : isPlainObject(profiles)
      ? Object.values(profiles)
      : [];
  const enabledCount = entries.filter(
    (entry) => isPlainObject(entry) && isPlainObject(entry.autonomousMode) && entry.autonomousMode.enabled === true,
  ).length;
  if (enabledCount > 1) {
    problems.push(
      `workspaces.profiles: at most one profile may have autonomousMode.enabled true (found ${enabledCount})`,
    );
  }
}



export function validateWorkspaces(problems: string[], value: unknown): void {
  if (!isPlainObject(value)) {
    problems.push("workspaces must be a mapping");
    return;
  }
  pushUnknownKeys(problems, value, ["roots", "defaultCwd", "profiles"], "workspaces");
  if (value.roots !== undefined) validateStringArray(problems, "workspaces.roots", value.roots);
  if (value.defaultCwd !== undefined) validateString(problems, "workspaces.defaultCwd", value.defaultCwd);
  if (value.profiles !== undefined) validateWorkspaceProfiles(problems, value.profiles);
}
