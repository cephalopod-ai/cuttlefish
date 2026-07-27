import type { Session } from "./sessions.js";
import type { ChatBlock } from "./chat.js";

export type ArchiveKind = "room" | "scheduled" | "chat";

export interface ArchivedMessageMedia {
  type: "image" | "audio" | "file";
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface ArchivedMessage {
  role: string;
  content: string;
  timestamp: number;
  toolCall?: string;
  media?: ArchivedMessageMedia[];
  /** Structured chat-view blocks (e.g. cards, embeds). Carried through so an
   *  archived message stays byte-for-byte equivalent to the live one before
   *  its source row is deleted — see DFI-006. */
  blocks?: ChatBlock[];
}

export interface ArchivedSessionSnapshot {
  id: string;
  engine: string;
  engineSessionId: string | null;
  connector: string | null;
  sessionKey: string;
  replyContext: Session["replyContext"];
  messageId: string | null;
  transportMeta: Session["transportMeta"];
  employee: string | null;
  model: string | null;
  title: string | null;
  promptExcerpt: string | null;
  source: string;
  sourceRef: string;
  status: Session["status"];
  createdAt: string;
  lastActivity: string;
  totalCost: number;
  totalTurns: number;
  lastContextTokens: number | null;
  lastError: string | null;
  parentSessionId: string | null;
  userId: string | null;
  effortLevel: string | null;
  cwd: string | null;
  messages: ArchivedMessage[];
}

export interface ProjectArchive {
  id: string;
  label: string | null;
  note: string | null;
  kind: ArchiveKind;
  sourceRef: string | null;
  createdAt: string;
  sessionCount: number;
}

export interface ProjectArchiveDetail extends ProjectArchive {
  sessions: ArchivedSessionSnapshot[];
}
