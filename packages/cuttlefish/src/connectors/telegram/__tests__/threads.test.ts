import { describe, it, expect } from "vitest";
import { deriveSessionKey, buildReplyContext, isOldTelegramMessage } from "../threads.js";

describe("deriveSessionKey", () => {
  it("returns telegram:<chatId> for a private chat", () => {
    expect(
      deriveSessionKey({ chat: { id: 12345, type: "private" }, message_id: 1 }),
    ).toBe("telegram:12345");
  });

  it("returns telegram:<chatId> for a group chat", () => {
    expect(
      deriveSessionKey({ chat: { id: -100999, type: "group" }, message_id: 1 }),
    ).toBe("telegram:-100999");
  });

  it("returns telegram:<chatId> for a supergroup", () => {
    expect(
      deriveSessionKey({ chat: { id: -1001234, type: "supergroup" }, message_id: 1 }),
    ).toBe("telegram:-1001234");
  });
});

describe("buildReplyContext", () => {
  it("builds reply context for a private message", () => {
    const ctx = buildReplyContext({
      chat: { id: 12345, type: "private" },
      message_id: 42,
    });
    expect(ctx).toEqual({
      chatId: 12345,
      messageId: 42,
    });
  });

  it("builds reply context for a group message", () => {
    const ctx = buildReplyContext({
      chat: { id: -100999, type: "group" },
      message_id: 99,
    });
    expect(ctx).toEqual({
      chatId: -100999,
      messageId: 99,
    });
  });
});

describe("isOldTelegramMessage", () => {
  it("returns true for messages before boot time", () => {
    const bootTime = 1700000000000; // ms
    const msgDate = 1699999990; // seconds — before boot
    expect(isOldTelegramMessage(msgDate, bootTime)).toBe(true);
  });

  it("returns false for messages after boot time", () => {
    const bootTime = 1700000000000;
    const msgDate = 1700000010; // seconds — after boot
    expect(isOldTelegramMessage(msgDate, bootTime)).toBe(false);
  });

  it("returns false for undefined date", () => {
    expect(isOldTelegramMessage(undefined, Date.now())).toBe(false);
  });
});
