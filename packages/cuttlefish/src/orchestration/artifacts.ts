import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMessages } from "../sessions/registry.js";
import { getArtifactLineage } from "../artifact-lineage/index.js";
import { appendOrchestrationAudit } from "./audit.js";
import {
  dualLaneTaskDir,
  readDualLaneManifest,
  updateDualLaneManifest,
  type DualLaneManifestLane,
} from "./dual-lane-state.js";
import type { OrchestrationStore, ArtifactKind, ArtifactRecord } from "./store.js";
import {
  applyPatchToGitWorkspace,
  isGitWorkspaceDirty,
  patchWorktree,
} from "./worktree.js";
import { safePathSegment } from "./path-segments.js";

const MAX_ARTIFACT_BYTES = 2_000_000;
const applyLocks = new Set<string>();

export interface ArtifactContent {
  record: ArtifactRecord;
  content: string;
}

export type DualLaneApplyResult =
  | { ok: false; reason: "not_found" | "invalid_state" | "invalid_lane" | "dirty_base" | "missing_worktree" | "empty_patch" | "conflict" | "apply_in_progress"; message: string }
  | { ok: true; taskId: string; selectedLane: "openai" | "anthropic"; baseCwd: string; patchPath: string; attemptId: string };

export function writeDualLanePromptArtifact(
  taskId: string,
  coordinatorId: string,
  prompt: string,
  store?: OrchestrationStore,
  opts: { now?: () => Date } = {},
): ArtifactRecord {
  return writeArtifact({ taskId, coordinatorId, kind: "prompt", lane: null, content: prompt, store, now: opts.now });
}

export function writeDualLaneOutputArtifact(
  taskId: string,
  coordinatorId: string,
  lane: "openai" | "anthropic",
  content: string,
  store?: OrchestrationStore,
  opts: { now?: () => Date } = {},
): ArtifactRecord {
  return writeArtifact({ taskId, coordinatorId, kind: "output", lane, content, store, now: opts.now });
}

export function writeDualLaneDiffArtifact(
  taskId: string,
  coordinatorId: string,
  lane: "openai" | "anthropic",
  content: string,
  store?: OrchestrationStore,
  opts: { now?: () => Date } = {},
): ArtifactRecord {
  return writeArtifact({ taskId, coordinatorId, kind: "diff", lane, content, store, now: opts.now });
}

export function listArtifactContents(
  store: OrchestrationStore | undefined,
  taskId: string,
  kind: ArtifactKind,
  coordinatorId: string,
): ArtifactContent[] {
  const records = store?.listArtifactRecords(taskId, kind, coordinatorId) ?? discoverDualLaneArtifacts(taskId, kind, coordinatorId);
  return records.map((record) => ({ record, content: readArtifactFile(record.path) }));
}

