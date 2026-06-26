import type { JsonObject } from "./json.js";

export type StreamDeltaType = "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context" | "block";

export type ChatBlockType = "task-list";
export type ChatBlockStatus = "queued" | "running" | "done" | "error";
export type ChatBlockOp = "put" | "patch" | "remove";

export interface ChatBlock {
  id: string;
  type: ChatBlockType;
  version: number;
  status?: ChatBlockStatus;
  sourceEngine?: string;
  title?: string;
  summary?: string;
  payload: JsonObject;
}

export interface ChatBlockEnvelope {
  op: ChatBlockOp;
  block: ChatBlock;
}

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
  input?: string;
  /** Structured chat-view UI update. CLI and connector transports may ignore it. */
  block?: ChatBlockEnvelope;
}
