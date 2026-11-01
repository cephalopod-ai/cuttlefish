import { beforeAll, describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ChatBlock } from "../../shared/types.js";

withStaticTempCuttlefishHome("cuttlefish-duplicate-history-");

let reg: typeof import("../registry.js");

beforeAll(async () => {
  reg = await import("../registry.js");
});

function sourceSession(sourceRef: string) {
  const session = reg.createSession({ engine: "claude", source: "web", sourceRef });
  reg.updateSession(session.id, { engineSessionId: "history-engine" });
  return session;
}

describe("duplicateSession completed history", () => {
  it("copies finalized and legacy-zero rows without promoting active or quarantined fragments", () => {
    const source = sourceSession("web:duplicate-completion");
    const db = reg.initDb();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    reg.insertMessage(source.id, "user", "finalized input");
    const legacy = reg.insertMessage(source.id, "assistant", "legacy finalized output");
    db.prepare("UPDATE messages SET partial = 0 WHERE id = ?").run(legacy);
    reg.insertPartialMessage(source.id, "assistant", "crashed output", 1, "Bash");
    reg.clearAllPartialMessages();
    reg.insertPartialMessage(source.id, "assistant", "active output", 2, "Read");

    const { session: copy, messageCount } = reg.duplicateSession(source.id);

    expect(messageCount).toBe(2);
    expect(reg.getMessages(copy.id).map((message) => message.content)).toEqual([
      "finalized input", "legacy finalized output",
    ]);
    expect(reg.getMessages(copy.id).every((message) => !message.partial)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(source.id))
      .toEqual({ count: 4 });
    expect(db.prepare("SELECT content FROM messages WHERE session_id = ? AND partial = 2").all(source.id))
      .toEqual([{ content: "crashed output" }]);
    expect(reg.getMessages(source.id).find((message) => message.content === "active output")?.partial).toBe(true);
  });

  it("retains tool identity, media, blocks and equal-timestamp sequence ordering", () => {
    const source = sourceSession("web:duplicate-metadata");
    const db = reg.initDb();
    const media = [{ type: "file" as const, url: "/api/files/history-file", name: "history.txt" }];
    const blocks: ChatBlock[] = [{ id: "history-plan", type: "task-list", version: 1, payload: { items: [{ id: "step", text: "Keep history" }] } }];
    const second = reg.insertMessage(source.id, "assistant", "second", media, blocks);
    const first = reg.insertMessage(source.id, "assistant", "first");
    db.prepare("UPDATE messages SET timestamp = 100, seq = 2, tool_call = 'Bash' WHERE id = ?").run(second);
    db.prepare("UPDATE messages SET timestamp = 100, seq = 1 WHERE id = ?").run(first);
    const original = reg.getMessages(source.id);

    const { session: copy, messageCount } = reg.duplicateSession(source.id);
    const copied = reg.getMessages(copy.id);

    expect(messageCount).toBe(2);
    expect(copied.map(({ id: _id, ...message }) => message))
      .toEqual(original.map(({ id: _id, ...message }) => message));
    expect(copied.map((message) => message.content)).toEqual(["first", "second"]);
    expect(copied[1]).toMatchObject({ toolCall: "Bash", media, blocks });
    expect(copied[0].id).not.toBe(original[0].id);
    expect(db.prepare("SELECT seq FROM messages WHERE session_id = ? ORDER BY timestamp, seq").all(copy.id))
      .toEqual([{ seq: 1 }, { seq: 2 }]);
  });
});
