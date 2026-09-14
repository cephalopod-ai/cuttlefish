import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJsonStringify, canonicalSha256 } from "../canonical-json.js";

describe("canonicalJsonStringify", () => {
  it("is invariant to object key construction order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const built: Record<string, unknown> = {};
    built.c = { y: 2, z: 1 };
    built.a = 2;
    built.b = 1;
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(built));
    expect(canonicalJsonStringify(a)).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it("preserves array element order (arrays are not sorted)", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJsonStringify({ ids: ["b", "a"] })).toBe('{"ids":["b","a"]}');
  });

  it("drops undefined-valued object properties, matching JSON.stringify", () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("recurses through nested arrays and objects", () => {
    const value = { steps: [{ id: "b", deps: [] }, { id: "a", deps: ["b"] }] };
    expect(canonicalJsonStringify(value)).toBe('{"steps":[{"deps":[],"id":"b"},{"deps":["b"],"id":"a"}]}');
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["bigint", 1n],
    ["function", () => {}],
    ["symbol", Symbol("x")],
  ])("throws CanonicalJsonError on %s", (_label, value) => {
    expect(() => canonicalJsonStringify({ v: value })).toThrow(CanonicalJsonError);
  });

  it("throws on a Date rather than silently collapsing it to {}", () => {
    expect(() => canonicalJsonStringify({ at: new Date() })).toThrow(CanonicalJsonError);
  });

  it("throws on a Map or Set rather than silently collapsing them to {}", () => {
    expect(() => canonicalJsonStringify(new Map([["a", 1]]))).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify(new Set([1, 2]))).toThrow(CanonicalJsonError);
  });

  it("passes through primitives and null unchanged", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(42)).toBe("42");
    expect(canonicalJsonStringify("x")).toBe('"x"');
    expect(canonicalJsonStringify(true)).toBe("true");
  });
});

describe("canonicalSha256", () => {
  it("is a pinned golden vector, to catch an accidental algorithm change", () => {
    // If this test ever needs to change, every existing *_sha256 column that
    // was computed with the old algorithm is now silently wrong — treat a
    // failure here as a five-alarm signal, not a fixture update.
    expect(canonicalSha256({ a: 1, b: [1, 2, 3] })).toBe(
      "bfa6ceebf136e4837ec687f2be09f612c645c9ec1f99e3ef5d497b0d5bb99e0a",
    );
  });

  it("hashes two key-order variants of the same object identically", () => {
    expect(canonicalSha256({ a: 1, b: 2 })).toBe(canonicalSha256({ b: 2, a: 1 }));
  });

  it("hashes semantically different objects differently", () => {
    expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: 2 }));
  });

  it("mirrors the source-snapshot volatile-field problem: identical content, different capture metadata, must hash the same once metadata is excluded from the hashed shape", () => {
    const contentA = { headCommit: "abc123", dirty: false };
    const contentB = { headCommit: "abc123", dirty: false };
    // Simulates two captures at different times/boot generations — the
    // caller is responsible for only ever passing the content-identity
    // subset (see contracts/source-snapshot.ts#SourceSnapshotHashInputV1),
    // and this test documents why: hashing the full record (including
    // capturedAt/bootGeneration) would make these differ even though the
    // repository state they describe is identical.
    expect(canonicalSha256(contentA)).toBe(canonicalSha256(contentB));
  });
});
