import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import { v7 as commandId } from "uuid";
import { ENGINE_LINE_BUF_MAX } from "../shared/cap-append.js";
import type { EngineResult, EngineRunOpts, InterruptibleEngine } from "../shared/types.js";
import { MuseHost, museRecord, type MuseSubscription } from "./muse-host.js";
import { MuseTurn } from "./muse-protocol.js";

const TURN_DEADLINE_MS = 30 * 60_000;
const INACTIVITY_MS = 3 * 60_000;
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActiveMuseRun {
  host?: MuseHost;
  cancellation?: string;
}

function validateRequest(opts: EngineRunOpts): void {
  if (opts.restrictToJudgeOnly) throw new Error("Muse cannot verify Cuttlefish's restricted execution requirements");
  if (opts.attachments?.length) throw new Error("Muse attachments are not supported");
  if (opts.mcpConfigPath || opts.requiresMcp) throw new Error("Muse cannot enforce this session's required MCP configuration");
  if (opts.cliFlags?.length) throw new Error("Muse does not accept employee CLI overrides");
  if (opts.resumeSessionId && !NATIVE_ID.test(opts.resumeSessionId)) throw new Error("Invalid native Muse session identifier");
  if (opts.model?.endsWith("-contributor")) throw new Error("Muse Contributor models are disabled");
  if (Buffer.byteLength(opts.prompt) + Buffer.byteLength(opts.systemPrompt ?? "") > ENGINE_LINE_BUF_MAX / 2) {
    throw new Error("Muse prompt and instructions exceed the input limit");
  }
}

function requireSubscription(subscription: MuseSubscription): void {
  switch (subscription.status) {
    case "api_key": throw new Error("Muse is using API-key authentication. Use a subscribed browser login.");
    case "signed_out": throw new Error("Muse is signed out. Run muse login with a subscribed account.");
    case "no_subscription": throw new Error("Muse browser login has no active subscription.");
    case "unknown": throw new Error("Muse could not verify an active subscription.");
  }
  const now = Date.now();
  if (subscription.observedAtMs && now - subscription.observedAtMs < 5 * 60_000
    && subscription.windows?.some((window) => window.usedPercent >= 100 && window.resetsAtMs > now)) {
    throw new Error("Muse subscription allowance is exhausted.");
  }
}

async function openSession(host: MuseHost, opts: EngineRunOpts, cwd: string): Promise<{ nativeId: string; model: string }> {
  const inherited = await host.request("mcpServer/list", {});
  if (!Array.isArray(inherited.servers) || inherited.servers.length > 0) {
    throw new Error("Muse inherited MCP servers cannot be admitted for this session.");
  }
  const opening = {
    commandId: commandId(),
    workspaceRoot: cwd,
    modelId: opts.model,
    permissionProfile: ":ask-me",
    recoveryMode: "off",
  };
  let result: Record<string, unknown>;
  if (opts.resumeSessionId) {
    try {
      result = await host.request("session/resume", {
        ...opening,
        sessionId: opts.resumeSessionId,
        autoRecover: false,
        excludeItems: true,
      });
    } catch {
      host.assertActive();
      throw new Error("Muse could not resume the exact native session. Start a new Cuttlefish session to begin a fresh conversation.");
    }
  } else {
    result = await host.request("session/start", opening);
  }
  const session = museRecord(result.session);
  const nativeId = session.sessionId;
  if (typeof nativeId !== "string" || !NATIVE_ID.test(nativeId)
    || (opts.resumeSessionId && nativeId !== opts.resumeSessionId)
    || session.workspaceRoot !== cwd || session.status !== "idle" || session.activeTurnId !== null
    || session.runningElsewhere || session.parentSessionId || session.forkedFrom !== null) {
    throw new Error("Muse did not verify the requested idle root session and workspace.");
  }
  if (opts.resumeSessionId && (!Array.isArray(result.pendingRequests) || result.pendingRequests.length > 0)) {
    throw new Error("Muse resumed with unresolved native requests. Review the native session before continuing.");
  }
  if (session.providerId !== "meta" || typeof session.modelId !== "string" || session.modelId.endsWith("-contributor")
    || (opts.model && session.modelId !== opts.model) || result.modelIdRefusal || result.warnings) {
    throw new Error("Muse did not apply the requested Meta model or session configuration.");
  }
  const permission = museRecord(session.permissionState);
  const axes = museRecord(permission.axes);
  if (permission.profileId !== ":ask-me" || permission.reviewerAttached !== true
    || permission.reviewerAuthority !== "human" || axes.filesystem !== "sandboxed"
    || axes.approval !== "onRequest" || axes.network !== "off" || axes.reviewer !== "human"
    || museRecord(session.approvalMode).mode !== "onRequest") {
    throw new Error("Muse did not verify the required sandbox and permission profile.");
  }
  const [servers, hooks, plugins] = await Promise.all([
    host.request("mcpServer/readInventory", { sessionId: nativeId }),
    host.request("hook/list", { sessionId: nativeId }),
    host.request("plugin/list", { sessionId: nativeId }),
  ]);
  if (servers.error || !Array.isArray(servers.servers) || servers.servers.length
    || !Array.isArray(hooks.hooks) || hooks.hooks.length || !Array.isArray(plugins.plugins) || plugins.plugins.length) {
    throw new Error("Muse could not confirm that inherited MCP servers, hooks and plugins were excluded.");
  }
  return { nativeId, model: session.modelId };
}

