import { appendAudit, sha256Hex } from "../shared/audit-log.js";
import { logger } from "../shared/logger.js";
import { ORCH_DB } from "../shared/paths.js";

export function appendOrchestrationAudit(op: string, payload: object, file = ORCH_DB): void {
  try {
    appendAudit({
      actor: "orchestration",
      file,
      op,
      checksum: sha256Hex(JSON.stringify(payload)),
    });
  } catch (err) {
    logger.warn(`orchestration audit append failed for ${op}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
