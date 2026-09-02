import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import type { ApiContext } from "../context.js";
import { handleA2AOutboundRoutes } from "./a2a-outbound.js";

function request(body: unknown) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: { "content-type": "application/json" },
  }) as never;
}

function response() {
  let status = 0;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(value?: string | Buffer) { if (value) chunks.push(Buffer.from(value)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() { return JSON.parse(Buffer.concat(chunks).toString("utf8")); },
  };
}

const completedTask: Task = {
  id: "remote-task",
  contextId: "remote-context",
  status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "2026-09-02T00:00:00.000Z" },
  artifacts: [],
  history: [],
  metadata: {},
};

describe("outbound A2A operator routes", () => {
  it("routes an allowlisted message through the confined outbound service", async () => {
    const send = vi.fn(async () => completedTask);
    const context = { a2aOutbound: { send } } as unknown as ApiContext;
    const captured = response();
    const handled = await handleA2AOutboundRoutes(
      "POST",
      "/api/a2a/outbound/mada/messages",
      request({ skillId: "review-code", message: "Review this", returnImmediately: true }),
      captured.res,
      context,
    );
    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledWith({
      destinationId: "mada",
      skillId: "review-code",
      message: "Review this",
      taskId: undefined,
      contextId: undefined,
      returnImmediately: true,
      historyLength: undefined,
    });
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ kind: "task", task: { id: "remote-task" } });
  });

  it("rejects incomplete outbound messages before calling the peer", async () => {
    const send = vi.fn();
    const context = { a2aOutbound: { send } } as unknown as ApiContext;
    const captured = response();
    await handleA2AOutboundRoutes(
      "POST",
      "/api/a2a/outbound/mada/messages",
      request({ message: "missing skill" }),
      captured.res,
      context,
    );
    expect(captured.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
