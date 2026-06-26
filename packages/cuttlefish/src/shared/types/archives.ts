import type { Session } from "./sessions.js";

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
}

export interface ArchivedSessionSnapshot {
  id: string;
  engine: string;
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
  parentSessionId: string | null;
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
