import type { CuttlefishConfig } from "../../shared/types.js";
import { contextWindowForModel } from "../../shared/models.js";

export interface ContextBudgetPolicy {
  contextLimit: number;
  reservedResponseTokens: number;
  safetyMarginTokens: number;
  memoryReserveTokens: 0;
  availableInputTokens: number;
}

const FALLBACK_CONTEXT_LIMIT = 128_000;

export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

export function buildContextBudgetPolicy(config: CuttlefishConfig, engine: string, model?: string): ContextBudgetPolicy {
  const contextLimit = contextWindowForModel(config, engine, model) ?? FALLBACK_CONTEXT_LIMIT;
  const reservedResponseTokens = Math.min(8_000, Math.max(1_024, Math.floor(contextLimit * 0.08)));
  const safetyMarginTokens = Math.min(8_000, Math.max(1_024, Math.floor(contextLimit * 0.05)));
  const memoryReserveTokens = 0;
  const availableInputTokens = Math.max(1_024, contextLimit - reservedResponseTokens - safetyMarginTokens - memoryReserveTokens);
  return {
    contextLimit,
    reservedResponseTokens,
    safetyMarginTokens,
    memoryReserveTokens,
    availableInputTokens,
  };
}
