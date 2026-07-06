export type {
  ChatBlock,
  ChatBlockEnvelope,
  ChatBlockOp,
  ChatBlockStatus,
  ChatBlockType,
} from "@cuttlefish/contracts";

export type StreamDeltaType = "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context" | "block";

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
  input?: string;
  /** Structured chat-view UI update. CLI and connector transports may ignore it. */
  block?: import("@cuttlefish/contracts").ChatBlockEnvelope;
}
