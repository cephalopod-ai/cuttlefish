import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { ORG_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { safeWriteJson, safeWriteText } from "../shared/safe-write.js";
import { findEmployeeYamlPath, scanOrg, updateEmployeeYaml } from "./org.js";

export type RenameDepartmentResult =
  | { ok: true; department: string; previousDepartment: string; employees: string[]; movedDirectory: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

interface EmployeeYamlSnapshot {
  name: string;
  filePath: string;
  raw: string;
}

/**
 * A department rename is a multi-file mutation (N employee YAML field writes,
 * then one directory rename) with no single transaction backing it. The
 * synchronous `rollback()` below only covers an in-process error; a crash or
 * kill between steps previously left a "ghost department" — employee YAMLs
 * already pointing at the new department name while the directory (and any
 * employee not yet reached) stayed under the old one, with nothing to detect
 * or finish it (DFI-002). This durable marker records the in-flight intent so
 * `recoverInterruptedDepartmentRename` can converge the operation forward to
 * completion on the next call, instead of leaving it stuck.
 */
const RENAME_INTENT_FILENAME = ".department-rename-pending.json";

interface DepartmentRenameIntent {
  previousDepartment: string;
  department: string;
  employees: string[];
  startedAt: string;
}

function intentPath(orgDir: string): string {
  return path.join(orgDir, RENAME_INTENT_FILENAME);
}

function readRenameIntent(orgDir: string): DepartmentRenameIntent | null {
  const file = intentPath(orgDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (
      parsed && typeof parsed === "object" &&
      typeof parsed.previousDepartment === "string" &&
      typeof parsed.department === "string" &&
      Array.isArray(parsed.employees) && parsed.employees.every((e: unknown) => typeof e === "string")
    ) {
      return parsed as DepartmentRenameIntent;
    }
    logger.warn(`Malformed department-rename intent marker at ${file}; ignoring and removing it`);
  } catch (err) {
    logger.warn(`Failed to read department-rename intent marker at ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // best-effort cleanup of an unreadable/corrupt marker
  }
  return null;
}

function writeRenameIntent(orgDir: string, intent: DepartmentRenameIntent): void {
  safeWriteJson(intentPath(orgDir), intent);
}

function clearRenameIntent(orgDir: string): void {
  try {
    fs.unlinkSync(intentPath(orgDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn(`Failed to remove department-rename intent marker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Finish (never undo) an interrupted department rename recorded by a leftover
 * intent marker: re-apply the target department to any listed employee whose
 * YAML doesn't already carry it, then complete the directory move if it
 * hasn't happened yet. Forward-completion is the only safe convergent action
 * once we've lost the in-process snapshots a live rollback would need — it is
 * idempotent, matches the rename the caller originally requested, and leaves
 * no ghost department behind. Safe to call unconditionally (no-op when no
 * marker exists); never throws — a recovery failure is logged and the marker
 * is left in place for the next attempt / manual inspection.
 */
export function recoverInterruptedDepartmentRename(orgDir = ORG_DIR): void {
  const intent = readRenameIntent(orgDir);
  if (!intent) return;
  try {
    for (const name of intent.employees) {
      const filePath = findEmployeeYamlPath(name);
      if (!filePath) {
        logger.warn(`department-rename recovery: employee "${name}" not found; leaving intent marker for manual review`);
        return;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = yaml.load(raw) as Record<string, unknown> | null;
      if (data?.department !== intent.department) {
        const wrote = updateEmployeeYaml(name, { department: intent.department });
        if (!wrote) {
          logger.warn(`department-rename recovery: failed to finish updating employee "${name}"; leaving intent marker for manual review`);
          return;
        }
      }
    }
    const oldDir = path.join(orgDir, intent.previousDepartment);
    const newDir = path.join(orgDir, intent.department);
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
    }
    clearRenameIntent(orgDir);
    logger.info(`department-rename recovery: finished interrupted rename "${intent.previousDepartment}" -> "${intent.department}"`);
  } catch (err) {
    logger.warn(`department-rename recovery failed: ${err instanceof Error ? err.message : String(err)}; leaving intent marker for manual review`);
  }
}

function validateDepartmentName(value: string, field: string): string | null {
  if (!value.trim()) return `${field} must be a non-empty string`;
  if (path.isAbsolute(value)) return `${field} must not be an absolute path`;
  if (value.includes("..")) return `${field} must not contain '..' traversal`;
  if (value.includes("/") || value.includes("\\")) return `${field} must not contain path separators`;
  return null;
}

function snapshotEmployeeYamls(employees: string[]): EmployeeYamlSnapshot[] | string {
  const snapshots: EmployeeYamlSnapshot[] = [];
  for (const name of employees) {
    const filePath = findEmployeeYamlPath(name);
    if (!filePath) return `failed to find employee "${name}"`;
    try {
      snapshots.push({ name, filePath, raw: fs.readFileSync(filePath, "utf-8") });
    } catch (err) {
      return `failed to read employee "${name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return snapshots;
}

function restoreEmployeeYamls(snapshots: EmployeeYamlSnapshot[]): boolean {
  let restored = true;
  for (const snapshot of snapshots) {
    try {
      safeWriteText(snapshot.filePath, snapshot.raw, {
        audit: { actor: "gateway", op: "org.department.rename.rollback" },
      });
    } catch (err) {
      restored = false;
      logger.warn(`Failed to restore employee YAML for ${snapshot.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return restored;
}

export function renameDepartment(
  oldDepartment: string,
  newDepartment: string,
  orgDir = ORG_DIR,
): RenameDepartmentResult {
  // Self-heal any rename left mid-flight by a prior crash before starting a
  // new one, so its ghost state can never compound with this operation.
  recoverInterruptedDepartmentRename(orgDir);

  const previousDepartment = oldDepartment.trim();
  const department = newDepartment.trim();
  const oldError = validateDepartmentName(previousDepartment, "current department");
  if (oldError) return { ok: false, status: 400, error: oldError };
  const newError = validateDepartmentName(department, "new department");
  if (newError) return { ok: false, status: 400, error: newError };
  if (previousDepartment === department) {
    return { ok: false, status: 400, error: "new department must differ from current department" };
  }

  const registry = scanOrg();
  // Match case-insensitively: `department` is taken verbatim from employee YAML
  // (or from the directory name when the field is absent), so `department:
  // Platform` inside `platform/` is a normal, unprevented shape. An exact-match
  // filter moves the directory and its board while leaving that employee
  // pointing at the old name — a ghost department with no directory, whose
  // members are then rejected from their own board as foreign-department
  // assignees.
  const employees = [...registry.values()]
    .filter((employee) => employee.department.localeCompare(previousDepartment, undefined, { sensitivity: "accent" }) === 0)
    .map((employee) => employee.name)
    .sort((a, b) => a.localeCompare(b));

  const oldDir = path.join(orgDir, previousDepartment);
  const newDir = path.join(orgDir, department);
  const oldDirExists = fs.existsSync(oldDir);
  if (employees.length === 0 && !oldDirExists) {
    return { ok: false, status: 404, error: `department "${previousDepartment}" was not found` };
  }
  if (fs.existsSync(newDir)) {
    return { ok: false, status: 409, error: `department "${department}" already exists` };
  }

  const snapshots = snapshotEmployeeYamls(employees);
  if (typeof snapshots === "string") {
    return { ok: false, status: 409, error: snapshots };
  }
  const rollback = (reason: string): RenameDepartmentResult => {
    const restored = restoreEmployeeYamls(snapshots);
    // A full synchronous rollback puts every employee YAML back exactly as it
    // was — the intent is moot and must be cleared, or a later crash-recovery
    // pass would silently re-apply the rename this call reported as failed.
    // When rollback itself only partially succeeded, the state is already
    // inconsistent; leave the marker so recovery converges it forward instead
    // of a half-restored department lingering forever.
    if (restored) clearRenameIntent(orgDir);
    return {
      ok: false,
      status: 409,
      error: restored ? reason : `${reason}; rollback failed, inspect org files`,
    };
  };

  writeRenameIntent(orgDir, { previousDepartment, department, employees, startedAt: new Date().toISOString() });

  for (const employeeName of employees) {
    const wrote = updateEmployeeYaml(employeeName, { department });
    if (!wrote) {
      return rollback(`failed to update employee "${employeeName}"`);
    }
  }

  let movedDirectory = false;
  if (oldDirExists) {
    try {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
    } catch (err) {
      return rollback(`failed to move department directory: ${err instanceof Error ? err.message : String(err)}`);
    }
    movedDirectory = true;
  }

  clearRenameIntent(orgDir);
  return { ok: true, previousDepartment, department, employees, movedDirectory };
}