export function applyDualLaneWinner(opts: {
  taskId: string;
  coordinatorId: string;
  winnerLane: string;
  store?: OrchestrationStore;
}): DualLaneApplyResult {
  const selectedLane = parseLane(opts.winnerLane);
  if (!selectedLane) return { ok: false, reason: "invalid_lane", message: `invalid dual-lane winner: ${opts.winnerLane}` };
  const manifest = readDualLaneManifest(opts.taskId, opts.coordinatorId);
  if (!manifest) return { ok: false, reason: "not_found", message: `no dual-lane run found for task ${opts.taskId}` };
  if (manifest.state !== "selection_required" && manifest.state !== "selected") {
    return {
      ok: false,
      reason: "invalid_state",
      message: `dual-lane run ${opts.taskId} is ${manifest.state}; apply requires selection_required or selected`,
    };
  }
  if (manifest.state === "selected" && manifest.selectedLane && manifest.selectedLane !== selectedLane) {
    return {
      ok: false,
      reason: "invalid_lane",
      message: `dual-lane run ${opts.taskId} selected ${manifest.selectedLane}; refused requested ${selectedLane}`,
    };
  }
  const winner = manifest.lanes.find((lane) => lane.id === selectedLane);
  if (!winner) return { ok: false, reason: "invalid_lane", message: `dual-lane run ${opts.taskId} has no ${selectedLane} lane` };
  if (!fs.existsSync(winner.worktree.path)) {
    return { ok: false, reason: "missing_worktree", message: `winner worktree is missing: ${winner.worktree.path}` };
  }
  const lockKey = path.resolve(manifest.baseCwd);
  if (applyLocks.has(lockKey)) return { ok: false, reason: "apply_in_progress", message: `another dual-lane apply is already in progress for ${manifest.baseCwd}` };
  applyLocks.add(lockKey);
  try {
    if (isGitWorkspaceDirty(manifest.baseCwd)) {
      recordPatchAttempt(opts.store, opts.taskId, selectedLane, "failed", manifest.baseCwd, null, "base working tree is dirty");
      return { ok: false, reason: "dirty_base", message: "base working tree is dirty; apply refused" };
    }
    const patch = patchWorktree(winner.worktree);
    if (!patch.trim()) {
      recordPatchAttempt(opts.store, opts.taskId, selectedLane, "failed", manifest.baseCwd, null, "winner patch is empty");
      return { ok: false, reason: "empty_patch", message: "winner patch is empty" };
    }
    const patchRecord = writeArtifact({
      taskId: opts.taskId,
      coordinatorId: manifest.coordinatorId,
      kind: "patch_apply",
      lane: selectedLane,
      content: patch,
      store: opts.store,
      note: "dual-lane apply patch",
    });
    try {
      applyPatchToGitWorkspace(manifest.baseCwd, patch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordPatchAttempt(opts.store, opts.taskId, selectedLane, "failed", manifest.baseCwd, patchRecord.path, message);
      return { ok: false, reason: "conflict", message: `winner patch conflicts or cannot apply: ${message}` };
    }
    const attempt = recordPatchAttempt(opts.store, opts.taskId, selectedLane, "applied", manifest.baseCwd, patchRecord.path, null);
    if (manifest.state === "selection_required") {
      updateDualLaneManifest({
        ...manifest,
        state: "selected",
        selectedLane,
        archivedLane: manifest.lanes.find((lane) => lane.id !== selectedLane)?.id,
      });
    }
    return {
      ok: true,
      taskId: opts.taskId,
      selectedLane,
      baseCwd: manifest.baseCwd,
      patchPath: patchRecord.path,
      attemptId: attempt,
    };
  } finally {
    applyLocks.delete(lockKey);
  }
}

export function persistDualLaneArtifacts(opts: {
  taskId: string;
  coordinatorId: string;
  prompt: string;
  lanes: DualLaneManifestLane[];
  store?: OrchestrationStore;
  now?: () => Date;
}): void {
  writeDualLanePromptArtifact(opts.taskId, opts.coordinatorId, opts.prompt, opts.store, { now: opts.now });
  for (const lane of opts.lanes) {
    writeDualLaneOutputArtifact(opts.taskId, opts.coordinatorId, lane.id, rawOutputForSession(lane.session.sessionId), opts.store, { now: opts.now });
    writeDualLaneDiffArtifact(opts.taskId, opts.coordinatorId, lane.id, patchWorktree(lane.worktree), opts.store, { now: opts.now });
  }
}

function rawOutputForSession(sessionId: string): string {
  const assistantMessages = getMessages(sessionId)
    .filter((message) => message.role === "assistant")
    .map((message) => message.content);
  if (assistantMessages.length === 0) return "[raw model output unavailable in session transcript]";
  return assistantMessages.join("\n\n");
}

function writeArtifact(opts: {
  taskId: string;
  coordinatorId: string;
  kind: ArtifactKind;
  lane: string | null;
  content: string;
  store?: OrchestrationStore;
  note?: string;
  now?: () => Date;
}): ArtifactRecord {
  const dir = path.join(dualLaneTaskDir(opts.taskId, opts.coordinatorId), "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${opts.kind}${opts.lane ? `-${safePathSegment(opts.lane, "artifact lane path segment")}` : ""}.txt`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, opts.content);
  const stat = fs.statSync(file);
  const createdAt = (opts.now?.() ?? new Date()).toISOString();
  const record: ArtifactRecord = {
    artifactId: `${opts.taskId}:${opts.coordinatorId}:${opts.kind}:${opts.lane ?? "base"}`,
    taskId: opts.taskId,
    coordinatorId: opts.coordinatorId,
    kind: opts.kind,
    lane: opts.lane,
    path: file,
    bytes: stat.size,
    createdAt,
    note: opts.note ?? null,
  };
  opts.store?.addArtifactRecord(record);
  try {
    getArtifactLineage().registerArtifact({
      artifactId: record.artifactId,
      canonicalKind: `orchestration:${record.kind}`,
      locator: record.path,
      sizeBytes: record.bytes,
      createdAt: record.createdAt,
    });
  } catch {
    // lineage recording is non-fatal
  }
  appendOrchestrationAudit("orchestration.artifact.record", record, file);
  return record;
}

function discoverDualLaneArtifacts(taskId: string, kind: ArtifactKind, coordinatorId: string): ArtifactRecord[] {
  const manifests = [readDualLaneManifest(taskId, coordinatorId)].filter((manifest): manifest is NonNullable<typeof manifest> => Boolean(manifest));
  const dir = manifests[0]
    ? path.join(dualLaneTaskDir(taskId, manifests[0].coordinatorId), "artifacts")
    : path.join(dualLaneTaskDir(taskId, coordinatorId), "artifacts");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name === `${kind}.txt` || entry.name.startsWith(`${kind}-`))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      const laneMatch = entry.name.match(new RegExp(`^${kind}-(.+)\\.txt$`));
      return {
        artifactId: `${taskId}:${coordinatorId}:${kind}:${laneMatch?.[1] ?? "base"}`,
        taskId,
        coordinatorId,
        kind,
        lane: laneMatch?.[1] ?? null,
        path: file,
        bytes: stat.size,
        createdAt: new Date(stat.mtimeMs).toISOString(),
        note: null,
      };
    });
}

function readArtifactFile(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`artifact is not a file: ${file}`);
  if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${file}`);
  return fs.readFileSync(file, "utf-8");
}

function recordPatchAttempt(
  store: OrchestrationStore | undefined,
  taskId: string,
  winnerLane: string,
  state: "applied" | "failed",
  baseCwd: string,
  patchPath: string | null,
  error: string | null,
): string {
  const attemptId = `apply_${randomUUID()}`;
  store?.addPatchApplyAttempt({
    attemptId,
    taskId,
    winnerLane,
    state,
    baseCwd,
    patchPath,
    error,
    createdAt: new Date().toISOString(),
  });
  appendOrchestrationAudit("orchestration.dual_lane.apply_attempt", {
    attemptId,
    taskId,
    winnerLane,
    state,
    baseCwd,
    patchPath,
    error,
  }, patchPath ?? baseCwd);
  return attemptId;
}

function parseLane(value: string): "openai" | "anthropic" | null {
  return value === "openai" || value === "anthropic" ? value : null;
}
