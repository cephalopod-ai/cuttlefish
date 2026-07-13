import { describe, it, expect, beforeEach } from "vitest";
import {
  attach,
  detach,
  listAttachments,
  talkSessionsAttachedTo,
  __resetAttachmentsForTest,
  type AttachmentDeps,
} from "../attachments.js";
import type { JsonObject, Session } from "../../shared/types.js";

/**
 * Fake meta store: mirrors the registry's transport_meta column. getSession
 * returns a session shell carrying the stored transportMeta; patchSessionMeta
 * merges a patch in place (exactly how routes.ts wires registry persistence).
 */
function makeDeps(): AttachmentDeps & { store: Map<string, JsonObject | null> } {
  const store = new Map<string, JsonObject | null>();
  return {
    store,
    getSession: (id: string): Session | undefined =>
      ({ id, transportMeta: store.get(id) ?? null }) as unknown as Session,
    patchSessionMeta: (id: string, patch: JsonObject) => {
      store.set(id, { ...(store.get(id) ?? {}), ...patch });
    },
  };
}

describe("attachments", () => {
  beforeEach(() => __resetAttachmentsForTest());

  it("attaches a target and lists it", () => {
    const d = makeDeps();
    const r = attach("talk1", "sess-a", "observe", d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.targetId).toBe("sess-a");
      expect(r.attachment.mode).toBe("observe");
      expect(typeof r.attachment.since).toBe("number");
    }
    const list = listAttachments("talk1", d);
    expect(list.map((a) => a.targetId)).toEqual(["sess-a"]);
  });

  it("caps at 5 attachments per talk session", () => {
    const d = makeDeps();
    for (let i = 0; i < 5; i++) {
      expect(attach("talk1", `sess-${i}`, "observe", d).ok).toBe(true);
    }
    const sixth = attach("talk1", "sess-5", "engage", d);
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.error).toMatch(/cap/i);
    // Re-attaching an EXISTING target (idempotent mode update) is not capped.
    const again = attach("talk1", "sess-0", "engage", d);
    expect(again.ok).toBe(true);
    expect(listAttachments("talk1", d)).toHaveLength(5);
  });

  it("detach removes an attachment; unknown returns false", () => {
    const d = makeDeps();
    attach("talk1", "sess-a", "engage", d);
    expect(detach("talk1", "sess-a", d)).toBe(true);
    expect(listAttachments("talk1", d)).toEqual([]);
    expect(detach("talk1", "sess-a", d)).toBe(false);
    expect(detach("talk1", "never", d)).toBe(false);
  });

  it("talkSessionsAttachedTo reverse-maps a target to its talk sessions", () => {
    const d = makeDeps();
    attach("talkA", "shared", "observe", d);
    attach("talkB", "shared", "engage", d);
    attach("talkB", "other", "observe", d);
    expect(talkSessionsAttachedTo("shared").sort()).toEqual(["talkA", "talkB"]);
    expect(talkSessionsAttachedTo("other")).toEqual(["talkB"]);
    expect(talkSessionsAttachedTo("nobody")).toEqual([]);
    detach("talkA", "shared", d);
    expect(talkSessionsAttachedTo("shared")).toEqual(["talkB"]);
  });

  it("persists into transport_meta under talkAttachments, preserving other keys", () => {
    const d = makeDeps();
    d.store.set("talk1", { existingKey: "keep-me" });
    attach("talk1", "sess-a", "observe", d);
    const meta = d.store.get("talk1") as JsonObject;
    expect(meta.existingKey).toBe("keep-me");
    expect(Array.isArray(meta.talkAttachments)).toBe(true);
    expect((meta.talkAttachments as unknown[]).length).toBe(1);
  });

  it("lazily hydrates in-memory state from persisted meta (roundtrip)", () => {
    const d = makeDeps();
    attach("talk1", "sess-a", "engage", d);
    const persisted = d.store.get("talk1");

    // Simulate a fresh process: drop in-memory state but keep the meta store.
    __resetAttachmentsForTest();
    d.store.set("talk1", persisted ?? null);

    // First read hydrates from meta.
    const list = listAttachments("talk1", d);
    expect(list.map((a) => a.targetId)).toEqual(["sess-a"]);
    expect(list[0].mode).toBe("engage");
    // And the reverse map sees it after hydration.
    expect(talkSessionsAttachedTo("sess-a")).toEqual(["talk1"]);
  });

  it("ignores corrupt persisted entries on hydration", () => {
    const d = makeDeps();
    d.store.set("talk1", {
      talkAttachments: [
        { targetId: "good", mode: "observe", since: 1 },
        { targetId: 123, mode: "observe" },
        { mode: "engage" },
        "garbage",
        { targetId: "badmode", mode: "nope" },
      ] as unknown as JsonObject[],
    });
    const list = listAttachments("talk1", d);
    expect(list.map((a) => a.targetId)).toEqual(["good"]);
  });
});
