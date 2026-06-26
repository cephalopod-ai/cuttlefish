import { describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../api/context.js";

vi.mock("../api/session-dispatch.js", () => ({
  dispatchSessionNotification: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { createGatewayNotificationSink } from "../notification-sink.js";
import { dispatchSessionNotification } from "../api/session-dispatch.js";
import { logger } from "../../shared/logger.js";

function context(overrides: Partial<ApiContext> = {}): ApiContext {
  return {
    config: { engines: { claude: {} } } as any,
    sessionManager: {} as any,
    startTime: 0,
    getConfig: () => ({ engines: { claude: {} }, notifications: { connector: "discord", channel: "alerts" } } as any),
    emit: vi.fn(),
    connectors: new Map(),
    ...overrides,
  };
}

describe("createGatewayNotificationSink", () => {
  it("dispatches session notifications in-process", async () => {
    const ctx = context();
    const sink = createGatewayNotificationSink(ctx);

    await sink.sendSessionNotification("parent-1", "message", "display");

    expect(dispatchSessionNotification).toHaveBeenCalledWith("parent-1", "message", "display", ctx);
  });

  it("sends connector notifications through the running connector", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sink = createGatewayNotificationSink(context({
      connectors: new Map([["discord", { sendMessage } as any]]),
    }));

    await sink.sendConnectorNotification("hello");

    expect(sendMessage).toHaveBeenCalledWith({ channel: "alerts" }, "hello");
  });

  it("logs a visible warning when the configured connector is not running", async () => {
    const sink = createGatewayNotificationSink(context());

    await sink.sendConnectorNotification("hello");

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Notification connector"));
  });
});
