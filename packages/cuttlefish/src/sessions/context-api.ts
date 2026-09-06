/**
 * Renders audience-scoped gateway API guidance and its compact fallback.
 * Extracted from sessions/context.ts in a behavior-preserving modularization.
 * The compatibility facade calls buildApiReference and buildApiReferenceSummary;
 * neither private builder is re-exported from the facade.
 */
import type { Employee } from "../shared/types.js";
import { ORG_DIR } from "../shared/paths.js";
import type { OperatorDelegationScope } from "./operator-delegation.js";

/**
 * Audience-scoped Gateway API reference. The FULL endpoint table lives in
 * CLAUDE.md/AGENTS.md (auto-loaded by every engine) — injecting it here too
 * was pure duplication. What remains dynamic is the live base URL and the
 * short list of calls each audience actually makes.
 */
function canUseChildSessionProtocol(employee?: Employee, directReportCount = 0): boolean {
  return !employee || employee.rank === "manager" || employee.rank === "executive" || directReportCount > 0;
}

function buildApiActionGuidance(
  gatewayUrl: string,
  sessionToken?: string,
  operatorDelegationScopes?: OperatorDelegationScope[],
) {
  const authLine = sessionToken
    ? `For session-scoped gateway calls, use \`Authorization: Bearer "$CUTTLEFISH_SESSION_TOKEN"\`. The gateway injects that credential into this engine process; never print, log, or place it in a message.`
    : `Privileged endpoints require local gateway auth; the web UI and built-in delegation tools handle this automatically.`;
  const attachmentsLine =
    `- Push a file/image into this chat (web view): \`curl -X POST ${gatewayUrl}/api/sessions/<your-session-id>/attachments -H 'Content-Type: application/json' -d '{"path":"/abs/path","text":"caption"}'\``;
  const canResolveDelegatedDecision = operatorDelegationScopes?.includes("approve") || operatorDelegationScopes?.includes("decide");
  const orgApprovalLine = sessionToken
    ? canResolveDelegatedDecision
      ? `- This turn carries explicit human-delegated decision authority. You may inspect and resolve approvals/checkpoints with the injected session credential, within the exact task scope. Direct org apply routes remain operator-only; resolve an org-change through its approval record.`
      : `- Propose an org change with \`POST ${gatewayUrl}/api/org/change-requests\` using the injected session credential. Its approval is then shown in this chat and in Approvals. Never call an approve, reject, or apply endpoint: chat text is not operator approval.`
    : `- Org changes require an authenticated proposal and a separate operator approval in the dashboard.`;
  const checkpointLine = sessionToken
    ? `- If you genuinely cannot continue without an operator decision, create a durable checkpoint with \`POST ${gatewayUrl}/api/checkpoints\` using \`{decisionNeeded, why, options?, resumePrompt?}\` and the injected session credential. The gateway binds it to this session, pauses the chat, and surfaces it in Approvals. If the operator already authorized you to decide, decide and continue instead; do not create a checkpoint merely to narrate uncertainty.`
    : `- Unresolved operator decisions should be recorded as durable checkpoints so they appear in this chat and in Approvals.`;
  return { authLine, attachmentsLine, orgApprovalLine, checkpointLine };
}

