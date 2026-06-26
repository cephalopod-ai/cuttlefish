import { describe, it, expect } from "vitest";
import { viewModeKey, readViewMode, writeViewMode, type KVStore } from "../view-mode";

function memStore(): KVStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

describe("view-mode", () => {
  it("viewModeKey is namespaced per session id", () => {
    expect(viewModeKey("s1")).toBe("cuttlefish-view-mode-s1");
  });

  it("readViewMode defaults to chat for an unknown session", () => {
    expect(readViewMode("s1", memStore())).toBe("chat");
  });

  it("writeViewMode round-trips per session", () => {
    const store = memStore();
    writeViewMode("s1", "cli", store);
    writeViewMode("s2", "chat", store);
    expect(readViewMode("s1", store)).toBe("cli");
    expect(readViewMode("s2", store)).toBe("chat");
  });

  it("readViewMode coerces a garbage stored value to chat", () => {
    const store = memStore();
    store.setItem(viewModeKey("s3"), "garbage");
    expect(readViewMode("s3", store)).toBe("chat");
  });
});
