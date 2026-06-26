import { describe, it, expect, beforeEach } from "vitest";
import { isTalkMuted, setTalkMuted, clearTalkMuted } from "../mute-state.js";

describe("talk mute-state", () => {
  beforeEach(() => {
    clearTalkMuted("s1");
    clearTalkMuted("s2");
  });

  it("defaults to not-muted for an unknown session", () => {
    expect(isTalkMuted("s1")).toBe(false);
  });

  it("marks a session muted and back", () => {
    setTalkMuted("s1", true);
    expect(isTalkMuted("s1")).toBe(true);
    setTalkMuted("s1", false);
    expect(isTalkMuted("s1")).toBe(false);
  });

  it("tracks sessions independently", () => {
    setTalkMuted("s1", true);
    expect(isTalkMuted("s1")).toBe(true);
    expect(isTalkMuted("s2")).toBe(false);
  });

  it("clearTalkMuted forgets the session (treated as not-muted)", () => {
    setTalkMuted("s2", true);
    clearTalkMuted("s2");
    expect(isTalkMuted("s2")).toBe(false);
  });

  it("ignores an empty session id", () => {
    setTalkMuted("", true);
    expect(isTalkMuted("")).toBe(false);
  });
});