export class MuseEngine implements InterruptibleEngine {
  readonly name = "muse";
  readonly executionCapabilities = { readOnly: false, automaticReplay: false };
  private readonly active = new Map<string, ActiveMuseRun>();
  private readonly native = new Set<string>();

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const key = opts.sessionId ?? randomUUID();
    const resumed = opts.resumeSessionId;
    if (this.active.has(key) || (resumed && this.native.has(resumed))) {
      return { sessionId: resumed ?? "", result: "", error: "Muse already has a turn in this session." };
    }
    const active: ActiveMuseRun = {};
    this.active.set(key, active);
    if (resumed) this.native.add(resumed);

    let nativeId = resumed ?? "";
    let ownedNativeId = resumed;
    let turn: MuseTurn | undefined;
    let model: string | undefined;
    let completed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let inactivity: ReturnType<typeof setTimeout> | undefined;
    try {
      validateRequest(opts);
      const cwd = await realpath(opts.cwd).catch(() => { throw new Error("Muse workspace is unavailable."); });
      if (active.cancellation) throw new Error(active.cancellation);
      const host = active.host = new MuseHost(os.tmpdir(), opts.bin);
      deadline = setTimeout(() => host.stop("Muse turn deadline exceeded"), TURN_DEADLINE_MS);
      let qualified = false;
      host.onNotification((method, params) => {
        try {
          if (method === "account/changed" && qualified) {
            host.stop("Muse credentials changed during the turn. Verify the subscription and retry explicitly.");
            return;
          }
          turn?.receive(method, params);
        } catch (error) {
          host.stop(error instanceof Error ? error.message : "Invalid Muse turn event");
        }
      });
      host.onServerRequest((method, params) => {
        try {
          if (method === "approval/request" && turn?.respondToApproval(params)) return {};
        } catch {
          host.stop("Muse requested native approval without a verifiable denial.");
          throw new Error("Invalid Muse approval request.");
        }
        host.stop("Muse requested an unsupported or out-of-scope native interaction.");
        throw new Error("Unsupported Muse interaction.");
      });
      await host.initialize(cwd);
      requireSubscription(await host.subscription());
      qualified = true;
      const opened = await openSession(host, opts, cwd);
      model = opened.model;
      if (!resumed && this.native.has(opened.nativeId)) throw new Error("Muse returned a native session already owned by another Cuttlefish turn.");
      this.native.add(opened.nativeId);
      ownedNativeId = nativeId = opened.nativeId;
      opts.onNativeSessionReady?.(nativeId);
      const activity = () => {
        clearTimeout(inactivity);
        inactivity = setTimeout(() => host.stop("Muse turn timed out waiting for activity"), INACTIVITY_MS);
        opts.onActivity?.();
      };
      turn = new MuseTurn(host, nativeId, { ...opts, onActivity: activity });
      activity();
      const terminal = await turn.run();
      completed = true;
      return {
        sessionId: nativeId,
        result: turn.text,
        durationMs: terminal.durationMs,
        tokenUsage: terminal.usage,
        contextTokens: turn.contextTokens,
        transport: "msp",
        model,
        effortLevel: opts.effortLevel,
        numTurns: 1,
      };
    } catch (error) {
      return {
        sessionId: nativeId,
        result: turn?.text ?? "",
        contextTokens: turn?.contextTokens,
        transport: "msp",
        model,
        error: active.cancellation ?? (error instanceof Error ? error.message : "Muse failed."),
      };
    } finally {
      clearTimeout(deadline);
      clearTimeout(inactivity);
      try {
        active.host?.onNotification(() => {});
        await active.host?.close(completed && !active.cancellation);
      } finally {
        if (ownedNativeId) this.native.delete(ownedNativeId);
        this.active.delete(key);
      }
    }
  }

  kill(sessionId: string, reason = "Muse turn interrupted"): void {
    const run = this.active.get(sessionId);
    if (!run || run.cancellation) return;
    run.cancellation = reason;
    run.host?.stop(reason);
  }

  isAlive(sessionId: string): boolean {
    return this.active.get(sessionId)?.host?.alive ?? false;
  }

  killAll(): void {
    for (const id of this.active.keys()) this.kill(id);
  }

  killIdle(): void {
    // Muse owns durable session state. Each gateway turn owns a separate process.
  }
}
