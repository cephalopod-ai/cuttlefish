import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "../shared/paths.js";

export const ORCHESTRATION_TELEMETRY_LOG = path.join(LOGS_DIR, "orchestration-telemetry.jsonl");

export type OrchestrationTelemetryDisposition =
  | "completed"
  | "failed"
  | "blocked"
  | "selected"
  | "discarded";

export interface OrchestrationRunTelemetryRecord {
  task_id: string;
  coordinator_id: string;
  session_id: string | null;
  lease_id: string | null;
  worker_id: string;
  provider: string;
  family: string;
  model: string | null;
  role: string;
  mode: string;
  source: string;
  cost: number | null;
  latency_ms: number | null;
  tokens: number | null;
  files_changed: number | null;
  tests_added: number | null;
  tests_passed: boolean | null;
  review_blockers: number | null;
  human_edits: number | null;
  regressions: number | null;
  disposition: OrchestrationTelemetryDisposition;
  timestamp: string;
}

export interface TelemetryReadResult {
  records: OrchestrationRunTelemetryRecord[];
  skippedLines: number;
}

export interface TelemetryReadOptions {
  maxBytes?: number;
  maxRecords?: number;
}

export interface TelemetryScoreOptions {
  now?: Date;
  halfLifeMs?: number;
  maxAgeMs?: number;
}

export interface TelemetryPruneOptions {
  logPath?: string;
  now?: Date;
  maxAgeMs?: number;
  maxRecords?: number;
}

export interface TelemetryPruneResult {
  kept: number;
  removed: number;
  skippedLines: number;
}

export interface TelemetryBucket {
  count: number;
  dispositions: Record<string, number>;
  totalCost: number;
  avgCost: number | null;
  totalLatencyMs: number;
  avgLatencyMs: number | null;
  totalTokens: number;
  avgTokens: number | null;
  filesChanged: number;
  testsAdded: number;
  testsPassed: number;
  reviewBlockers: number;
  humanEdits: number;
  regressions: number;
  score: number;
}

export interface OrchestrationTelemetrySummary {
  totals: TelemetryBucket;
  byProvider: Record<string, TelemetryBucket>;
  byFamily: Record<string, TelemetryBucket>;
  byRole: Record<string, TelemetryBucket>;
  byWorker: Record<string, TelemetryBucket>;
  skippedLines: number;
}

export interface TelemetryDiffCounts {
  filesChanged: number;
  testsAdded: number;
}

const DISPOSITIONS: OrchestrationTelemetryDisposition[] = ["completed", "failed", "blocked", "selected", "discarded"];
export const DEFAULT_TELEMETRY_SCORE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1_000;
export const DEFAULT_TELEMETRY_SCORE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_TELEMETRY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEFAULT_TELEMETRY_RETENTION_RECORDS = 10_000;

