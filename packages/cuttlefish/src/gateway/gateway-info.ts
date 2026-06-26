import fs from "node:fs";
import crypto from "node:crypto";
import { safeWriteFile } from "../shared/safe-write.js";

export interface GatewayInfo { port: number; host?: string; secret: string; pid: number; token?: string; ptyPids?: number[]; }

export function staleGatewayPids(info: Partial<GatewayInfo> | null | undefined, currentPid = process.pid): number[] {
  if (!info) return [];
  const candidates = [...(Array.isArray(info.ptyPids) ? info.ptyPids : []), info.pid];
  return candidates.filter((pid): pid is number =>
    typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid !== currentPid
  );
}

export function writeGatewayInfo(file: string, opts: { port: number; host?: string; pid: number; secret?: string; token?: string }): GatewayInfo {
  const previous = readGatewayInfo(file);
  const info: GatewayInfo = {
    port: opts.port,
    host: opts.host ?? previous?.host,
    pid: opts.pid,
    secret: opts.secret ?? previous?.secret ?? crypto.randomBytes(24).toString("hex"),
    token: opts.token ?? previous?.token ?? crypto.randomBytes(24).toString("hex"),
    ptyPids: [],
  };
  // Atomic + fsync + 0o600 (ephemeral runtime info; no audit).
  safeWriteFile(file, JSON.stringify(info, null, 2), { mode: 0o600 });
  return info;
}

export function readGatewayInfo(file: string): GatewayInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as GatewayInfo & { apiToken?: string };
    if (!parsed.token && typeof parsed.apiToken === "string") parsed.token = parsed.apiToken;
    delete parsed.apiToken;
    return parsed;
  } catch {
    return null;
  }
}

function isWildcardHost(host: string | undefined): boolean {
  return !host || host === "0.0.0.0" || host === "::";
}

function formatHttpHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function gatewayBaseUrl(info: Pick<GatewayInfo, "port" | "host">, fallbackHost?: string): string {
  const host = isWildcardHost(info.host)
    ? (isWildcardHost(fallbackHost) ? "127.0.0.1" : fallbackHost!)
    : info.host!;
  return `http://${formatHttpHost(host)}:${info.port}`;
}

export function updateGatewayPtyPids(file: string, ptyPids: number[]): void {
  const info = readGatewayInfo(file);
  if (!info) return;
  info.ptyPids = ptyPids;
  safeWriteFile(file, JSON.stringify(info, null, 2), { mode: 0o600 });
}
