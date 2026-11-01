import { describe, it, expect, vi } from "vitest";
import { SessionQueue } from "../queue.js";

// markQueueItemRunning/Completed touch the registry DB — stub them out
vi.mock("../registry.js", () => ({
  getQueueItem: vi.fn(() => ({ status: "pending" })),
  listPausedQueueKeys: vi.fn(() => []),
  markQueueItemRunning: vi.fn(),
  markQueueItemCompleted: vi.fn(),
  pauseQueueKey: vi.fn(),
  resumeQueueKey: vi.fn(),
}));

import {
  getQueueItem,
  markQueueItemCompleted,
  markQueueItemRunning,
  pauseQueueKey,
  resumeQueueKey,
} from "../registry.js";

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionQueue pause/resume", () => {
  it("does not revive cleared work or subtract it from a fresh generation's depth", async () => {
    const queue = new SessionQueue();
    const seen: string[] = [];
    let releaseFirst!: () => void;
    let releaseFresh!: () => void;
    const first = queue.enqueue("connector:clear", async () => {
      seen.push("first");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await tick();
    const old = queue.enqueue("connector:clear", async () => { seen.push("old"); });
    queue.clearQueue("connector:clear");
    queue.clearCancelled("connector:clear");
    const fresh = queue.enqueue("connector:clear", async () => {
      seen.push("fresh");
      await new Promise<void>((resolve) => { releaseFresh = resolve; });
    });
    const later = queue.enqueue("connector:clear", async () => { seen.push("later"); });
    expect(queue.getPendingCount("connector:clear")).toBe(2);
    releaseFirst();
    await tick();
    expect(seen).toEqual(["first", "fresh"]);
    expect(queue.getPendingCount("connector:clear")).toBe(1);
    releaseFresh();
    await Promise.all([first, old, fresh, later]);
    expect(seen).toEqual(["first", "fresh", "later"]);
    expect(queue.getPendingCount("connector:clear")).toBe(0);
  });

  it("drains cleared paused work without unpausing fresh work", async () => {
    const queue = new SessionQueue();
    const key = "connector:paused-clear";
    const oldRun = vi.fn();
    const freshRun = vi.fn();
    queue.pauseQueue(key);
    const old = queue.enqueue(key, async () => { oldRun(); });
    await tick();
    queue.clearQueue(key);
    queue.clearCancelled(key);
    const fresh = queue.enqueue(key, async () => { freshRun(); });
    await old;
    await tick();
    expect(oldRun).not.toHaveBeenCalled();
    expect(freshRun).not.toHaveBeenCalled();
    expect(queue.isPaused(key)).toBe(true);
    queue.resumeQueue(key);
    await fresh;
    expect(freshRun).toHaveBeenCalledOnce();
    expect(queue.hasScheduled(key)).toBe(false);
  });

  it("keeps work accepted while cancelled separate from the fresh generation", async () => {
    const queue = new SessionQueue();
    const oldRun = vi.fn();
    const freshRun = vi.fn();
    queue.clearQueue("connector:cancelled");
    const old = queue.enqueue("connector:cancelled", async () => { oldRun(); });
    queue.clearCancelled("connector:cancelled");
    const fresh = queue.enqueue("connector:cancelled", async () => { freshRun(); });
    await Promise.all([old, fresh]);
    expect(oldRun).not.toHaveBeenCalled();
    expect(freshRun).toHaveBeenCalledOnce();
  });

  it("holds queued tasks while paused and wakes them promptly on resume", async () => {
    const queue = new SessionQueue();
    const key = "slack:C123";
    let ran = false;

    queue.pauseQueue(key);
    const task = queue.enqueue(key, async () => {
      ran = true;
    });

    await tick();
    expect(ran).toBe(false);

    const resumedAt = Date.now();
    queue.resumeQueue(key);
    await task;
    expect(ran).toBe(true);
    expect(pauseQueueKey).toHaveBeenCalledWith(key);
    expect(resumeQueueKey).toHaveBeenCalledWith(key);
    // Event-based wakeup: must not wait out a polling interval after resume.
    expect(Date.now() - resumedAt).toBeLessThan(400);
  });

  it("re-blocks if the key is paused again before the waiter is released", async () => {
    const queue = new SessionQueue();
    const key = "slack:C456";
    let ran = false;

    queue.pauseQueue(key);
    const task = queue.enqueue(key, async () => {
      ran = true;
    });

    await tick();
    // Resume and immediately pause again (synchronously) — the while-loop must
    // re-check the paused set and keep waiting.
    queue.resumeQueue(key);
    queue.pauseQueue(key);

    await tick();
    expect(ran).toBe(false);

    queue.resumeQueue(key);
    await task;
    expect(ran).toBe(true);
  });

  it("skips a specific queued item if it was cancelled before execution", async () => {
    vi.mocked(getQueueItem).mockReturnValueOnce({ status: "cancelled" } as any);
    const queue = new SessionQueue();
    let ran = false;

    await queue.enqueue("web:s1", async () => {
      ran = true;
    }, "item-1");

    expect(ran).toBe(false);
    expect(markQueueItemRunning).not.toHaveBeenCalledWith("item-1");
    expect(markQueueItemCompleted).not.toHaveBeenCalledWith("item-1");
  });
});