export function appendOrchestrationTelemetry(
  record: OrchestrationRunTelemetryRecord,
  opts: { logPath?: string; fsync?: boolean } = {},
): void {
  const logPath = opts.logPath ?? ORCHESTRATION_TELEMETRY_LOG;
  const sanitized = sanitizeTelemetryRecord(record);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const existed = fs.existsSync(logPath);
  const fd = fs.openSync(logPath, "a", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(sanitized)}\n`);
    if (opts.fsync !== false) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) fs.chmodSync(logPath, 0o600);
}

export function readOrchestrationTelemetry(
  logPath = ORCHESTRATION_TELEMETRY_LOG,
  opts: TelemetryReadOptions = {},
): TelemetryReadResult {
  let raw: string;
  try {
    raw = readTelemetryLog(logPath, opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skippedLines: 0 };
    throw err;
  }
  const records: OrchestrationRunTelemetryRecord[] = [];
  let skippedLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(sanitizeTelemetryRecord(JSON.parse(line)));
    } catch {
      skippedLines += 1;
    }
  }
  if (typeof opts.maxRecords === "number" && Number.isFinite(opts.maxRecords) && opts.maxRecords >= 0 && records.length > opts.maxRecords) {
    records.splice(0, records.length - Math.floor(opts.maxRecords));
  }
  return { records, skippedLines };
}

export function summarizeOrchestrationTelemetry(read: TelemetryReadResult): OrchestrationTelemetrySummary {
  const summary: OrchestrationTelemetrySummary = {
    totals: emptyBucket(),
    byProvider: {},
    byFamily: {},
    byRole: {},
    byWorker: {},
    skippedLines: read.skippedLines,
  };
  for (const record of read.records) {
    addToBucket(summary.totals, record);
    addToGroupedBucket(summary.byProvider, record.provider, record);
    addToGroupedBucket(summary.byFamily, record.family, record);
    addToGroupedBucket(summary.byRole, record.role, record);
    addToGroupedBucket(summary.byWorker, record.worker_id, record);
  }
  finalizeBucket(summary.totals);
  for (const group of [summary.byProvider, summary.byFamily, summary.byRole, summary.byWorker]) {
    for (const bucket of Object.values(group)) finalizeBucket(bucket);
  }
  return summary;
}

export function computeWorkerScores(records: OrchestrationRunTelemetryRecord[], opts?: TelemetryScoreOptions): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const record of records) {
    const score = scoreRecord(record) * scoreWeight(record, opts);
    if (score === 0) continue;
    scores[record.worker_id] = rounded((scores[record.worker_id] ?? 0) + score);
  }
  return scores;
}

export function pruneOrchestrationTelemetry(opts: TelemetryPruneOptions = {}): TelemetryPruneResult {
  const logPath = opts.logPath ?? ORCHESTRATION_TELEMETRY_LOG;
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kept: 0, removed: 0, skippedLines: 0 };
    throw err;
  }

  const nowMs = (opts.now ?? new Date()).getTime();
  const maxAgeMs = saneNonNegative(opts.maxAgeMs, DEFAULT_TELEMETRY_RETENTION_MS);
  const maxRecords = Math.max(0, Math.floor(saneNonNegative(opts.maxRecords, DEFAULT_TELEMETRY_RETENTION_RECORDS)));
  const cutoffMs = nowMs - maxAgeMs;
  const records: OrchestrationRunTelemetryRecord[] = [];
  let skippedLines = 0;
  let parsedLines = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    parsedLines += 1;
    try {
      const record = sanitizeTelemetryRecord(JSON.parse(line));
      const timestampMs = Date.parse(record.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs) continue;
      records.push(record);
    } catch {
      skippedLines += 1;
    }
  }

  if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
  const next = records.map((record) => JSON.stringify(record)).join("\n");
  fs.writeFileSync(logPath, next ? `${next}\n` : "", { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(logPath, 0o600);
  return {
    kept: records.length,
    removed: Math.max(0, parsedLines - skippedLines - records.length),
    skippedLines,
  };
}

export function telemetryCountsFromDiff(diff: string): TelemetryDiffCounts {
  const changed = changedFilesFromDiff(diff);
  return {
    filesChanged: changed.length,
    testsAdded: changed.filter(isTestPath).length,
  };
}

export function sanitizeTelemetryRecord(raw: unknown): OrchestrationRunTelemetryRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("telemetry record must be an object");
  const value = raw as Record<string, unknown>;
  const disposition = stringField(value, "disposition") as OrchestrationTelemetryDisposition;
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`invalid telemetry disposition: ${disposition}`);
  return {
    task_id: stringField(value, "task_id"),
    coordinator_id: stringField(value, "coordinator_id"),
    session_id: nullableString(value, "session_id"),
    lease_id: nullableString(value, "lease_id"),
    worker_id: stringField(value, "worker_id"),
    provider: stringField(value, "provider"),
    family: stringField(value, "family"),
    model: nullableString(value, "model"),
    role: stringField(value, "role"),
    mode: stringField(value, "mode"),
    source: stringField(value, "source"),
    cost: nullableNumber(value, "cost"),
    latency_ms: nullableNumber(value, "latency_ms"),
    tokens: nullableNumber(value, "tokens"),
    files_changed: nullableInteger(value, "files_changed"),
    tests_added: nullableInteger(value, "tests_added"),
    tests_passed: nullableBoolean(value, "tests_passed"),
    review_blockers: nullableInteger(value, "review_blockers"),
    human_edits: nullableInteger(value, "human_edits"),
    regressions: nullableInteger(value, "regressions"),
    disposition,
    timestamp: stringField(value, "timestamp"),
  };
}

function addToGroupedBucket(group: Record<string, TelemetryBucket>, key: string, record: OrchestrationRunTelemetryRecord): void {
  group[key] ??= emptyBucket();
  addToBucket(group[key], record);
}

function addToBucket(bucket: TelemetryBucket, record: OrchestrationRunTelemetryRecord): void {
  bucket.count += 1;
  bucket.dispositions[record.disposition] = (bucket.dispositions[record.disposition] ?? 0) + 1;
  if (record.cost !== null) bucket.totalCost += record.cost;
  if (record.latency_ms !== null) bucket.totalLatencyMs += record.latency_ms;
  if (record.tokens !== null) bucket.totalTokens += record.tokens;
  if (record.files_changed !== null) bucket.filesChanged += record.files_changed;
  if (record.tests_added !== null) bucket.testsAdded += record.tests_added;
  if (record.tests_passed === true) bucket.testsPassed += 1;
  if (record.review_blockers !== null) bucket.reviewBlockers += record.review_blockers;
  if (record.human_edits !== null) bucket.humanEdits += record.human_edits;
  if (record.regressions !== null) bucket.regressions += record.regressions;
  bucket.score += scoreRecord(record);
}

function finalizeBucket(bucket: TelemetryBucket): void {
  bucket.avgCost = bucket.count > 0 ? rounded(bucket.totalCost / bucket.count) : null;
  bucket.avgLatencyMs = bucket.count > 0 ? rounded(bucket.totalLatencyMs / bucket.count) : null;
  bucket.avgTokens = bucket.count > 0 ? rounded(bucket.totalTokens / bucket.count) : null;
}

function emptyBucket(): TelemetryBucket {
  return {
    count: 0,
    dispositions: {},
    totalCost: 0,
    avgCost: null,
    totalLatencyMs: 0,
    avgLatencyMs: null,
    totalTokens: 0,
    avgTokens: null,
    filesChanged: 0,
    testsAdded: 0,
    testsPassed: 0,
    reviewBlockers: 0,
    humanEdits: 0,
    regressions: 0,
    score: 0,
  };
}

function scoreRecord(record: OrchestrationRunTelemetryRecord): number {
  const base = record.disposition === "selected" ? 2
    : record.disposition === "completed" ? 1
      : record.disposition === "discarded" || record.disposition === "blocked" ? -1
        : -2;
  return base - (record.review_blockers ?? 0) - (record.regressions ?? 0) * 2;
}

function scoreWeight(record: OrchestrationRunTelemetryRecord, opts: TelemetryScoreOptions | undefined): number {
  if (!opts) return 1;
  const timestampMs = Date.parse(record.timestamp);
  if (!Number.isFinite(timestampMs)) return 0;
  const nowMs = opts.now?.getTime() ?? Date.now();
  const ageMs = Math.max(0, nowMs - timestampMs);
  const maxAgeMs = sanePositive(opts.maxAgeMs, DEFAULT_TELEMETRY_SCORE_MAX_AGE_MS);
  if (ageMs > maxAgeMs) return 0;
  const halfLifeMs = sanePositive(opts.halfLifeMs, DEFAULT_TELEMETRY_SCORE_HALF_LIFE_MS);
  return Math.pow(0.5, ageMs / halfLifeMs);
}

function sanePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function saneNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  let inUntracked = false;
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
    if (line === "Untracked files:") {
      inUntracked = true;
      continue;
    }
    if (inUntracked && line.startsWith("  ") && line.trim()) files.add(line.trim());
  }
  return [...files].sort();
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?)\//i.test(filePath) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function readTelemetryLog(logPath: string, opts: TelemetryReadOptions): string {
  const maxBytes = typeof opts.maxBytes === "number" && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
    ? Math.floor(opts.maxBytes)
    : undefined;
  if (!maxBytes) return fs.readFileSync(logPath, "utf-8");
  const stat = fs.statSync(logPath);
  if (stat.size <= maxBytes) return fs.readFileSync(logPath, "utf-8");
  const start = stat.size - maxBytes;
  const fd = fs.openSync(logPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, start);
    const raw = buffer.subarray(0, bytesRead).toString("utf-8");
    return raw.replace(/^[^\n]*(?:\r?\n|$)/, "");
  } finally {
    fs.closeSync(fd);
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw new Error(`telemetry ${key} must be a non-empty string`);
  return field;
}

function nullableString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (field === null || field === undefined) return null;
  if (typeof field !== "string") throw new Error(`telemetry ${key} must be a string or null`);
  return field;
}

function nullableNumber(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  if (field === null || field === undefined) return null;
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`telemetry ${key} must be a finite number or null`);
  return field;
}

function nullableInteger(value: Record<string, unknown>, key: string): number | null {
  const field = nullableNumber(value, key);
  if (field !== null && !Number.isInteger(field)) throw new Error(`telemetry ${key} must be an integer or null`);
  return field;
}

function nullableBoolean(value: Record<string, unknown>, key: string): boolean | null {
  const field = value[key];
  if (field === null || field === undefined) return null;
  if (typeof field !== "boolean") throw new Error(`telemetry ${key} must be a boolean or null`);
  return field;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}
