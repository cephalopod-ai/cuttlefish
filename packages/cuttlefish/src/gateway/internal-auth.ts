import { GATEWAY_INFO_FILE } from "../shared/paths.js";
import { readGatewayInfo } from "./gateway-info.js";

export interface ApiAuthHeaderOptions {
  fallbackToGatewayInfo?: boolean;
}

function normalizedToken(token: string | null | undefined): string | undefined {
  const trimmed = typeof token === "string" ? token.trim() : "";
  return trimmed ? trimmed : undefined;
}

export function gatewayInfoApiToken(): string | undefined {
  return normalizedToken(readGatewayInfo(GATEWAY_INFO_FILE)?.token);
}

export function apiAuthHeaders(
  apiToken?: string | null,
  opts: ApiAuthHeaderOptions = {},
): Record<string, string> {
  const token = normalizedToken(apiToken) ??
    (opts.fallbackToGatewayInfo === false ? undefined : gatewayInfoApiToken());
  return token ? { "X-Cuttlefish-Token": token } : {};
}

export function jsonApiHeaders(
  apiToken?: string | null,
  opts?: ApiAuthHeaderOptions,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...apiAuthHeaders(apiToken, opts),
  };
}

export async function fetchFailureMessage(res: Response, action: string): Promise<string> {
  let body = "";
  try {
    body = (await res.text()).trim();
  } catch {
    body = "";
  }
  const statusText = res.statusText ? ` ${res.statusText}` : "";
  const preview = body ? `: ${body.slice(0, 300)}` : "";
  return `${action} failed (${res.status}${statusText})${preview}`;
}

export async function assertFetchOk(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  throw new Error(await fetchFailureMessage(res, action));
}
