import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watch = vi.hoisted(() => vi.fn());
vi.mock("chokidar", () => ({ watch }));
vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));

import { startWatchers, stopWatchers } from "../watcher.js";

let handles: Array<EventEmitter & { close: () => Promise<void> }>;

beforeEach(() => {
  vi.useFakeTimers();
  handles = [];
  watch.mockImplementation(() => {
    const handle = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
    handles.push(handle);
    return handle;
  });
});

afterEach(async () => {
  await stopWatchers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function callbacks(onConfigReload = vi.fn()) {
  return { onConfigReload, onCronReload: vi.fn(), onOrgChange: vi.fn(), onSkillsChange: vi.fn() };
}

describe("watcher debounce shutdown", () => {
  it("cancels pending reloads and ignores old events after shutdown", async () => {
    const old = callbacks();
    startWatchers(old);
    handles[0].emit("change");
    await stopWatchers();
    handles[0].emit("change");
    await vi.advanceTimersByTimeAsync(600);
    expect(old.onConfigReload).not.toHaveBeenCalled();
    expect(handles.every((handle) => vi.mocked(handle.close).mock.calls.length === 1)).toBe(true);
  });

  it("preserves normal debounce and fresh callbacks after restart", async () => {
    const old = callbacks();
    startWatchers(old);
    handles[0].emit("change");
    await stopWatchers();
    const fresh = callbacks();
    startWatchers(fresh);
    handles[4].emit("change");
    handles[4].emit("change");
    await vi.advanceTimersByTimeAsync(600);
    expect(old.onConfigReload).not.toHaveBeenCalled();
    expect(fresh.onConfigReload).toHaveBeenCalledOnce();
  });
});
