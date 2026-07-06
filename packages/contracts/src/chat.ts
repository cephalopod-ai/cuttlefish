import type { JsonObject } from "./json.js";

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
