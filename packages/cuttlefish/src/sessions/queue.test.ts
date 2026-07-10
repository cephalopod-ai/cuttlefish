import { expect, test } from "vitest";
import { withTempCuttlefishHome } from "../test-utils/cuttlefish-home.js";
import { SessionQueue } from "./queue.js";

withTempCuttlefishHome();

test("SessionQueue tracks queued work behind the active task", async () => {
  const queue = new SessionQueue();
  let releaseFirst: (() => void) | undefined;

  const first = queue.enqueue("slack:C123", async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });

  while (!queue.isRunning("slack:C123")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const second = queue.enqueue("slack:C123", async () => {});

  expect(queue.getPendingCount("slack:C123")).toBe(1);
  expect(queue.getTransportState("slack:C123", "running")).toBe("running");

  releaseFirst?.();
  await first;
  await second;

  expect(queue.getPendingCount("slack:C123")).toBe(0);
  expect(queue.getTransportState("slack:C123", "idle")).toBe("idle");
});

test("SessionQueue preserves error transport state", () => {
  const queue = new SessionQueue();
  expect(queue.getTransportState("slack:C123", "error")).toBe("error");
});

test("SessionQueue can clear a cancellation before accepting new work", async () => {
  const queue = new SessionQueue();
  let ran = false;

  queue.clearQueue("slack:C123");
  await queue.enqueue("slack:C123", async () => { ran = true; });
  expect(ran).toBe(false);

  queue.clearCancelled("slack:C123");
  await queue.enqueue("slack:C123", async () => { ran = true; });
  expect(ran).toBe(true);
});

test("SessionQueue bounds the paused wait and abandons a task that is never resumed (audit E6)", async () => {
  const queue = new SessionQueue({ pauseMaxWaitMs: 30 });
  queue.pauseQueue("slack:never-resumed");
  let ran = false;
  const task = queue.enqueue("slack:never-resumed", async () => {
    ran = true;
  });
  await expect(task).rejects.toThrow(/paused/i);
  expect(ran).toBe(false);
  // Pending drains so the key is not stuck reporting queued forever.
  expect(queue.getPendingCount("slack:never-resumed")).toBe(0);
});

test("SessionQueue still runs a paused task once it is resumed within the cap (audit E6)", async () => {
  const queue = new SessionQueue({ pauseMaxWaitMs: 10_000 });
  queue.pauseQueue("slack:resumed");
  let ran = false;
  const task = queue.enqueue("slack:resumed", async () => {
    ran = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(ran).toBe(false);
  queue.resumeQueue("slack:resumed");
  await task;
  expect(ran).toBe(true);
});
