import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Session } from "../../shared/types.js";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// scanOrg reads ORG_DIR, which is derived from CUTTLEFISH_HOME at import time —
// point the home at a temp dir before the module under test is loaded.
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-watchdog-");
const orgDir = path.join(tmp, "org");
const NOW = new Date("2026-06-21T12:00:00.000Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const TWO_HOURS = 2 * 60 * 60 * 1000;

const hoisted = vi.hoisted(() => ({
  sessions: [] as Session[],
  dispatchTicketMock: vi.fn(async () => ({ ok: true, sessionId: "s-alert" })),
}));

vi.mock("../../sessions/registry.js", () => ({
  listSessions: () => hoisted.sessions,
}));

vi.mock("../ticket-dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../ticket-dispatch.js")>("../ticket-dispatch.js");
  return {
    ...actual,
    dispatchTicket: hoisted.dispatchTicketMock,
  };
});

const { startStuckTicketWatchdog } = await import("../stuck-ticket-watchdog.js");

function writeBoard(dept: string, value: unknown) {
  const dir = path.join(orgDir, dept);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(value, null, 2));
}

function readBoard(dept: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(orgDir, dept, "board.json"), "utf-8"));
}

function writeManager(dept: string) {
  const dir = path.join(orgDir, dept);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "lead.yaml"),
    `name: lead\ndisplayName: Lead\ndepartment: ${dept}\nrank: manager\nengine: claude\nmodel: opus\npersona: Runs the department.\n`,
  );
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "s-1",
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "kanban:delivery:t-blocked",
    connector: "web",
    sessionKey: "kanban:delivery:t-blocked",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "worker",
    model: null,
    title: "Blocked work",
    parentSessionId: null,
    userId: null,
    status: "waiting",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: iso(TWO_HOURS),
    lastActivity: iso(TWO_HOURS),
    lastError: null,
    ...overrides,
  } as Session;
}

/** Drive exactly one watchdog tick and tear the timer down. */
async function runOneTick(): Promise<void> {
  vi.useFakeTimers();
  const stop = startStuckTicketWatchdog({
    context: { sessionManager: { getEngine: () => ({}) } } as never,
    orgDir,
    intervalMs: 1_000,
    now: () => NOW,
  });
  await vi.advanceTimersByTimeAsync(1_100);
  stop();
  vi.useRealTimers();
  // Let the tick's pending awaits settle before assertions.
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  fs.rmSync(orgDir, { recursive: true, force: true });
  fs.mkdirSync(orgDir, { recursive: true });
  hoisted.sessions = [];
  hoisted.dispatchTicketMock.mockClear();
});

