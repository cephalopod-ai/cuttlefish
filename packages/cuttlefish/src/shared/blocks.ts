import type {
  ChatBlock,
  ChatBlockEnvelope,
  ChatBlockStatus,
  ChatBlockType,
  JsonObject,
  JsonValue,
} from "./types.js";

const BLOCK_TYPES = new Set<ChatBlockType>([
  "task-list",
]);
const STATUSES = new Set<ChatBlockStatus>(["queued", "running", "done", "error"]);
const OPS = new Set(["put", "patch", "remove"]);
const FORBIDDEN_KEYS = new Set(["html", "script", "component", "dangerouslySetInnerHTML"]);
const MAX_BLOCK_BYTES = 32_000;

export type BlockValidationResult =
  | { ok: true; envelope: ChatBlockEnvelope }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,96}$/.test(id)) return null;
  return id;
}

function cleanText(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+$/g, "");
  return text.length > max ? text.slice(0, max) : text;
}

function hasUnsafeString(value: string): boolean {
  return /<\s*script\b/i.test(value) || /javascript\s*:/i.test(value);
}

function isSafeJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null) return true;
  if (typeof value === "string") return !hasUnsafeString(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length <= 250 && value.every((item) => isSafeJson(item, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 100) return false;
  for (const [key, child] of entries) {
    if (FORBIDDEN_KEYS.has(key)) return false;
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) return false;
    if (!isSafeJson(child, depth + 1)) return false;
  }
  return true;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isSafeJson(value);
}

function validatePayload(type: ChatBlockType, payload: JsonObject, op: string): string | null {
  if (type === "task-list") {
    const items = payload.items;
    if (items === undefined) {
      if (op === "put") return "task-list payload requires items[]";
    } else {
      if (!Array.isArray(items)) return "task-list payload requires items[]";
      for (const item of items) {
        if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) {
          return "task-list item requires text";
        }
      }
    }
  }
  return null;
}

export function validateBlockEnvelope(input: unknown): BlockValidationResult {
  if (!isRecord(input)) return { ok: false, error: "block envelope must be an object" };
  const op = String(input.op ?? "");
  if (!OPS.has(op)) return { ok: false, error: "block op must be put, patch, or remove" };
  if (!isRecord(input.block)) return { ok: false, error: "block must be an object" };

  const id = cleanId(input.block.id);
  if (!id) return { ok: false, error: "block id is invalid" };
  const type = String(input.block.type ?? "") as ChatBlockType;
  if (!BLOCK_TYPES.has(type)) return { ok: false, error: "block type is invalid" };
  const version = typeof input.block.version === "number" && Number.isFinite(input.block.version)
    ? input.block.version
    : 1;
  const payloadRaw = input.block.payload ?? {};
  if (!isJsonObject(payloadRaw)) return { ok: false, error: "block payload must be safe JSON" };
  const payloadError = validatePayload(type, payloadRaw, op);
  if (payloadError) return { ok: false, error: payloadError };

  const statusRaw = input.block.status;
  const status = typeof statusRaw === "string" && STATUSES.has(statusRaw as ChatBlockStatus)
    ? statusRaw as ChatBlockStatus
    : undefined;

  const block: ChatBlock = {
    id,
    type,
    version,
    payload: payloadRaw,
    ...(status ? { status } : {}),
    ...(cleanText(input.block.sourceEngine, 80) ? { sourceEngine: cleanText(input.block.sourceEngine, 80) } : {}),
    ...(cleanText(input.block.title, 160) ? { title: cleanText(input.block.title, 160) } : {}),
    ...(cleanText(input.block.summary, 400) ? { summary: cleanText(input.block.summary, 400) } : {}),
  };

  if (JSON.stringify({ op, block }).length > MAX_BLOCK_BYTES) {
    return { ok: false, error: "block is too large" };
  }

  return { ok: true, envelope: { op: op as ChatBlockEnvelope["op"], block } };
}

export function mergeBlock(existing: ChatBlock, patch: ChatBlock): ChatBlock {
  return {
    ...existing,
    ...patch,
    id: existing.id,
    type: existing.type,
    version: patch.version ?? existing.version,
    payload: {
      ...existing.payload,
      ...patch.payload,
    },
  };
}

export function blockFallbackText(block: ChatBlock): string {
  const prefix = block.title || block.summary || block.type;
  if (block.type === "task-list") {
    const items = Array.isArray(block.payload.items) ? block.payload.items : [];
    return `${prefix}: ${items.length} item${items.length === 1 ? "" : "s"}`;
  }
  return prefix;
}
