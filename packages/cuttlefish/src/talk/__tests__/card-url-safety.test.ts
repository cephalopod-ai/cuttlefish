import { describe, expect, it } from "vitest";
import { validateCard } from "../card-validate.js";

describe("card URL scheme safety (audit G-02/I-3)", () => {
  it("rejects a javascript: link url", () => {
    const r = validateCard({ id: "c1", type: "link", url: "javascript:alert(1)", label: "x" });
    expect(r.ok).toBe(false);
  });
  it("rejects a file: image src", () => {
    const r = validateCard({ id: "c2", type: "image", src: "file:///etc/passwd" });
    expect(r.ok).toBe(false);
  });
  it("accepts an https image src", () => {
    const r = validateCard({ id: "c3", type: "image", src: "https://cdn.example.com/a.png" });
    expect(r.ok).toBe(true);
  });
  it("accepts a relative image src and a data:image src", () => {
    expect(validateCard({ id: "c4", type: "image", src: "/assets/a.png" }).ok).toBe(true);
    expect(validateCard({ id: "c5", type: "image", src: "data:image/png;base64,AAAA" }).ok).toBe(true);
  });
});
