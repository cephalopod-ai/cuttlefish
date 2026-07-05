import type { CuttlefishConfig } from "../../shared/types.js";
import { buildContextBudgetPolicy } from "./budget.js";
import type { ContextManagedHistoryMessage, ContextPacket } from "./block.js";
import { contextManagerMode, isContextManagedHistoryEngine } from "./policy.js";
import { selectContextMessages } from "./selector.js";

export interface ContextBuildRequest {
  config: CuttlefishConfig;
  engine: string;
  model?: string;
  systemPrompt: string;
  prompt: string;
  historyMessages: ContextManagedHistoryMessage[];
}

export function buildContextPacket(request: ContextBuildRequest): ContextPacket {
  const mode = contextManagerMode(request.config);
  const budget = buildContextBudgetPolicy(request.config, request.engine, request.model);
  const managedEngine = isContextManagedHistoryEngine(request.engine);
  const selection = selectContextMessages({
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    historyMessages: request.historyMessages,
    availableInputTokens: budget.availableInputTokens,
  });
  const strategy =
    mode === "shadow"
      ? "shadow_observe"
      : managedEngine
        ? "synthetic_history_managed"
        : "native_resume_unmodified";
  const estimatedTokensAfter = mode === "on" && managedEngine
    ? selection.estimatedTokensAfter
    : selection.estimatedTokensBefore;
  return {
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    ...(mode === "on" && managedEngine ? { historyMessages: selection.messages } : {}),
    metadata: {
      mode,
      engine: request.engine,
      ...(request.model ? { model: request.model } : {}),
      strategy,
      estimatedTokensBefore: selection.estimatedTokensBefore,
      estimatedTokensAfter,
      contextLimit: budget.contextLimit,
      reservedResponseTokens: budget.reservedResponseTokens,
      safetyMarginTokens: budget.safetyMarginTokens,
      slots: [
        ...selection.slots,
        { slot: "reserved_response_budget", estimatedTokens: budget.reservedResponseTokens },
      ],
      dropped: selection.dropped,
      summarized: selection.summarized,
      retrievedMemory: { enabled: false, estimatedTokens: 0 },
    },
  };
}
