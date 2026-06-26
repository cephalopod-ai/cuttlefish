import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks (must be declared before importing the module under test) ──────────

// engineAvailable is the guard under test — fully controllable per case.
const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>();
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  isKnownEngine: vi.fn((name: string) => ["claude", "codex", "antigravity", "grok", "pi", "kiro"].includes(name)),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
}));

// Registry side effects — no real DB.
const getSessionMock = vi.fn();
const updateSessionMock = vi.fn();
vi.mock("../registry.js", () => ({
  getSession: (...a: unknown[]) => getSessionMock(...a),
  getMessages: vi.fn(() => []),
  updateSession: (...a: unknown[]) => updateSessionMock(...a),
  patchSessionTransportMeta: vi.fn(),
}));

vi.mock("../../shared/usage-status.js", () => ({
  recordEngineRateLimit: vi.fn(),
}));

vi.mock("../../shared/effort.js", () => ({
  resolveEffort: vi.fn(() => "medium"),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// rateLimit math: zero delay; deadline already in the past so the wait-and-retry
// loop (Branch B) exits immediately without sleeping or calling engine.run.
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() - 1),
  detectRateLimit: vi.fn(() => ({ limited: false })),
}));

import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs } from "../../shared/rateLimit.js";
import type { Session, EngineResult } from "../../shared/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: "claude-thread-1",
    source: "web",
    sourceRef: "web:test",
    connector: null,
    sessionKey: "k",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: "opus",
    title: null,
    parentSessionId: null,
    status: "running",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    ...overrides,
  } as Session;
}

function makeOpts(fallbackRun: ReturnType<typeof vi.fn>, overrides: Partial<Session> = {}): RateLimitHandlerOpts {
  const session = makeSession(overrides);
  const fallbackEngine = { run: fallbackRun } as unknown as RateLimitHandlerOpts["engine"];
  const claudeEngine = { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"];
  return {
    session,
    prompt: "hello",
    engineConfig: { bin: "codex", model: "gpt-5.3-codex" },
    config: {
      sessions: { rateLimitStrategy: "fallback", fallbackEngine: "grok" },
      engines: { grok: { bin: "grok", model: "grok-build" } },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map([["grok", fallbackEngine]]),
    engine: claudeEngine,
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "codex-thread-1" } as EngineResult,
    hooks: {},
  };
}

describe("handleRateLimit — fallback guard (#40)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getSession is consulted inside both branches; return the live session.
    getSessionMock.mockImplementation(() => makeSession());
    updateSessionMock.mockImplementation((_id, patch) => ({ ...makeSession(), ...(patch as object) }));
  });

  it("falls through to wait-and-retry when the fallback engine is NOT installed", async () => {
    engineAvailableMock.mockReturnValue(false);
    const fallbackRun = vi.fn(async () => ({ result: "from-grok", sessionId: "grok-1" }) as EngineResult);

    const outcome = await handleRateLimit(makeOpts(fallbackRun, { engine: "codex", engineSessionId: "codex-thread-1" }));

    // Branch A skipped → no fallback spawn.
    expect(fallbackRun).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe("fallback");
    // With a past deadline, Branch B exits straight to timeout.
    expect(outcome.kind).toBe("timeout");
  });

  it("uses the configured fallback when the fallback engine IS installed", async () => {
    engineAvailableMock.mockReturnValue(true);
    const fallbackRun = vi.fn(async () => ({ result: "from-grok", sessionId: "grok-1" }) as EngineResult);

    const outcome = await handleRateLimit(makeOpts(fallbackRun, { engine: "codex", engineSessionId: "codex-thread-1" }));

    expect(fallbackRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind === "fallback") {
      expect(outcome.result.result).toBe("from-grok");
    }
  });

  it("uses the configured fallback even when the rate-limited source engine is not Claude", async () => {
    engineAvailableMock.mockReturnValue(true);
    const fallbackRun = vi.fn(async () => ({ result: "from-grok", sessionId: "grok-2" }) as EngineResult);

    const outcome = await handleRateLimit(
      makeOpts(fallbackRun, { engine: "antigravity", engineSessionId: "agy-thread-1", model: "Gemini 3.5 Flash (Medium)" }),
    );

    expect(fallbackRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
  });

  it("uses the fallback engine's configured model instead of the source engine model", async () => {
    engineAvailableMock.mockReturnValue(true);
    const fallbackRun = vi.fn(async () => ({ result: "from-grok", sessionId: "grok-3" }) as EngineResult);

    const outcome = await handleRateLimit(
      makeOpts(fallbackRun, { engine: "antigravity", engineSessionId: "agy-thread-2", model: "Gemini 3.5 Flash (Medium)" }),
    );

    expect(fallbackRun).toHaveBeenCalledWith(expect.objectContaining({
      model: "grok-build",
      bin: "grok",
      resumeSessionId: undefined,
    }));
    expect(updateSessionMock).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      engine: "grok",
      lastError: expect.stringContaining("Grok"),
    }));
    expect(outcome.kind).toBe("fallback");
  });
});

describe("handleRateLimit — wait cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a long wait when the session leaves waiting status", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 10_000, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);

    let status: Session["status"] = "waiting";
    getSessionMock.mockImplementation(() => makeSession({ status }));
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const opts = {
      ...makeOpts(vi.fn()),
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      hooks: {
        onWaitingStart: () => {
          setTimeout(() => { status = "idle"; }, 1000);
        },
      },
    } satisfies RateLimitHandlerOpts;

    const outcomePromise = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("cancelled");
    expect(retryEngine.run).not.toHaveBeenCalled();
  });
});

describe("handleRateLimit — wait cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a long wait when the session leaves waiting status", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 10_000, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);

    let status: Session["status"] = "waiting";
    getSessionMock.mockImplementation(() => makeSession({ status }));
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const opts = {
      ...makeOpts(vi.fn()),
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      hooks: {
        onWaitingStart: () => {
          setTimeout(() => { status = "idle"; }, 1000);
        },
      },
    } satisfies RateLimitHandlerOpts;

    const outcomePromise = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("cancelled");
    expect(retryEngine.run).not.toHaveBeenCalled();
  });
});
