import { get, post } from "./api-core"

export type ApprovalDecision = "approved" | "rejected" | "deferred" | "revised"
export type ApprovalState = "pending" | ApprovalDecision
export type ApprovalType = "fallback" | "tool" | "custom" | "checkpoint" | "org-change"

export interface CheckpointPayload extends Record<string, unknown> {
  decisionNeeded: string
  why: string
  affectedFiles?: string[]
  affectedArtifacts?: string[]
  affectedActions?: string[]
  options?: ApprovalDecision[]
  resumePrompt?: string | null
  revisePrompt?: string | null
}

export type ApprovalResolvedByKind = "human" | "autonomous_dual_model"

export interface Approval {
  id: string
  sessionId: string
  type: ApprovalType
  payload: Record<string, unknown>
  state: ApprovalState
  createdAt: string
  resolvedAt?: string | null
  actor?: string | null
  decisionNotes?: string | null
  resultingAction?: string | null
  /** Code-owned discriminator — see resolveApprovalAsAutonomous on the
   *  gateway. Absent/null means a human (or unattributed) resolution. */
  resolvedByKind?: ApprovalResolvedByKind | null
}

export interface Checkpoint extends Omit<Approval, "type" | "payload"> {
  type: "checkpoint"
  payload: CheckpointPayload
}

export interface CheckpointDecisionInput {
  decision: ApprovalDecision
  notes?: string | null
  resultingAction?: string | null
  resumePrompt?: string | null
}

export const approvalApi = {
  getApprovals: (state: ApprovalState | "all" = "pending", sessionId?: string | null) =>
    get<Approval[]>(`/api/approvals?state=${state}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  approveApproval: (id: string) =>
    post<{ approval: Approval; session?: Record<string, unknown> }>(`/api/approvals/${id}/approve`, {}),
  rejectApproval: (id: string) =>
    post<{ approval: Approval }>(`/api/approvals/${id}/reject`, {}),
  getCheckpoints: (state: ApprovalState | "all" = "pending", sessionId?: string | null) =>
    get<Checkpoint[]>(`/api/checkpoints?state=${state}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  decideCheckpoint: (id: string, body: CheckpointDecisionInput) =>
    post<{ checkpoint: Checkpoint; session?: Record<string, unknown> }>(`/api/checkpoints/${id}/decision`, body),
}
