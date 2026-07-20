/**
 * Org change-request model — the unit of work the HR / Org Steward flow operates
 * on. A proposed mutation to the org (hire, instruction edit, model/engine/budget
 * change, promote/demote, reassign, retire/disable) is captured as an
 * OrgChangeRequest BEFORE it touches any employee YAML, so HR can critique it and
 * a human can approve it. The rich body lives as a JSON file under
 * `~/.cuttlefish/org/_changes/<id>.json`; the human-approval gate reuses the
 * existing generic Approval store (`type: "org-change"`).
 */

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
  | "retire_agent";

export type OrgChangeStatus =
  | "draft" // proposed, not yet submitted for critique
  | "pending_critique" // submitted; HR critique turn in flight
  | "pending_approval" // critique attached; awaiting human sign-off
  | "approved" // human approved; apply in progress / queued
  | "rejected" // human rejected; never applied
  | "error" // critique or apply pipeline failed and needs operator attention
  | "applied" // written to org/ and hot-reloaded
  | "rolled_back"; // a previously-applied change was reverted

export type OrgChangeRiskLevel = "low" | "medium" | "high";

export const ORG_CHANGE_TYPES: readonly OrgChangeType[] = [
  "create_agent",
  "modify_instructions",
  "change_model",
  "change_engine",
  "change_budget",
  "change_execution",
  "promote",
  "demote",
  "reassign_manager",
  "change_department",
  "disable_agent",
  "retire_agent",
];

export interface OrgChangeRequest {
  id: string;
  changeType: OrgChangeType;
  status: OrgChangeStatus;
  /** Target employee name (the immutable kebab-case identity key). */
  employeeName: string;
  /** Who proposed the change ("user", "coo", "hr-manager", "system", …). */
  proposedBy: string;
  /**
   * Session that submitted this request, if it came from a scoped chat token.
   * The approval card is attached to this session so the operator can decide
   * in the same chat as well as from the global Approvals page.
   */
  originSessionId?: string | null;
  /**
   * The proposed fields to apply. For `create_agent` this is an EmployeeCreate
   * body (name, displayName, department, rank, engine, model, persona, …); for
   * every other change type it is an EmployeeUpdate body (the writable subset).
   */
  proposed: Record<string, unknown>;
  /** Why this change is being made. */
  rationale: string;
  /** Opaque references backing the rationale (session ids, ticket ids, urls). */
  evidenceRefs: string[];
  /** Rendered current YAML (null for create_agent — nothing exists yet). */
  beforeYaml?: string | null;
  /** Rendered proposed YAML after applying `proposed`. */
  afterYaml?: string | null;
  riskLevel: OrgChangeRiskLevel;
  requiresHumanApproval: boolean;
  /** HR's critique text, attached once the auto-critique turn completes. */
  hrCritique?: string | null;
  /** The gating Approval id, when a human-approval gate was created. */
  approvalId?: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string | null;
}
