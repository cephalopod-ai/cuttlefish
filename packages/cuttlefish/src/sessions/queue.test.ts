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
