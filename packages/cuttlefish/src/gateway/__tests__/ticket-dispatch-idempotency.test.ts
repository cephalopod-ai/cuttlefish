import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { BoardTicket } from "../board-service.js";

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-ticket-dispatch-idempotency-");

function orgDir() {
  return path.join(tmpHome, "org");
}

function departmentDir() {
  return path.join(orgDir(), "software-delivery");
}

function boardPath() {
  return path.join(departmentDir(), "board.json");
}

function readBoard(): BoardTicket[] {
  const payload = JSON.parse(fs.readFileSync(boardPath(), "utf-8"));
  return Array.isArray(payload) ? payload as BoardTicket[] : payload.tickets as BoardTicket[];
}

function seedOrg() {
  fs.mkdirSync(departmentDir(), { recursive: true });
  fs.writeFileSync(path.join(departmentDir(), "worker.yaml"), [
    "name: worker",
    "displayName: Worker",
    "department: software-delivery",
    "rank: employee",
    "engine: claude",
    "model: opus",
    "persona: worker",
  ].join("\n"));
  fs.writeFileSync(boardPath(), JSON.stringify([
    {
      id: "ticket-1",
      title: "Repair dispatch",
      description: "Ensure retry is idempotent",
      status: "todo",
      priority: "high",
      complexity: "medium",
      assignee: "worker",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    },
  ], null, 2));
}

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../api/session-dispatch.js");
  vi.doUnmock("../board-service.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("ticket dispatch idempotency", () => {
  it("reuses a pre-created session after board write failure instead of duplicating it", async () => {
    seedOrg();

    let failNextBoardWrite = true;
    const dispatchWebSessionRun = vi.fn();

    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));
    vi.doMock("../board-service.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../board-service.js")>();
      return {
        ...actual,
        writeBoardTickets: vi.fn((dir: string, department: string, tickets: BoardTicket[]) => {
          if (failNextBoardWrite) {
            failNextBoardWrite = false;
            throw new Error("injected board write failure");
          }
          return actual.writeBoardTickets(dir, department, tickets);
        }),
      };
    });

    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const registry = await import("../../sessions/registry.js");
    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ run: vi.fn() }),
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    await expect(dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "board", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-23T10:00:00.000Z") },
    )).rejects.toThrow("injected board write failure");

    const sessionsAfterFailure = registry.listSessions();
    expect(sessionsAfterFailure).toHaveLength(1);
    expect(sessionsAfterFailure[0].status).toBe("idle");
    expect(sessionsAfterFailure[0].sessionKey).toBe("board:software-delivery:ticket-1");
    expect(sessionsAfterFailure[0].transportMeta).toMatchObject({
      boardDepartment: "software-delivery",
      boardTicketId: "ticket-1",
      boardDispatchState: "session_created",
    });
    expect(readBoard()[0].status).toBe("todo");
    expect(readBoard()[0].sessionId).toBeUndefined();
    expect(dispatchWebSessionRun).not.toHaveBeenCalled();

    const retry = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "board", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-23T10:01:00.000Z") },
    );

    expect(retry).toEqual({ ok: true, sessionId: sessionsAfterFailure[0].id });

    const sessionsAfterRetry = registry.listSessions();
    expect(sessionsAfterRetry).toHaveLength(1);
    expect(sessionsAfterRetry[0]).toMatchObject({
      id: sessionsAfterFailure[0].id,
      status: "running",
      sessionKey: "board:software-delivery:ticket-1",
    });
    expect(sessionsAfterRetry[0].transportMeta).toMatchObject({
      boardDepartment: "software-delivery",
      boardTicketId: "ticket-1",
      boardDispatchState: "board_linked",
    });
    expect(readBoard()[0]).toMatchObject({
      status: "in_progress",
      sessionId: sessionsAfterFailure[0].id,
      assignee: "worker",
      updatedAt: "2026-06-23T10:01:00.000Z",
    });
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(1);
  }, 15_000);
});
