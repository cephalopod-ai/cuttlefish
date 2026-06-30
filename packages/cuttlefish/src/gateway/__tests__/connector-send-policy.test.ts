import { describe, expect, it } from "vitest";
import { authorizeConnectorSend } from "../connector-send-policy.js";
import type { Session } from "../../shared/types/sessions.js";

function fakeGetSession(session: Partial<Session> | undefined) {
  return ((_id: string) => session as Session | undefined) as never;
}

describe("authorizeConnectorSend", () => {
  it("allows admin principals", () => {
    const r = authorizeConnectorSend({ kind: "admin" }, "slack", {
      getSession: fakeGetSession(undefined),
    });
    expect(r).toEqual({ allowed: true });
  });

  it("allows an undefined principal (operator path already authenticated)", () => {
    const r = authorizeConnectorSend(undefined, "slack", {
      getSession: fakeGetSession(undefined),
    });
    expect(r).toEqual({ allowed: true });
  });

  it("allows a session that owns the connector and has a trusted source", () => {
    const r = authorizeConnectorSend({ kind: "session", sessionId: "s1" }, "slack", {
      getSession: fakeGetSession({ connector: "slack", source: "web" }),
    });
    expect(r).toEqual({ allowed: true });
  });

  it("rejects a session sending via a connector it does not own", () => {
    const r = authorizeConnectorSend({ kind: "session", sessionId: "s1" }, "slack", {
      getSession: fakeGetSession({ connector: "whatsapp", source: "web" }),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/own connector/);
  });

  it("rejects a session with no bound connector", () => {
    const r = authorizeConnectorSend({ kind: "session", sessionId: "s1" }, "slack", {
      getSession: fakeGetSession({ source: "web" }),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/own connector/);
  });

  it("rejects an untrusted-source session even when it owns the connector", () => {
    const r = authorizeConnectorSend({ kind: "session", sessionId: "s1" }, "slack", {
      getSession: fakeGetSession({ connector: "slack", source: "slack" }),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/may not send outbound/);
  });

  it("rejects when the caller session no longer exists", () => {
    const r = authorizeConnectorSend({ kind: "session", sessionId: "gone" }, "slack", {
      getSession: fakeGetSession(undefined),
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/own connector/);
  });
});
