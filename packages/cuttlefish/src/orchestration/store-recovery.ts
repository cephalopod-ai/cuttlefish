import fs from "node:fs";
import path from "node:path";

export interface OrchestrationRecoveryManifest {
  recoveredAt: string;
  originalDbPath: string;
  corruptDbPath: string;
  corruptWalPath?: string;
  corruptShmPath?: string;
  message: string;
  operatorGuidance: string;
}

export interface OrchestrationRecoveryNotice extends OrchestrationRecoveryManifest {
  manifestPath: string;
}

export interface RecoveryNoticePruneOptions {
  now?: Date;
  maxAgeMs?: number;
  maxNotices?: number;
}

export interface RecoveryNoticePruneResult {
  kept: number;
  removed: number;
}

export const DEFAULT_RECOVERY_NOTICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_RECOVERY_NOTICE_LIMIT = 100;

export function writeRecoveryManifest(
  recoveryDir: string,
  manifest: OrchestrationRecoveryManifest,
): string {
  fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  const stamp = manifest.recoveredAt.replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "");
  const filePath = uniqueManifestPath(path.join(recoveryDir, `${stamp}-orchestration-db-recovery.json`));
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export function listRecoveryNotices(recoveryDir: string, limit = 10): OrchestrationRecoveryNotice[] {
  let names: string[];
  try {
    names = fs.readdirSync(recoveryDir).filter((name) => name.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .sort()
    .reverse()
    .slice(0, Math.max(0, Math.floor(limit)))
    .flatMap((name) => {
      const manifestPath = path.join(recoveryDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Partial<OrchestrationRecoveryManifest>;
        if (!isRecoveryManifest(parsed)) return [];
        return [{ ...parsed, manifestPath }];
      } catch {
        return [];
      }
    });
}

export function pruneRecoveryNotices(
  recoveryDir: string,
  opts: RecoveryNoticePruneOptions = {},
): RecoveryNoticePruneResult {
  let names: string[];
  try {
    names = fs.readdirSync(recoveryDir).filter((name) => name.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kept: 0, removed: 0 };
    throw err;
  }
  const notices = names.flatMap((name) => {
    const manifestPath = path.join(recoveryDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Partial<OrchestrationRecoveryManifest>;
      if (!isRecoveryManifest(parsed)) return [];
      return [{ ...parsed, manifestPath }];
    } catch {
      return [];
    }
  }).sort((a, b) => {
    const byTime = Date.parse(b.recoveredAt) - Date.parse(a.recoveredAt);
    return byTime || b.manifestPath.localeCompare(a.manifestPath);
  });
  const nowMs = (opts.now ?? new Date()).getTime();
  const maxAgeMs = saneNonNegative(opts.maxAgeMs, DEFAULT_RECOVERY_NOTICE_RETENTION_MS);
  const maxNotices = Math.max(0, Math.floor(saneNonNegative(opts.maxNotices, DEFAULT_RECOVERY_NOTICE_LIMIT)));
  const cutoffMs = nowMs - maxAgeMs;
  let removed = 0;
  let kept = 0;
  for (const [index, notice] of notices.entries()) {
    const recoveredAtMs = Date.parse(notice.recoveredAt);
    const tooOld = Number.isFinite(recoveredAtMs) && recoveredAtMs < cutoffMs;
    const overLimit = index >= maxNotices;
    if (tooOld || overLimit) {
      removeRecoveryNoticeFiles(recoveryDir, notice);
      removed += 1;
    } else {
      kept += 1;
    }
  }
  return { kept, removed };
}

function uniqueManifestPath(basePath: string): string {
  let candidate = basePath;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = basePath.replace(/\.json$/, `-${index++}.json`);
  }
  return candidate;
}

function isRecoveryManifest(value: Partial<OrchestrationRecoveryManifest>): value is OrchestrationRecoveryManifest {
  return typeof value.recoveredAt === "string"
    && typeof value.originalDbPath === "string"
    && typeof value.corruptDbPath === "string"
    && typeof value.message === "string"
    && typeof value.operatorGuidance === "string";
}

function removeRecoveryNoticeFiles(recoveryDir: string, notice: OrchestrationRecoveryNotice): void {
  const recoveryRoot = path.dirname(path.resolve(recoveryDir));
  for (const candidate of [notice.manifestPath, notice.corruptDbPath, notice.corruptWalPath, notice.corruptShmPath]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (!isSameOrInside(recoveryRoot, resolved)) continue;
    fs.rmSync(resolved, { force: true });
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function saneNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
