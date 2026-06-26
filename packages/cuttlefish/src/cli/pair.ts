import fs from "node:fs";
import { gatewayBaseUrl, readGatewayInfo } from "../gateway/gateway-info.js";
import { loadConfig } from "../shared/config.js";
import { GATEWAY_INFO_FILE, CUTTLEFISH_HOME } from "../shared/paths.js";

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
  ttlSeconds?: number;
}

export interface PairedDeviceResponse {
  id: string;
  name: string;
  kind?: string;
  createdAt?: string;
  lastSeenAt?: string;
  lastIp?: string;
  userAgent?: string;
  current?: boolean;
}

export interface UnpairDeviceResponse {
  status: "ok";
  current: boolean;
}

export function gatewayHttpBase(port: number, host?: string): string {
  return gatewayBaseUrl({ port, host });
}

function gatewayConnection(): { port: number; host?: string; token: string } | null {
  if (!fs.existsSync(CUTTLEFISH_HOME)) return null;
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  let configHost: string | undefined;
  let configPort: number | undefined;
  try {
    const config = loadConfig();
    configHost = config.gateway.host;
    configPort = config.gateway.port;
  } catch {
    // gateway.json is enough for local CLI pairing when config.yaml is temporarily invalid.
  }
  const port = info?.port ?? configPort ?? 8888;
  const host = info?.host ?? configHost;
  const token = info?.token;
  return token ? { port, host, token } : null;
}

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    let message = fallback;
    try {
      const body = await res.json() as { error?: unknown; message?: unknown };
      if (body.error) message = String(body.error);
      else if (body.message) message = String(body.message);
    } catch {
      // keep status fallback
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function requestPairingCode(opts: {
  port: number;
  host?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<PairingCodeResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${gatewayHttpBase(opts.port, opts.host)}/api/auth/pairing-codes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  return jsonOrThrow<PairingCodeResponse>(res, `Gateway rejected pairing-code creation (${res.status})`);
}

export async function requestPairedDevices(opts: {
  port: number;
  host?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<PairedDeviceResponse[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${gatewayHttpBase(opts.port, opts.host)}/api/auth/devices`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${opts.token}`,
    },
  });
  const body = await jsonOrThrow<{ devices: PairedDeviceResponse[] }>(
    res,
    `Gateway rejected paired-browser listing (${res.status})`,
  );
  return body.devices;
}

export async function requestUnpairDevice(opts: {
  port: number;
  host?: string;
  token: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
}): Promise<UnpairDeviceResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${gatewayHttpBase(opts.port, opts.host)}/api/auth/devices/${encodeURIComponent(opts.deviceId)}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${opts.token}`,
    },
  });
  return jsonOrThrow<UnpairDeviceResponse>(res, `Gateway rejected paired-browser removal (${res.status})`);
}

export function formatPairingInstructions(pairing: PairingCodeResponse, port: number): string {
  const minutes = pairing.ttlSeconds ? Math.max(1, Math.ceil(pairing.ttlSeconds / 60)) : 5;
  return [
    "Pair a browser with Cuttlefish",
    "",
    `Code: ${pairing.code}`,
    `Expires: ${minutes} minutes, single-use`,
    "",
    "On the other device:",
    "  1. Open Cuttlefish on the other device using your Tailscale/LAN URL.",
    "  2. When Pair This Browser appears, enter the code above.",
    "  3. After pairing, refreshes open the normal app.",
    "",
    "From the web UI, you can also create a code in Settings > Pairing.",
    `Local dashboard: http://127.0.0.1:${port}`,
  ].join("\n");
}

export function formatPairedDevices(devices: PairedDeviceResponse[]): string {
  if (devices.length === 0) {
    return [
      "Paired browsers",
      "",
      "No paired browsers yet.",
      "Create a code with cuttlefish pair, then open Cuttlefish from the other browser and enter it.",
    ].join("\n");
  }
  const lines = ["Paired browsers", ""];
  for (const device of devices) {
    const current = device.current ? " (current)" : "";
    lines.push(`- ${device.name}${current}`);
    lines.push(`  id: ${device.id}`);
    if (device.lastSeenAt) lines.push(`  last seen: ${new Date(device.lastSeenAt).toLocaleString()}`);
    const unpairId = device.id.startsWith("-") ? `-- ${device.id}` : device.id;
    lines.push(`  unpair: cuttlefish unpair ${unpairId}`);
  }
  return lines.join("\n");
}

export async function runPair(opts: { json?: boolean } = {}): Promise<void> {
  const connection = gatewayConnection();
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    console.error("Gateway is not set up. Run \"cuttlefish setup\" first.");
    process.exitCode = 1;
    return;
  }
  if (!connection) {
    console.error("Gateway auth token was not found. Start Cuttlefish first, then run \"cuttlefish pair\".");
    process.exitCode = 1;
    return;
  }

  try {
    const pairing = await requestPairingCode(connection);
    if (opts.json) console.log(JSON.stringify(pairing, null, 2));
    else console.log(formatPairingInstructions(pairing, connection.port));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function runUnpair(deviceId?: string, opts: { json?: boolean } = {}): Promise<void> {
  const connection = gatewayConnection();
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    console.error("Gateway is not set up. Run \"cuttlefish setup\" first.");
    process.exitCode = 1;
    return;
  }
  if (!connection) {
    console.error("Gateway auth token was not found. Start Cuttlefish first, then run \"cuttlefish unpair\".");
    process.exitCode = 1;
    return;
  }

  try {
    if (!deviceId) {
      const devices = await requestPairedDevices(connection);
      if (opts.json) console.log(JSON.stringify({ devices }, null, 2));
      else console.log(formatPairedDevices(devices));
      return;
    }
    const result = await requestUnpairDevice({ ...connection, deviceId });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.current ? "Unpaired this browser." : `Unpaired ${deviceId}.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
