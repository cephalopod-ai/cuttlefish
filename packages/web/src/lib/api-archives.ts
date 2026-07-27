import { del, get, post } from "./api-core"
import type { ChatBlock } from "@cuttlefish/contracts"

export type ArchiveKind = "room" | "scheduled" | "chat"

export interface ArchivedMessageMedia {
  type: "image" | "audio" | "file"
  url: string
  name?: string
  mimeType?: string
  size?: number
}

export interface ArchivedMessage {
  role: string
  content: string
  timestamp: number
  toolCall?: string
  media?: ArchivedMessageMedia[]
  /** Structured chat-view blocks, carried through from the live message — see DFI-006. */
  blocks?: ChatBlock[]
}

export interface ArchivedSessionSnapshot {
  id: string
  engine: string
  employee: string | null
  model: string | null
  title: string | null
  promptExcerpt: string | null
  source: string
  sourceRef: string
  status: string
  createdAt: string
  lastActivity: string
  totalCost: number
  totalTurns: number
  parentSessionId: string | null
  messages: ArchivedMessage[]
}

export interface ProjectArchive {
  id: string
  label: string | null
  note: string | null
  kind: ArchiveKind
  sourceRef: string | null
  createdAt: string
  sessionCount: number
}

export interface ProjectArchiveDetail extends ProjectArchive {
  sessions: ArchivedSessionSnapshot[]
}

export interface CreateArchivePayload {
  kind: ArchiveKind
  sessionIds: string[]
  label?: string
  note?: string
  sourceRef?: string
}

export const archiveApi = {
  listArchives: () => get<ProjectArchive[]>("/api/archives"),
  getArchive: (id: string) => get<ProjectArchiveDetail>(`/api/archives/${id}`),
  createArchive: (data: CreateArchivePayload) => post<ProjectArchive>("/api/archives", data),
  deleteArchive: (id: string) => del<{ status: string }>(`/api/archives/${id}`),
}