describe("stuck ticket watchdog", () => {
  it("flags a long-blocked ticket whose session is dead and dispatches one manager alert", async () => {
    writeManager("delivery");
    writeBoard("delivery", [{
      id: "t-blocked",
      title: "Blocked work",
      status: "blocked",
      createdAt: iso(TWO_HOURS),
      updatedAt: iso(TWO_HOURS),
    }]);
    hoisted.sessions = [session({ status: "error" })];

    await runOneTick();

    const board = readBoard("delivery");
    expect(board.find((t) => t.id === "t-blocked")?.manualOnly).toBe(true);
    expect(board.some((t) => t.source === "watchdog")).toBe(true);
    expect(hoisted.dispatchTicketMock).toHaveBeenCalledOnce();
  });

  it("leaves a blocked ticket alone while its session is still waiting on a human", async () => {
    // The alert text tells the manager these tickets have "no active session"
    // and invites re-assignment to a new agent. A model-fallback approval blocks
    // the ticket while the session waits on a human, and human approvals
    // routinely outlast the threshold — flagging it would be a false claim and
    // an instruction to start a duplicate run against live work.
    writeManager("delivery");
    writeBoard("delivery", [{
      id: "t-blocked",
      title: "Waiting on approval",
      status: "blocked",
      createdAt: iso(TWO_HOURS),
      updatedAt: iso(TWO_HOURS),
    }]);
    hoisted.sessions = [session({ status: "waiting" })];

    await runOneTick();

    const board = readBoard("delivery");
    expect(board.find((t) => t.id === "t-blocked")?.manualOnly).toBeUndefined();
    expect(board.some((t) => t.source === "watchdog")).toBe(false);
    expect(hoisted.dispatchTicketMock).not.toHaveBeenCalled();
  });

  it("leaves a blocked ticket alone while its session is actively running", async () => {
    writeManager("delivery");
    writeBoard("delivery", [{
      id: "t-blocked",
      title: "Running work",
      status: "blocked",
      createdAt: iso(TWO_HOURS),
      updatedAt: iso(TWO_HOURS),
    }]);
    hoisted.sessions = [session({ status: "running" })];

    await runOneTick();

    expect(readBoard("delivery").find((t) => t.id === "t-blocked")?.manualOnly).toBeUndefined();
    expect(hoisted.dispatchTicketMock).not.toHaveBeenCalled();
  });

  it("does not let another department's live session mask a dead ticket of the same id", async () => {
    // Ticket ids are unique only within a board, and the resolver's fallback
    // matches composite keys like `kanban:<department>:<ticketId>`. Without
    // department scoping, marketing's running `t-blocked` session would keep
    // delivery's genuinely dead `t-blocked` from ever being flagged.
    writeManager("delivery");
    writeBoard("delivery", [{
      id: "t-blocked",
      title: "Dead work in delivery",
      status: "blocked",
      createdAt: iso(TWO_HOURS),
      updatedAt: iso(TWO_HOURS),
    }]);
    hoisted.sessions = [
      session({
        id: "s-marketing",
        status: "running",
        sourceRef: "kanban:marketing:t-blocked",
        sessionKey: "kanban:marketing:t-blocked",
        transportMeta: { boardDepartment: "marketing" } as never,
      }),
      session({ id: "s-delivery", status: "error" }),
    ];

    await runOneTick();

    const board = readBoard("delivery");
    expect(board.find((t) => t.id === "t-blocked")?.manualOnly).toBe(true);
    expect(hoisted.dispatchTicketMock).toHaveBeenCalledOnce();
  });

  it("keeps an exactly-linked session even when its key is not a board key", async () => {
    // A cross-request session's key is `cross-request:<timestamp>:<provider>` —
    // three colon-segments, exactly the shape of a board key, but the middle
    // segment is a timestamp rather than a department. Department scoping must
    // not use that shape to discard a session the ticket links to by id, or a
    // live cross-request waiting on approval gets its ticket quarantined and the
    // manager is told to start duplicate work.
    writeManager("delivery");
    writeBoard("delivery", [{
      id: "t-cross",
      title: "Cross-request work",
      status: "blocked",
      sessionId: "s-cross",
      createdAt: iso(TWO_HOURS),
      updatedAt: iso(TWO_HOURS),
    }]);
    hoisted.sessions = [session({
      id: "s-cross",
      status: "waiting",
      sourceRef: "cross-request:1750000000000:blair",
      sessionKey: "cross-request:1750000000000:blair",
    })];

    await runOneTick();

    const board = readBoard("delivery");
    expect(board.find((t) => t.id === "t-cross")?.manualOnly).toBeUndefined();
    expect(hoisted.dispatchTicketMock).not.toHaveBeenCalled();
  });

  it("ignores tickets already flagged manualOnly and recently-blocked tickets", async () => {
    writeManager("delivery");
    writeBoard("delivery", [
      { id: "t-manual", title: "Already flagged", status: "blocked", manualOnly: true, createdAt: iso(TWO_HOURS), updatedAt: iso(TWO_HOURS) },
      { id: "t-fresh", title: "Just blocked", status: "blocked", createdAt: iso(60_000), updatedAt: iso(60_000) },
    ]);

    await runOneTick();

    expect(readBoard("delivery").some((t) => t.source === "watchdog")).toBe(false);
    expect(hoisted.dispatchTicketMock).not.toHaveBeenCalled();
  });
});
