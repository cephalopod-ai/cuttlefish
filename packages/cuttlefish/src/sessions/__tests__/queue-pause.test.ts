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
