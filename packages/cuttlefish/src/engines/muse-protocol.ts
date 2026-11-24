import { v7 as commandId } from "uuid";
import { ENGINE_OUTPUT_MAX } from "../shared/cap-append.js";
import type { EngineRunOpts, EngineTokenUsage } from "../shared/types.js";
import { MuseHost, museCount, museRecord } from "./muse-host.js";

const MAX_ITEMS = 2048;

function tokenUsage(value: unknown): EngineTokenUsage | undefined {
  const report = museRecord(value);
  const result = {
    inputTokens: museCount(report.inputTokens),
    outputTokens: museCount(report.outputTokens),
    cachedTokens: museCount(report.cachedTokens),
    reasoningTokens: museCount(report.reasoningTokens),
  };
  return Object.values(result).some((count) => count !== undefined) ? result : undefined;
}

interface AnswerItem {
  text: string;
  streamed: boolean;
  completed: boolean;
}

interface MuseTerminal {
  durationMs?: number;
  usage?: EngineTokenUsage;
}

const USAGE_KEYS = ["inputTokens", "outputTokens", "cachedTokens", "reasoningTokens"] as const;

export class MuseTurn {
  readonly id = commandId();
  private answers = new Map<string, AnswerItem>();
  private tools = new Set<string>();
  private approvals = new Map<string, Promise<void>>();
  private observedUsage = new Map<string, EngineTokenUsage>();
  private retainedChars = 0;
  private streamedItems = 0;
  private terminal?: MuseTerminal;
  private settle!: (result: MuseTerminal) => void;
  private fail!: (error: Error) => void;
  private readonly completion: Promise<MuseTerminal>;
  contextTokens?: number;

  constructor(private host: MuseHost, private sessionId: string, private opts: EngineRunOpts) {
    this.completion = new Promise((resolve, reject) => { this.settle = resolve; this.fail = reject; });
    void this.completion.catch(() => {}); // host may stop before the admission response
    host.onStop((error) => this.fail(error));
  }

  async run(): Promise<MuseTerminal> {
    // The qualified host can silently ignore session-level developerPrompt on
    // resume. Deliver the current Cuttlefish instructions with each input.
    const text = this.opts.systemPrompt
      ? `Cuttlefish instructions for this turn:\n${this.opts.systemPrompt}\n\n---\n\nTask:\n${this.opts.prompt}`
      : this.opts.prompt;
    const ack = await this.host.request("turn/start", {
      commandId: this.id,
      sessionId: this.sessionId,
      input: [{ type: "text", text }],
      reasoningEffort: this.opts.effortLevel === "default" ? undefined : this.opts.effortLevel,
    });
    if (ack.status !== "accepted" || ack.startedNewTurn !== true || ack.disposition !== "started"
      || ack.turnId !== this.id || ack.commandId !== this.id) {
      throw new Error("Muse did not admit this request as a new turn");
    }
    const terminal = await this.completion;
    await Promise.all(this.approvals.values());
    this.host.assertActive();
    return terminal;
  }

  get text(): string {
    return [...this.answers.values()].filter((item) => item.streamed).map((item) => item.text).join("\n\n");
  }

  receive(method: string, params: Record<string, unknown>): void {
    if (params.sessionId !== this.sessionId) return;
    this.opts.onActivity?.();
    if (method === "turn/completed" && params.turnId === this.id) {
      if (this.terminal) throw new Error("Muse sent duplicate terminal results");
      const usage = tokenUsage(params.usage);
      this.terminal = {
        durationMs: museCount(params.durationMs),
        usage: usage ? { ...usage, source: "terminal" } : this.countObservedUsage(),
      };
      if (params.terminal !== "completed") {
        const kind = museRecord(params.error).kind;
        const detail = typeof kind === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(kind) ? ` (${kind})` : "";
        this.fail(new Error(params.terminal === "cancelled" ? "Muse turn cancelled" : `Muse turn failed${detail}`));
      } else if (![...this.answers.values()].every((item) => !item.streamed || item.completed) || !this.text.trim()) {
        this.fail(new Error("Muse finished without a complete final answer"));
      } else {
        this.settle(this.terminal);
      }
      return;
    }
    if (this.terminal) return;
    if (method === "view/gap" || method === "session/modelRouteUnserved") {
      throw new Error("Muse lost the turn stream or the requested model route");
    }
    if (method === "session/contextUsage") {
      const used = museCount(params.usedTokens);
      if (used !== undefined) {
        this.contextTokens = used;
        this.opts.onStream?.({ type: "context", content: String(used) });
      }
      return;
    }
    if (method === "session/tokenUsage" && params.turnId === this.id) {
      const receipt = museRecord(museRecord(params.sourceRange).last).id;
      if (typeof receipt !== "string" || this.observedUsage.has(receipt)) return;
      if (this.observedUsage.size >= MAX_ITEMS) throw new Error("Muse exceeded the usage event limit");
      this.observedUsage.set(receipt, tokenUsage(params.usage) ?? {});
      return;
    }
    if (method === "approval/requested" || method === "approval/updated") {
      this.respondToApproval(params);
      return;
    }
    if (method === "userInput/requested") throw new Error("Muse requested interactive input which Cuttlefish cannot provide");
    if (method === "item/delta") {
      if (typeof params.itemId !== "string" || params.field !== "text" || typeof params.delta !== "string") return;
      const item = this.answers.get(params.itemId);
      if (item && !item.completed) this.append(item, params.delta);
      return;
    }
    if (method === "item/started" || method === "item/completed") this.applyItem(method, museRecord(params.item));
  }

