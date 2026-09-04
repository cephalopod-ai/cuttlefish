import { createHash, timingSafeEqual } from "node:crypto";
import type { A2AClientConfig, A2AConfig, CuttlefishConfig } from "../shared/types.js";

export const A2A_BASE_PATH = "/a2a";
export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const DEFAULT_A2A_MAX_INPUT_BYTES = 64 * 1024;
export const DEFAULT_A2A_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_A2A_POLL_INTERVAL_MS = 250;

export interface ResolvedA2AClient {
  id: string;
  allowedServices: Set<string>;
}

export function normalizeServiceName(value: string): string {
  return value.trim().toLowerCase();
}

export function getA2AConfig(config: CuttlefishConfig): A2AConfig | undefined {
  return config.a2a?.enabled === true ? config.a2a : undefined;
}

export function getA2APublicUrl(config: CuttlefishConfig): string {
  const configured = config.a2a?.publicUrl?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = config.gateway.host === "0.0.0.0" || config.gateway.host === "::"
    ? "127.0.0.1"
    : config.gateway.host;
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketedHost}:${config.gateway.port}${A2A_BASE_PATH}`;
}

export function getA2AMaxInputBytes(config: CuttlefishConfig): number {
  return config.a2a?.maxInputBytes ?? DEFAULT_A2A_MAX_INPUT_BYTES;
}

export function getA2AMaxArtifactBytes(config: CuttlefishConfig): number {
  return config.a2a?.maxArtifactBytes ?? DEFAULT_A2A_MAX_ARTIFACT_BYTES;
}

export function getA2APollIntervalMs(config: CuttlefishConfig): number {
  return config.a2a?.pollIntervalMs ?? DEFAULT_A2A_POLL_INTERVAL_MS;
}

export function configuredServiceNames(config: CuttlefishConfig): Set<string> {
  return new Set((config.a2a?.allowedServices ?? []).map(normalizeServiceName).filter(Boolean));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function clientServices(client: A2AClientConfig, config: CuttlefishConfig): Set<string> {
  const organization = configuredServiceNames(config);
  if (!client.allowedServices) return organization;
  const clientAllowed = new Set(client.allowedServices.map(normalizeServiceName));
  return new Set([...organization].filter((service) => clientAllowed.has(service)));
}

/** Resolve a bearer credential without logging or retaining its cleartext value. */
export function authenticateA2AClient(config: CuttlefishConfig, token: string): ResolvedA2AClient | undefined {
  const candidate = digest(token);
  for (const client of config.a2a?.clients ?? []) {
    if (timingSafeEqual(candidate, digest(client.token))) {
      return { id: client.id, allowedServices: clientServices(client, config) };
    }
  }
  return undefined;
}

export function getConfiguredA2AClient(config: CuttlefishConfig, id: string): ResolvedA2AClient | undefined {
  const client = config.a2a?.clients?.find((entry) => entry.id === id);
  return client ? { id: client.id, allowedServices: clientServices(client, config) } : undefined;
}
