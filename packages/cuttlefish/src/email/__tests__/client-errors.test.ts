import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EmailInboxConfig } from "../../shared/types.js";

const state = vi.hoisted(() => ({ phase: "connect", clients: [] as any[] }));
vi.mock("imapflow", () => ({
  ImapFlow: class extends EventEmitter {
    close = vi.fn();
    logout = vi.fn(async () => {});
    constructor() { super(); state.clients.push(this); }
    async connect() { if (state.phase === "connect") this.emit("error", new Error("Socket timeout")); }
    async mailboxOpen() { return { uidValidity: 7 }; }
    async search() { return []; }
    async *fetch() {
      if (state.phase === "fetch") this.emit("error", new Error("Socket timeout"));
      yield* [];
    }
    async messageFlagsAdd() { if (state.phase === "markSeen") this.emit("error", new Error("Socket timeout")); }
  },
}));
import { ImapEmailMailboxClient } from "../client.js";
const inbox = { id: "fault-inbox", imapHost: "127.0.0.1", username: "fixture", password: "fixture" } as EmailInboxConfig;

describe("IMAP socket error ownership", () => {
  it.each(["connect", "fetch", "markSeen"])("rejects %s errors to inbox health and cleans up", async (phase) => {
    state.phase = phase;
    const client = new ImapEmailMailboxClient();
    await expect(phase === "markSeen" ? client.markSeen(inbox, "7:1") : client.fetchUnread(inbox)).rejects.toThrow("Socket timeout");
    const connection = state.clients.at(-1);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.logout).toHaveBeenCalledOnce();
  });
  it("preserves a healthy empty inbox and successful mark-seen", async () => {
    state.phase = "healthy";
    const client = new ImapEmailMailboxClient();
    await expect(client.fetchUnread(inbox)).resolves.toEqual([]);
    await expect(client.markSeen(inbox, "7:1")).resolves.toBeUndefined();
    expect(state.clients.at(-1).close).not.toHaveBeenCalled();
  });
});
