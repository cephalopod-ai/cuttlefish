import { describe, expect, it } from "vitest";
import { matchRoute } from "../api.js";

describe("route parameter decoding", () => {
  it("rejects encoded slashes and backslashes before filesystem paths are built", () => {
    expect(matchRoute("/api/skills/:name", "/api/skills/..%2Fsecrets")).toBeNull();
    expect(matchRoute("/api/org/departments/:name/board", "/api/org/departments/platform%5C..%5Csecret/board")).toBeNull();
  });

  it("rejects dot segments and malformed encodings", () => {
    expect(matchRoute("/api/skills/:name", "/api/skills/..")).toBeNull();
    expect(matchRoute("/api/skills/:name", "/api/skills/.")).toBeNull();
    expect(matchRoute("/api/skills/:name", "/api/skills/%E0%A4%A")).toBeNull();
  });

  it("still decodes ordinary single-segment route params", () => {
    expect(matchRoute("/api/skills/:name", "/api/skills/content-lead")).toEqual({ name: "content-lead" });
    expect(matchRoute("/api/cron/:id/runs", "/api/cron/daily%20digest/runs")).toEqual({ id: "daily digest" });
  });
});
