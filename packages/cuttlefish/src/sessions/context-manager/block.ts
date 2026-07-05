import type { EngineHistoryMessage } from "../../shared/types.js";

export type ContextManagerMode = "off" | "shadow" | "on";

export type ContextSlot =
  | "system_prompt"
  | "recent_conversation"
  | "older_conversation_summary"
  | "recent_tool_results"
  | "summarized_tool_results"
  | "retrieved_memory"
  | "reserved_response_budget";

export type ContextStrategy =
  | "off"
  | "shadow_observe"
  | "synthetic_history_managed"
  | "native_resume_unmodified";

export type ContextDropReason =
  | "partial_message"
  | "duplicate_low_value"
  | "over_budget";

export type ContextSummaryReason =
  | "older_messages_extract"
  | "long_tool_output_truncated";

export type ContextManagedHistoryMessage = EngineHistoryMessage;

export interface ContextSlotUsage {
  slot: ContextSlot;
  estimatedTokens: number;
}

export interface ContextDropRecord {
  reason: ContextDropReason;
  role: string;
  chars: number;
}

export interface ContextSummaryRecord {
  reason: ContextSummaryReason;
  originalMessages: number;
  summaryChars: number;
}

export interface ContextPacketMetadata {
  mode: ContextManagerMode;
  engine: string;
  model?: string;
  strategy: ContextStrategy;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  contextLimit: number;
  reservedResponseTokens: number;
  safetyMarginTokens: number;
  slots: ContextSlotUsage[];
  dropped: ContextDropRecord[];
  summarized: ContextSummaryRecord[];
  retrievedMemory: {
    enabled: false;
    estimatedTokens: 0;
  };
}

export interface ContextPacket {
  systemPrompt: string;
  prompt: string;
  historyMessages?: ContextManagedHistoryMessage[];
  metadata: ContextPacketMetadata;
}
