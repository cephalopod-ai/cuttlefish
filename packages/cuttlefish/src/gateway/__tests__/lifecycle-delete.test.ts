import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteEmployeeWithBoardCleanup, deleteSessionsWithBoardCleanup } from "../lifecycle-delete.js";

let root: string;
let board: string;
const archived = { boardsUpdated: 1, ticketsArchived: 1, departments: ["qa"] };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-lifecycle-delete-"));
  fs.mkdirSync(path.join(root, "qa"), { recursive: true });
  board = path.join(root, "qa", "board.json");
  fs.writeFileSync(board, '{"tickets":[{"id":"keep"}]}');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("lifecycle deletion services", () => {
  it("does not delete sessions and restores partial board writes when archival fails", () => {
    const remove = vi.fn(() => 1);
    const result = deleteSessionsWithBoardCleanup(root, ["s1"], {
      archive: () => {
        fs.writeFileSync(board, '{"tickets":[]}');
        throw new Error("board locked");
      },
      remove,
    });

    expect(result).toEqual({ ok: false, error: "board locked" });
    expect(remove).not.toHaveBeenCalled();
    expect(fs.readFileSync(board, "utf-8")).toContain("keep");
  });

  it("restores boards if the transactional session delete reports a mismatch", () => {
    const result = deleteSessionsWithBoardCleanup(root, ["s1"], {
      archive: () => { fs.writeFileSync(board, '{"tickets":[]}'); return archived; },
      remove: () => 0,
    });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(board, "utf-8")).toContain("keep");
  });

  it("restores boards if employee deletion fails", () => {
    const result = deleteEmployeeWithBoardCleanup(root, "worker", {
      archive: () => { fs.writeFileSync(board, '{"tickets":[]}'); return archived; },
      remove: () => false,
    });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(board, "utf-8")).toContain("keep");
  });
});
