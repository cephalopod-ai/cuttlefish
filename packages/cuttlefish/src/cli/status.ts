import { getStatus } from "../gateway/lifecycle.js";
import { gatewayBaseUrl, readGatewayInfo } from "../gateway/gateway-info.js";
import { loadConfig } from "../shared/config.js";
import { CUTTLEFISH_HOME, GATEWAY_INFO_FILE, PID_FILE } from "../shared/paths.js";
import fs from "node:fs";

export interface StatusEndpoint {
  url: string;
  port: number;
  token?: string;
}

/**
 * Where `cuttlefish status` asks the live gateway for details. Prefers the
 * runtime record the daemon wrote (gateway.json: actual bound port/host plus
 * the operator token) over config.yaml, so a `start -p` override is honored
 * and the request can pass the auth gate. `/api/status` is operator-only, so
 * an unauthenticated probe is answered 401 and would show nothing.
 */
export function resolveStatusEndpoint(): StatusEndpoint | null {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  let configHost: string | undefined;
  let configPort: number | undefined;
  try {
    const config = loadConfig();
    configHost = config.gateway.host;
    configPort = config.gateway.port;
  } catch {
    // gateway.json alone is enough when config.yaml is temporarily invalid.
  }
  const port = info?.port ?? configPort;
  if (!port) return null;
  const host = info?.host ?? configHost;
  return { url: `${gatewayBaseUrl({ port, host }, configHost)}/api/status`, port, token: info?.token };
}

export interface LiveStatus {
  sessions?: unknown;
  uptime?: number;
}

export async function fetchLiveStatus(
  endpoint: StatusEndpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveStatus | null> {
  const headers: Record<string, string> = endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {};
  const res = await fetchImpl(endpoint.url, { headers, signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  return (await res.json()) as LiveStatus;
}

export async function runStatus(): Promise<void> {
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    console.log("Gateway is not set up. Run \"cuttlefish setup\" first.");
    return;
  }

  const status = getStatus();

  if (status.error) {
    console.log("Gateway: error");
    console.log(`  ${status.error}`);
    return;
  }

  if (!status.running) {
    console.log("Gateway: stopped");
    if (status.pid) {
      console.log(`  Stale PID file found (PID ${status.pid}). Process is not alive.`);
    }
    return;
  }

  console.log("Gateway: running");
  console.log(`  PID: ${status.pid}`);

  // Try to get uptime from PID file mtime
  try {
    const stat = fs.statSync(PID_FILE);
    const uptimeMs = Date.now() - stat.mtimeMs;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    console.log(`  Uptime: ${hours}h ${minutes}m ${seconds}s`);
  } catch {
    // ignore
  }

  // Try to get live stats from the gateway
  const endpoint = resolveStatusEndpoint();
  if (!endpoint) return;
  let data: LiveStatus | null = null;
  try {
    data = await fetchLiveStatus(endpoint);
  } catch {
    data = null;
  }
  if (!data) {
    console.log(`  Port: ${endpoint.port} (not responding to HTTP)`);
    return;
  }
  console.log(`  Port: ${endpoint.port}`);
  if (data.sessions !== undefined) {
    if (typeof data.sessions === "object" && data.sessions && !Array.isArray(data.sessions)) {
      const s = data.sessions as { total?: number; active?: number; running?: number };
      const total = s.total ?? 0;
      const active = s.active ?? 0;
      const running = s.running ?? 0;
      console.log(`  Active sessions: ${active} (running: ${running}, total: ${total})`);
    } else {
      console.log(`  Active sessions: ${data.sessions}`);
    }
  }
  if (data.uptime !== undefined) {
    console.log(`  Server uptime: ${data.uptime}s`);
  }
}
