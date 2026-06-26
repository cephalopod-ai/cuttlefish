import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import {
  createArchiveAndDeleteSessionsRecord,
  createArchiveRecord,
  deleteArchiveRecord,
  getArchiveRecord,
  listArchiveRecords,
  snapshotSessionsForArchive,
  type ArchiveRegistryDeps,
} from "../registry-archives.js";

const { home: _tmp } = withStaticTempCuttlefishHome("cuttlefish-registry-archives-");

type Reg = typeof import("../registry.js");

let reg: Reg;
let deps: ArchiveRegistryDeps;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
  deps = {
    getDb: reg.initDb,
    getSession: reg.getSession,
    getMessages: reg.getMessages,
  };
});

describe("registry archive helper", () => {
  it("snapshots, persists, lists, loads, and deletes archives without the registry facade", () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:helper-archive",
      title: "Helper archive",
    });
    reg.insertMessage(session.id, "user", "save this");
    reg.insertMessage(session.id, "assistant", "saved", [
      { type: "file", url: "/api/files/file-1", name: "notes.txt" },
    ]);

    const snapshots = snapshotSessionsForArchive([session.id], deps);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].messages[1].media?.[0].name).toBe("notes.txt");

    const archive = createArchiveRecord({
      kind: "chat",
      label: "Helper",
      sessions: snapshots,
    }, deps);
    expect(listArchiveRecords(deps)[0]?.id).toBe(archive.id);
    expect(getArchiveRecord(archive.id, deps)?.sessions[0]?.id).toBe(session.id);
    expect(deleteArchiveRecord(archive.id, deps)).toBe(true);
  });

  it("keeps archive-and-delete transactional when deleting live rows", () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:helper-archive-delete",
      title: "Helper archive delete",
    });
    reg.insertMessage(session.id, "user", "archive and remove");
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");

    const archive = createArchiveAndDeleteSessionsRecord({
      kind: "chat",
      sessionIds: [session.id],
      label: "Delete helper",
    }, deps);

    expect(archive?.sessionCount).toBe(1);
    expect(reg.getSession(session.id)).toBeUndefined();
    expect(reg.getMessages(session.id)).toEqual([]);
    expect(reg.getQueueItems(session.sessionKey)).toEqual([]);
  });
});
