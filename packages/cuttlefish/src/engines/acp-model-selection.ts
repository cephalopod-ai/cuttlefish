import type { HermesRpc } from "./hermes-jsonrpc.js";

/** Model controls advertised by an ACP peer; absence means selection is unsupported. */
export interface AcpModelSelection {
  currentModelId?: string;
  configId?: string;
  legacy?: boolean;
}

/** Prefer current ACP configuration selectors over the legacy models extension. */
export function readAcpModelSelection(value: unknown): AcpModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = value as Record<string, unknown>;
  const options = Array.isArray(result.configOptions) ? result.configOptions : [];
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const entry = option as Record<string, unknown>;
    if ((entry.category !== "model" && entry.id !== "model") || entry.type !== "select" || typeof entry.id !== "string") continue;
    return {
      configId: entry.id,
      ...(typeof entry.currentValue === "string" ? { currentModelId: entry.currentValue } : {}),
    };
  }
  if (result.models && typeof result.models === "object") {
    const models = result.models as Record<string, unknown>;
    return {
      legacy: true,
      ...(typeof models.currentModelId === "string" ? { currentModelId: models.currentModelId } : {}),
    };
  }
  return {};
}

/** Never cache a rejected preference or continue a prompt on an unselected model. */
export async function selectAcpModel(
  rpc: Pick<HermesRpc, "request">,
  sessionId: string,
  selection: AcpModelSelection,
  modelId: string,
): Promise<AcpModelSelection> {
  if (modelId === selection.currentModelId) return selection;
  if (selection.configId) {
    const result = await rpc.request<Record<string, unknown>>("session/set_config_option", {
      sessionId,
      configId: selection.configId,
      value: modelId,
    });
    // Modern peers return the updated configuration. Keep the advertised selector
    // when an older implementation acknowledges with an empty result instead.
    const updated = readAcpModelSelection(result);
    if (updated.currentModelId && updated.currentModelId !== modelId) {
      throw new Error(`ACP peer selected "${updated.currentModelId}" instead of requested "${modelId}"`);
    }
    return { ...selection, ...updated, currentModelId: updated.currentModelId ?? modelId };
  }
  if (selection.legacy) {
    await rpc.request("session/set_model", { sessionId, modelId });
    return { ...selection, currentModelId: modelId };
  }
  throw new Error(`ACP peer does not advertise model selection (requested "${modelId}")`);
}
