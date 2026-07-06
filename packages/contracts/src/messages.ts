import type { ChatBlock } from "./chat.js";

export type MessageRole = "user" | "assistant" | "notification";
export type MediaType = "image" | "audio" | "file";

export interface MediaAttachment {
  type: MediaType;
  url: string;
  name?: string;
  mimeType?: string;
  duration?: number;
  waveform?: number[];
  size?: number;
  /** Server-side file ID after upload. */
  fileId?: string;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  media?: MediaAttachment[];
  partial?: boolean;
  toolCall?: string;
  toolId?: string;
  blocks?: ChatBlock[];
}

export interface ChatMessage extends Omit<SessionMessage, "role"> {
  role: MessageRole;
}
