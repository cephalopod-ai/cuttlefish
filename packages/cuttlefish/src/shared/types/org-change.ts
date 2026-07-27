/**
 * Org change-request model — re-exported from @cuttlefish/contracts, the
 * single source of truth shared with the web dashboard (see ARC-002). Kept
 * as a thin re-export (not a straight `import` at call sites) so existing
 * `from "../shared/types.js"` imports across the gateway keep working
 * unchanged.
 */
export type {
  OrgChangeRequest,
  OrgChangeRiskLevel,
  OrgChangeStatus,
  OrgChangeType,
} from "@cuttlefish/contracts";
export { ORG_CHANGE_TYPES } from "@cuttlefish/contracts";
