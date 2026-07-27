import { get, post } from "./api-core"
import type { Employee } from "./api-org"
import type {
  OrgChangeRequest,
  OrgChangeRiskLevel,
  OrgChangeStatus,
  OrgChangeType,
} from "@cuttlefish/contracts"

// Single source of truth (@cuttlefish/contracts) — see ARC-002. This used to
// hand-mirror the backend's org-change.ts and already drifted once
// (RDC-006, closed 2026-06-30: `change_execution` and the `error` status
// were missing from this copy).
export type { OrgChangeRequest, OrgChangeRiskLevel, OrgChangeStatus, OrgChangeType }

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
