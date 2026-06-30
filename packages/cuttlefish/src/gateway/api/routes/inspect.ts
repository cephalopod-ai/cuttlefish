import type { ServerResponse } from "node:http";
import { getRunLedger } from "../../../run-ledger/index.js";
import { getArtifactLineage } from "../../../artifact-lineage/index.js";
import { getPolicyProfile } from "../../../policy/loader.js";
import { POLICY_DIR } from "../../../shared/paths.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { json, notFound } from "../responses.js";

export function handleInspectRoutes(
  method: string,
  pathname: string,
  res: ServerResponse,
  _context: ApiContext,
): boolean {
  if (method !== "GET") return false;

  if (pathname === "/api/inspect/runs") {
    const ledger = getRunLedger();
    const runs = ledger.listRuns({ limit: 200 });
    json(res, { runs, count: runs.length });
    return true;
  }

  const runParams = matchRoute("/api/inspect/runs/:runId", pathname);
  if (runParams) {
    const ledger = getRunLedger();
    const run = ledger.getRun(runParams.runId);
    if (!run) {
      notFound(res);
      return true;
    }
    const events = ledger.listEvents(runParams.runId);
    const errors = ledger.listRunErrors(runParams.runId);
    json(res, { run, events, errors });
    return true;
  }

  const lineageParams = matchRoute("/api/inspect/lineage/:artifactId", pathname);
  if (lineageParams) {
    const lineage = getArtifactLineage();
    const artifact = lineage.getArtifact(lineageParams.artifactId);
    if (!artifact) {
      notFound(res);
      return true;
    }
    const edges = lineage.listLineageEdges(lineageParams.artifactId);
    const xrefs = lineage.listArtifactRunXrefs(lineageParams.artifactId);
    json(res, { artifact, edges, xrefs });
    return true;
  }

  if (pathname === "/api/inspect/dead-letter") {
    const ledger = getRunLedger();
    const deadLettered = ledger.listRuns({ states: ["dead_lettered"], limit: 200 });
    const quarantine = getArtifactLineage().listQuarantineRecords({ unresolvedOnly: true });
    json(res, { deadLettered, quarantine, count: deadLettered.length + quarantine.length });
    return true;
  }

  if (pathname === "/api/inspect/policy") {
    const profile = getPolicyProfile(POLICY_DIR);
    json(res, { ruleCount: profile.rules.length, rules: profile.rules });
    return true;
  }

  return false;
}
