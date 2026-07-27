import { beforeAll, describe, expect, it, vi } from "vitest";
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
