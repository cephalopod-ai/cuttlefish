import { get, post } from "./api-core"
import type { Employee } from "./api-org"

// Mirror of the backend source of truth in
// packages/cuttlefish/src/shared/types/org-change.ts (OrgChangeType /
// OrgChangeStatus). Keep these in sync — `change_execution` and the `error`
// status had drifted out of this copy, so the web under-handled real backend
// change types/states.
export type OrgChangeType =
  | "create_agent"
  | "modify_instructions"
  | "change_model"
  | "change_engine"
  | "change_budget"
  | "change_execution"
  | "promote"
  | "demote"
  | "reassign_manager"
  | "change_department"
  | "disable_agent"
  | "retire_agent"

export type OrgChangeStatus =
  | "draft"
  | "pending_critique"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "error"
  | "applied"
  | "rolled_back"

export type OrgChangeRiskLevel = "low" | "medium" | "high"

export interface OrgChangeRequest {
  id: string
  changeType: OrgChangeType
  status: OrgChangeStatus
  employeeName: string
  proposedBy: string
  proposed: Record<string, unknown>
  rationale: string
  evidenceRefs: string[]
  beforeYaml?: string | null
  afterYaml?: string | null
  riskLevel: OrgChangeRiskLevel
  requiresHumanApproval: boolean
  hrCritique?: string | null
  approvalId?: string | null
  createdAt: string
  updatedAt: string
  appliedAt?: string | null
}

export interface CreateChangeRequestInput {
  changeType: OrgChangeType
  employeeName: string
  proposed: Record<string, unknown>
  rationale?: string
  evidenceRefs?: string[]
  proposedBy?: string
}

export interface ValidateChangeInput {
  changeType: OrgChangeType
  employeeName: string
  proposed: Record<string, unknown>
}

export interface ChangeMutationResult {
  status: string
  error?: string
  changeRequest: OrgChangeRequest | null
}

export const hrApi = {
  listChangeRequests: (status?: string) =>
    get<{ changeRequests: OrgChangeRequest[] }>(
      `/api/org/change-requests${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  getChangeRequest: (id: string) => get<OrgChangeRequest>(`/api/org/change-requests/${id}`),
  createChangeRequest: (data: CreateChangeRequestInput) =>
    post<{ status: string; changeRequest: OrgChangeRequest }>("/api/org/change-requests", data),
  validateChange: (data: ValidateChangeInput) =>
    post<{ ok: boolean; error: string | null }>("/api/org/validate", data),
  approveChange: (id: string) => post<ChangeMutationResult>(`/api/org/change-requests/${id}/approve`, {}),
  rejectChange: (id: string) => post<ChangeMutationResult>(`/api/org/change-requests/${id}/reject`, {}),
  listRetired: () => get<{ employees: Employee[] }>("/api/org/retired"),
}
