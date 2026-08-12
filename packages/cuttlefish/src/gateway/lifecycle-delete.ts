import fs from "node:fs";
import path from "node:path";
import { deleteSessions } from "../sessions/registry.js";
import { archiveEmployeeBoardTickets, archiveSessionBoardTickets, type BoardTicketArchiveResult } from "./board-service.js";
import { deleteEmployeeYaml } from "./org.js";

interface BoardSnapshot {
  file: string;
  content: Buffer;
}

function snapshotBoards(orgDir: string): BoardSnapshot[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(orgDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(orgDir, entry.name, "board.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, content: fs.readFileSync(file) }));
}

function restoreBoards(snapshots: BoardSnapshot[]): void {
  for (const snapshot of snapshots) fs.writeFileSync(snapshot.file, snapshot.content);
}

export type LifecycleDeleteResult =
  | { ok: true; count: number; archived: BoardTicketArchiveResult }
  | { ok: false; error: string };

export function deleteSessionsWithBoardCleanup(
  orgDir: string,
  sessionIds: string[],
  deps: {
    archive?: typeof archiveSessionBoardTickets;
    remove?: typeof deleteSessions;
  } = {},
): LifecycleDeleteResult {
  const snapshots = snapshotBoards(orgDir);
  try {
    const archived = (deps.archive ?? archiveSessionBoardTickets)(orgDir, sessionIds);
    const count = (deps.remove ?? deleteSessions)(sessionIds);
    if (count !== sessionIds.length) {
      restoreBoards(snapshots);
      return { ok: false, error: `Session deletion removed ${count} of ${sessionIds.length} records; board changes were rolled back` };
    }
    return { ok: true, count, archived };
  } catch (err) {
    restoreBoards(snapshots);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function deleteEmployeeWithBoardCleanup(
  orgDir: string,
  employeeName: string,
  deps: {
    archive?: typeof archiveEmployeeBoardTickets;
    remove?: typeof deleteEmployeeYaml;
  } = {},
): LifecycleDeleteResult {
  const snapshots = snapshotBoards(orgDir);
  try {
    const archived = (deps.archive ?? archiveEmployeeBoardTickets)(orgDir, employeeName);
    const removed = (deps.remove ?? deleteEmployeeYaml)(employeeName);
    if (!removed) {
      restoreBoards(snapshots);
      return { ok: false, error: `Employee ${employeeName} was not deleted; board changes were rolled back` };
    }
    return { ok: true, count: 1, archived };
  } catch (err) {
    restoreBoards(snapshots);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