  private countObservedUsage(): EngineTokenUsage | undefined {
    if (!this.observedUsage.size) return undefined;
    const result: EngineTokenUsage = { source: "observed_model_calls" };
    const rows = [...this.observedUsage.values()];
    for (const key of USAGE_KEYS) {
      const counts = rows.map((row) => row[key]);
      if (counts.every((count) => count !== undefined)) {
        result[key] = museCount(counts.reduce((sum, count) => sum + count, 0));
      }
    }
    return USAGE_KEYS.some((key) => result[key] !== undefined) ? result : undefined;
  }

  private applyItem(method: string, item: Record<string, unknown>): void {
    if (item.turnId !== this.id || typeof item.itemId !== "string") return;
    const id = item.itemId;
    if (item.kind === "toolCall") {
      if (method === "item/started" && !this.tools.has(id)) {
        if (this.tools.size >= MAX_ITEMS) throw new Error("Muse exceeded the tool event limit");
        this.tools.add(id);
        const toolName = typeof item.tool === "string" ? item.tool.slice(0, 100) : "Muse tool";
        this.opts.onStream?.({ type: "tool_use", content: toolName, toolName, toolId: id });
      }
      if (method === "item/completed" && this.tools.delete(id)) {
        this.opts.onStream?.({ type: "tool_result", content: item.status === "completed" ? "completed" : "failed", toolId: id });
      }
      return;
    }
    if (item.kind !== "agentMessage" || item.messagePhase === "commentary") return;
    let answer = this.answers.get(id);
    if (!answer) {
      if (this.answers.size >= MAX_ITEMS) throw new Error("Muse exceeded the answer item limit");
      answer = { text: "", streamed: false, completed: false };
      this.answers.set(id, answer);
    }
    if (method === "item/started") {
      if (item.messagePhase === "finalAnswer") this.stream(answer);
      return;
    }
    if (typeof item.text !== "string" || item.status !== "completed") return;
    if (!item.text.startsWith(answer.text)) throw new Error("Muse final answer conflicts with streamed text");
    this.stream(answer);
    this.append(answer, item.text.slice(answer.text.length));
    answer.completed = true;
  }

  private stream(item: AnswerItem): void {
    if (item.streamed) return;
    item.streamed = true;
    const content = (this.streamedItems++ ? "\n\n" : "") + item.text;
    if (content) this.opts.onStream?.({ type: "text", content });
  }

  private append(item: AnswerItem, text: string): void {
    this.retainedChars += text.length;
    if (this.retainedChars > ENGINE_OUTPUT_MAX) throw new Error("Muse answer exceeded the retained output limit");
    item.text += text;
    if (item.streamed && text) this.opts.onStream?.({ type: "text", content: text });
  }

  respondToApproval(params: Record<string, unknown>): boolean {
    if (this.terminal || params.sessionId !== this.sessionId || params.turnId !== this.id) return false;
    const choices = Array.isArray(params.availableChoices) ? params.availableChoices.map(museRecord) : [];
    const rejected = choices.find((choice) => choice.decision === "denied" && choice.scope === "once");
    const requirement = museRecord(params.currentRequirementId);
    const sourceIndex = museCount(requirement.sourceIndex);
    if (typeof rejected?.choiceId !== "string" || typeof params.approvalId !== "string"
      || requirement.approvalId !== params.approvalId || sourceIndex === undefined) {
      throw new Error("Muse requested approval without a verifiable one-time denial");
    }
    const approvalId = params.approvalId;
    const key = `${approvalId}:${sourceIndex}`;
    if (this.approvals.has(key)) return true;
    if (this.approvals.size >= MAX_ITEMS) throw new Error("Muse exceeded the approval event limit");
    const command = commandId();
    const decision = this.host.request("approval/decide", {
      approvalId,
      choiceId: rejected.choiceId,
      commandId: command,
      requirementId: params.currentRequirementId,
      sessionId: this.sessionId,
    }).then((result) => {
      if (result.approvalId !== approvalId || result.commandId !== command || result.status !== "accepted") {
        throw new Error("Unconfirmed Muse denial");
      }
      this.opts.onStream?.({ type: "status", content: "Cuttlefish denied a Muse native tool approval." });
    }).catch(() => this.host.stop("Muse native approval denial could not be confirmed"));
    this.approvals.set(key, decision);
    return true;
  }
}
