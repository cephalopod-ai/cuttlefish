import { z } from "zod";

export const CANONICAL_RUN_STATES = [
  "created",
  "running",
  "blocked",
  "failed",
  "interrupted",
  "dead_lettered",
  "completed",
] as const;

/**
 * States a run can never leave. A `completed` or `dead_lettered` run is final —
 * transitioning it back to an active state corrupts run history and event
 * ordering (audit finding STT-RL-001). `failed` and `interrupted` are terminal
 * for reporting but remain re-enterable by the recovery/retry paths, so they are
 * deliberately NOT in this set.
 */
export const TERMINAL_RUN_STATES = ["completed", "dead_lettered"] as const;

export const RUN_EVENT_TYPES = [
  "run_created",
  "state_transition",
  "metadata_updated",
  "error_recorded",
  "artifact_linked",
  "policy_snapshot_linked",
  "run_linked",
] as const;

export const RETRY_REPLAY_LINK_TYPES = ["retry", "replay"] as const;
export const PARENT_CHILD_LINK_TYPES = ["spawned"] as const;

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const canonicalRunStateSchema = z.enum(CANONICAL_RUN_STATES);
export const runEventTypeSchema = z.enum(RUN_EVENT_TYPES);
export const retryReplayLinkTypeSchema = z.enum(RETRY_REPLAY_LINK_TYPES);
export const parentChildLinkTypeSchema = z.enum(PARENT_CHILD_LINK_TYPES);

export const runRecordSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  source: z.string().min(1),
  sourceRef: z.string().min(1),
  engine: z.string().min(1),
  title: z.string().nullable(),
  promptExcerpt: z.string().nullable(),
  currentState: canonicalRunStateSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSessionStatus: z.string().nullable(),
}).strict();

export const runEventRecordSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  eventType: runEventTypeSchema,
  fromState: canonicalRunStateSchema.nullable(),
  toState: canonicalRunStateSchema.nullable(),
  payload: jsonObjectSchema.nullable(),
  createdAt: z.string().min(1),
}).strict();

export const runErrorRecordSchema = z.object({
  errorId: z.string().min(1),
  runId: z.string().min(1),
  eventId: z.string().min(1).nullable(),
  errorKind: z.string().min(1),
  errorMessage: z.string().min(1),
  details: jsonObjectSchema.nullable(),
  createdAt: z.string().min(1),
}).strict();

export const runArtifactReferenceSchema = z.object({
  referenceId: z.string().min(1),
  runId: z.string().min(1),
  artifactId: z.string().nullable(),
  relation: z.string().min(1),
  locator: z.string().nullable(),
  createdAt: z.string().min(1),
}).strict();

export const policySnapshotReferenceSchema = z.object({
  referenceId: z.string().min(1),
  runId: z.string().min(1),
  policyScope: z.string().min(1),
  snapshotId: z.string().min(1),
  createdAt: z.string().min(1),
}).strict();

export const retryReplayLinkRecordSchema = z.object({
  linkId: z.string().min(1),
  runId: z.string().min(1),
  relatedRunId: z.string().min(1),
  relationType: retryReplayLinkTypeSchema,
  createdAt: z.string().min(1),
}).strict();

export const parentChildLinkRecordSchema = z.object({
  parentRunId: z.string().min(1),
  childRunId: z.string().min(1),
  relationType: parentChildLinkTypeSchema,
  createdAt: z.string().min(1),
}).strict();

export type CanonicalRunState = z.infer<typeof canonicalRunStateSchema>;
export type RunEventType = z.infer<typeof runEventTypeSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunEventRecord = z.infer<typeof runEventRecordSchema>;
export type RunErrorRecord = z.infer<typeof runErrorRecordSchema>;
export type RunArtifactReference = z.infer<typeof runArtifactReferenceSchema>;
export type PolicySnapshotReference = z.infer<typeof policySnapshotReferenceSchema>;
export type RetryReplayLinkRecord = z.infer<typeof retryReplayLinkRecordSchema>;
export type ParentChildLinkRecord = z.infer<typeof parentChildLinkRecordSchema>;
