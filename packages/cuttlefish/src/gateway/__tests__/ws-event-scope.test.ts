import { describe, expect, it } from "vitest";
import { canSendWsEventToPrincipal, payloadSessionId } from "../ws-event-scope.js";

describe("WebSocket event scoping", () => {
  it("lets admin and unauthenticated sockets receive broadcast events", () => {
    expect(canSendWsEventToPrincipal(undefined, { sessionId: "s-1" }, () => undefined)).toBe(true);
    expect(canSendWsEventToPrincipal({ kind: "admin" }, { sessionId: "s-1" }, () => undefined)).toBe(true);
  });

  it("limits session-scoped sockets to own session and direct child sessions", () => {
    const principal = { kind: "session" as const, sessionId: "parent" };
    const getSession = (id: string) => id === "child" ? { parentSessionId: "parent" } : undefined;

    expect(canSendWsEventToPrincipal(principal, { sessionId: "parent" }, getSession)).toBe(true);
    expect(canSendWsEventToPrincipal(principal, { sessionId: "child" }, getSession)).toBe(true);
    expect(canSendWsEventToPrincipal(principal, { sessionId: "sibling" }, getSession)).toBe(false);
    expect(canSendWsEventToPrincipal(principal, { count: 3 }, getSession)).toBe(false);
  });

  it("extracts only non-empty object session ids from event payloads", () => {
    expect(payloadSessionId({ sessionId: "s-1" })).toBe("s-1");
    expect(payloadSessionId({ sessionId: "   " })).toBeNull();
    expect(payloadSessionId([{ sessionId: "s-1" }])).toBeNull();
    expect(payloadSessionId(null)).toBeNull();
  });
});
