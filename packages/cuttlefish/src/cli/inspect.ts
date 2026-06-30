import { getRunLedger } from "../run-ledger/index.js";
import { getArtifactLineage } from "../artifact-lineage/index.js";
import { getPolicyProfile } from "../policy/loader.js";
import { POLICY_DIR } from "../shared/paths.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function runInspectRuns(opts: { state?: string; session?: string; limit?: string }): Promise<void> {
  const ledger = getRunLedger();
  const runs = ledger.listRuns({
    states: opts.state ? [opts.state] : undefined,
    sessionId: opts.session,
    limit: opts.limit ? Number(opts.limit) : 50,
  });
  if (runs.length === 0) {
    console.log(`${DIM}No runs found.${RESET}`);
    return;
  }
  console.log(`${GREEN}Runs (${runs.length})${RESET}`);
  for (const run of runs) {
    const stateColor = run.currentState === "completed" ? GREEN
      : run.currentState === "failed" || run.currentState === "dead_lettered" ? RED
      : run.currentState === "interrupted" ? YELLOW
      : DIM;
    console.log(`  ${run.runId}  ${stateColor}${run.currentState}${RESET}  [${run.engine}]  ${run.title ?? "(no title)"}  ${DIM}${run.createdAt}${RESET}`);
  }
}

export async function runInspectRun(runId: string): Promise<void> {
  const ledger = getRunLedger();
  const run = ledger.getRun(runId);
  if (!run) {
    console.log(`${RED}Run not found: ${runId}${RESET}`);
    process.exitCode = 1;
    return;
  }
  const events = ledger.listEvents(runId);
  const errors = ledger.listRunErrors(runId);
  console.log(`${GREEN}Run${RESET} ${runId}`);
  console.log(`  State:      ${run.currentState}`);
  console.log(`  Engine:     ${run.engine}`);
  console.log(`  Session:    ${run.sessionId ?? "(none)"}`);
  console.log(`  Source:     ${run.source} / ${run.sourceRef}`);
  console.log(`  Title:      ${run.title ?? "(none)"}`);
  console.log(`  Created:    ${run.createdAt}`);
  console.log(`  Updated:    ${run.updatedAt}`);
  if (run.lastError) console.log(`  Last error: ${RED}${run.lastError}${RESET}`);
  if (events.length > 0) {
    console.log(`\n${DIM}Events (${events.length}):${RESET}`);
    for (const event of events) {
      console.log(`  ${DIM}${event.createdAt}${RESET}  ${event.eventType}  ${event.fromState ?? "?"} → ${event.toState ?? "?"}`);
    }
  }
  if (errors.length > 0) {
    console.log(`\n${RED}Errors (${errors.length}):${RESET}`);
    for (const error of errors) {
      console.log(`  ${DIM}${error.createdAt}${RESET}  [${error.errorKind}]  ${error.errorMessage}`);
    }
  }
}

export async function runInspectLineage(artifactId: string): Promise<void> {
  const lineage = getArtifactLineage();
  const artifact = lineage.getArtifact(artifactId);
  if (!artifact) {
    console.log(`${RED}Artifact not found: ${artifactId}${RESET}`);
    process.exitCode = 1;
    return;
  }
  const edges = lineage.listLineageEdges(artifactId);
  const xrefs = lineage.listArtifactRunXrefs(artifactId);
  console.log(`${GREEN}Artifact${RESET} ${artifactId}`);
  console.log(`  Kind:     ${artifact.canonicalKind}`);
  console.log(`  Locator:  ${artifact.locator ?? "(none)"}`);
  console.log(`  SHA256:   ${artifact.sha256 ?? "(none)"}`);
  console.log(`  Size:     ${artifact.sizeBytes != null ? `${artifact.sizeBytes} bytes` : "(none)"}`);
  console.log(`  Created:  ${artifact.createdAt}`);
  if (edges.length > 0) {
    console.log(`\n${DIM}Lineage edges (${edges.length}):${RESET}`);
    for (const edge of edges) {
      const dir = edge.fromArtifactId === artifactId ? "→" : "←";
      const other = edge.fromArtifactId === artifactId ? edge.toArtifactId : edge.fromArtifactId;
      console.log(`  ${dir} [${edge.relationType}] ${other}  ${DIM}${edge.createdAt}${RESET}`);
    }
  }
  if (xrefs.length > 0) {
    console.log(`\n${DIM}Run cross-references (${xrefs.length}):${RESET}`);
    for (const xref of xrefs) {
      console.log(`  run:${xref.runId}  ${DIM}(${xref.relation})${RESET}`);
    }
  }
}

export async function runInspectDeadLetter(): Promise<void> {
  const ledger = getRunLedger();
  const deadLettered = ledger.listRuns({ states: ["dead_lettered"], limit: 200 });
  const quarantine = getArtifactLineage().listQuarantineRecords({ unresolvedOnly: true, limit: 200 });

  if (deadLettered.length === 0 && quarantine.length === 0) {
    console.log(`${GREEN}No dead-lettered runs or unresolved quarantine records.${RESET}`);
    return;
  }

  if (deadLettered.length > 0) {
    console.log(`${RED}Dead-lettered runs (${deadLettered.length}):${RESET}`);
    for (const run of deadLettered) {
      console.log(`  ${run.runId}  [${run.engine}]  ${run.title ?? "(no title)"}  ${DIM}${run.updatedAt}${RESET}`);
      if (run.lastError) console.log(`    error: ${run.lastError}`);
    }
  }

  if (quarantine.length > 0) {
    console.log(`${YELLOW}Unresolved quarantine records (${quarantine.length}):${RESET}`);
    for (const record of quarantine) {
      console.log(`  ${record.recordId}  ${record.reason}  ${DIM}${record.createdAt}${RESET}`);
    }
  }
}

export async function runInspectPolicy(): Promise<void> {
  const profile = getPolicyProfile(POLICY_DIR);
  if (profile.rules.length === 0) {
    console.log(`${DIM}No policy rules loaded. Using built-in defaults.${RESET}`);
    console.log(`  Policy dir: ${POLICY_DIR}`);
    return;
  }
  console.log(`${GREEN}Policy rules (${profile.rules.length}):${RESET}`);
  console.log(`  Policy dir: ${POLICY_DIR}`);
  for (const rule of profile.rules) {
    const verdict = rule.allow ? `${GREEN}allow${RESET}` : `${RED}deny${RESET}`;
    const filters = [
      rule.action ? `action=${rule.action}` : null,
      rule.kindPattern ? `kind=${rule.kindPattern}` : null,
      rule.locatorPattern ? `locator=${rule.locatorPattern}` : null,
    ].filter(Boolean).join(", ") || "(all)";
    console.log(`  [${rule.id}]  ${verdict}  ${DIM}${filters}${RESET}`);
  }
}