export function buildApiReferenceSummary(
  gatewayUrl: string,
  portalName: string,
  employee?: Employee,
  directReportCount = 0,
  sessionToken?: string,
  operatorDelegationScopes?: OperatorDelegationScope[],
): string {
  const header = `## ${portalName} Gateway API (${gatewayUrl})`;
  const guidance = buildApiActionGuidance(gatewayUrl, sessionToken, operatorDelegationScopes);
  const { authLine, attachmentsLine, orgApprovalLine } = guidance;
  const checkpointLine = sessionToken ? guidance.checkpointLine : `- If work cannot continue without an operator decision, create a durable checkpoint with \`POST ${gatewayUrl}/api/checkpoints\`; if the operator already delegated that decision, decide and continue instead.`;
  if (!canUseChildSessionProtocol(employee, directReportCount)) {
    return [
      header,
      authLine,
      `Child-session delegation is unavailable because you do not currently supervise any reports in the org graph.`,
      `If that seems wrong, check the employee's \`reportsTo\` / manager wiring.`,
      orgApprovalLine,
      checkpointLine,
      attachmentsLine,
      `Full endpoint reference: CLAUDE.md / AGENTS.md.`,
    ].join("\n");
  }
  if (!employee) {
    return [
      header,
      authLine,
      `- Spawn a child session: \`POST ${gatewayUrl}/api/sessions\` with \`{prompt, employee?, parentSessionId}\``,
      `- Follow up on a child session: \`POST ${gatewayUrl}/api/sessions/:id/message\` with \`{message}\``,
      `- Read a child's latest replies: \`GET ${gatewayUrl}/api/sessions/:id?last=N\``,
      orgApprovalLine,
      checkpointLine,
      attachmentsLine,
      `- Do not delegate or route work to \`hr-manager\`; HR accepts direct top-level human-operator requests only.`,
    ].join("\n");
  }
  return [
    header,
    authLine,
    `- Delegate to another employee: \`POST ${gatewayUrl}/api/sessions\` with \`{prompt, employee, parentSessionId}\``,
    `- Follow up on a child session: \`POST ${gatewayUrl}/api/sessions/:id/message\` with \`{message}\``,
    `- Read a child's latest replies: \`GET ${gatewayUrl}/api/sessions/:id?last=N\``,
    orgApprovalLine,
    checkpointLine,
    attachmentsLine,
    `- Do not delegate or route work to \`hr-manager\`; HR accepts direct top-level human-operator requests only.`,
  ].join("\n");
}

export function buildApiReference(
  gatewayUrl: string,
  portalName: string,
  employee?: Employee,
  directReportCount = 0,
  sessionToken?: string,
  operatorDelegationScopes?: OperatorDelegationScope[],
): string {
  const header = `## ${portalName} Gateway API (base URL: ${gatewayUrl})`;
  const { authLine, attachmentsLine, orgApprovalLine, checkpointLine } = buildApiActionGuidance(gatewayUrl, sessionToken, operatorDelegationScopes);
  if (!employee) {
    return [
      header,
      authLine,
      `- Spawn a child session: \`POST ${gatewayUrl}/api/sessions\` with \`{prompt, employee?, parentSessionId}\``,
      `- Set \`employee\` to an org slug to delegate; omit it to spawn a direct/COO child session.`,
      `- Follow up on a child session: \`POST ${gatewayUrl}/api/sessions/:id/message\` with \`{message}\``,
      `- Read a child's latest replies: \`GET ${gatewayUrl}/api/sessions/:id?last=N\``,
      `- Do not delegate or route work to \`hr-manager\`; HR accepts direct top-level human-operator requests only.`,
      orgApprovalLine,
      checkpointLine,
      `- Valid \`employee\` values are the slugs in \`GET ${gatewayUrl}/api/org\` or \`ls ${ORG_DIR}/\``,
      attachmentsLine,
      `Full endpoint table: CLAUDE.md / AGENTS.md.`,
    ].join("\n");
  }
  // Anyone who supervises reports needs the delegation endpoints. The caller
  // passes a count of ALL reportsTo edges (primary + secondary), so a reviewer's
  // secondary-parent implementer is delegate-capable too — rank alone undercounts
  // (seniors, and even employees, can be a reviewer's reportsTo target).
  if (canUseChildSessionProtocol(employee, directReportCount)) {
    return [
      header,
      authLine,
      `- Delegate to another employee: \`POST ${gatewayUrl}/api/sessions\` with \`{prompt, employee, parentSessionId}\``,
      `- Follow up on a child session: \`POST ${gatewayUrl}/api/sessions/:id/message\` with \`{message}\``,
      `- Read a child's latest replies: \`GET ${gatewayUrl}/api/sessions/:id?last=N\``,
      `- Do not delegate or route work to \`hr-manager\`; HR accepts direct top-level human-operator requests only.`,
      orgApprovalLine,
      checkpointLine,
      `- Valid \`employee\` values are the slugs in your chain of command, \`GET ${gatewayUrl}/api/org\`, or \`ls ${ORG_DIR}/\``,
      attachmentsLine,
      `Full endpoint table: CLAUDE.md / AGENTS.md.`,
    ].join("\n");
  }
  return [
    header,
    authLine,
    `Child-session delegation is unavailable because you do not currently supervise any reports in the org graph.`,
    `If that seems wrong, check the employee's \`reportsTo\` / manager wiring.`,
    orgApprovalLine,
    checkpointLine,
    attachmentsLine,
    `Full endpoint table: CLAUDE.md / AGENTS.md.`,
  ].join("\n");
}
