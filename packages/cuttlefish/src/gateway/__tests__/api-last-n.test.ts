import { describe, it, expect } from "vitest";
import { sliceLastMessages } from "../api/session-query-routes.js";

describe("sliceLastMessages", () => {
  const messages = [1, 2, 3, 4, 5];

  it("returns last N messages when N < total", () => {
    expect(sliceLastMessages(messages, "3")).toEqual([3, 4, 5]);
  });

  it("returns all messages when N >= total", () => {
    expect(sliceLastMessages(messages, "10")).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns all when N equals total", () => {
    expect(sliceLastMessages(messages, "5")).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns all when N is 0 (no filtering)", () => {
    expect(sliceLastMessages(messages, "0")).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns all when N is negative", () => {
    expect(sliceLastMessages(messages, "-1")).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns last 1 message", () => {
    expect(sliceLastMessages(messages, "1")).toEqual([5]);
  });

  it("handles empty array", () => {
    expect(sliceLastMessages([], "3")).toEqual([]);
  });

  it("returns all messages when the query param is missing", () => {
    expect(sliceLastMessages(messages, null)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns all messages when the query param is invalid", () => {
    expect(sliceLastMessages(messages, "abc")).toEqual([1, 2, 3, 4, 5]);
  });
});
