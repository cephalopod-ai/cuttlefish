import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: _tmp } = withStaticTempCuttlefishHome("cuttlefish-session-resources-");

type Reg = typeof import("../../sessions/registry.js");
type RunAttachments = typeof import("../run-attachments.js");
type SessionResources = typeof import("../session-resources.js");

let reg: Reg;
let runAttachments: RunAttachments;
let sessionResources: SessionResources;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  runAttachments = await import("../run-attachments.js");
  sessionResources = await import("../session-resources.js");
  reg.initDb();
});

function makeCtx() {
  return {
    getConfig: () => ({ gateway: {}, engines: { default: "claude" }, portal: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: () => {},
    sessionManager: {
      getEngine: () => undefined,
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
  } as unknown as import("../api.js").ApiContext;
}

describe("attachResourcesToSession — transport_meta race (DFI-007)", () => {
  it("merges onto the current transport_meta at write time, not a snapshot captured before the resolve/screen awaits", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "test-transport-meta-race",
      transportMeta: { existing: "before-await" },
    });

    // Simulate a writer landing on this session's transport_meta WHILE
    // attachResourcesToSession is awaiting resolution/screening — e.g. a
    // status update from a concurrent request. If attachResourcesToSession
    // still used the `session.transportMeta` object captured at function
    // entry, this concurrent write would be silently clobbered by the final
    // updateSession call.
    const originalScreen = runAttachments.screenRunAttachmentsForSession;
    const screenSpy = vi.spyOn(runAttachments, "screenRunAttachmentsForSession")
      .mockImplementation(async (...args) => {
        reg.patchSessionTransportMeta(session.id, { concurrentField: "from-elsewhere" });
        return originalScreen(...args);
      });

    try {
      await sessionResources.attachResourcesToSession(
        session,
        { attachments: [{ url: "https://example.com/report.csv" }] },
        makeCtx(),
      );
    } finally {
      screenSpy.mockRestore();
    }

    const persisted = reg.getSession(session.id);
    expect(persisted?.transportMeta).toMatchObject({
      existing: "before-await",
      concurrentField: "from-elsewhere",
    });
    expect(persisted?.transportMeta?.runAttachments).toBeDefined();
  });
});

describe("persisted session resource dispatch", () => {
  it("retains both resource additions when validation overlaps on the same session", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:concurrent-resources" });
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const mayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { startedFirst = resolve; });
    const original = runAttachments.screenRunAttachmentsForSession;
    const screenSpy = vi.spyOn(runAttachments, "screenRunAttachmentsForSession").mockImplementationOnce(async (...args) => {
      const screened = await original(...args);
      startedFirst();
      await mayFinish;
      return screened;
    });
    const first = sessionResources.attachResourcesToSession(session, { resources: [{ url: "https://example.com/first" }] }, makeCtx());
    try {
      await started;
      await sessionResources.attachResourcesToSession(session, { resources: [{ url: "https://example.com/second" }] }, makeCtx());
      releaseFirst();
      const result = await first;
      expect(runAttachments.listRunAttachments(reg.getSession(session.id)!).map((attachment) => attachment.url).sort()).toEqual([
        "https://example.com/first", "https://example.com/second",
      ]);
      expect(result.promptBlock).toContain("https://example.com/second");
    } finally {
      releaseFirst();
      await first;
      screenSpy.mockRestore();
    }
  });

  it("reconstructs local file paths for later turns with no new attachments", async () => {
    const filePath = path.join(_tmp, "empty.txt");
    fs.writeFileSync(filePath, "");
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:resource-roundtrip" });
    const first = await sessionResources.attachResourcesToSession(session, { resources: [{ path: filePath }] }, makeCtx());
    expect(first.engineAttachments).toEqual([filePath]);

    const reloaded = reg.getSession(session.id)!;
    const followup = await sessionResources.attachResourcesToSession(reloaded, { message: "Use the same file" }, makeCtx());
    expect(followup.engineAttachments).toEqual([filePath]);
    expect(sessionResources.describeSessionResources(reloaded).engineAttachments).toEqual([filePath]);
  });

  it("does not release a quarantined resource set when replay resumes reconsideration", async () => {
    const filePath = path.join(_tmp, "requires-review.pdf");
    fs.writeFileSync(filePath, "binary file fixture");
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:resource-quarantine" });
    const attached = await sessionResources.attachResourcesToSession(session, { resources: [{ path: filePath }] }, makeCtx());
    expect(attached.blocked).toBe(true);

    expect(sessionResources.queuedSessionResourceOptions(reg.getSession(session.id)!)).toEqual({});
  });
});
