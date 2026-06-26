import type { EngineRateLimitInfo, StreamDelta } from "../shared/types.js";
import type { HookPayload } from "../gateway/hook-registry.js";
import type { SseDataEvent } from "./sse-pty-proxy.js";

/**
 * Map a StopFailure hook payload to an EngineRateLimitInfo.
 * Returns null unless the turn failed specifically with error === "rate_limit".
 * The shape matches what ClaudeEngine produces from `rate_limit_event` JSON, so
 * detectRateLimit() / the wait-retry machinery in manager.ts work unchanged.
 * (error_details may carry a reset time, but its format is unconfirmed — left
 * unparsed; manager.ts computes a default backoff when resetsAt is absent.)
 */
export function rateLimitFromStopFailure(payload: HookPayload | undefined): EngineRateLimitInfo | null {
  if (!payload || payload.hook_event_name !== "StopFailure") return null;
  if (payload.error !== "rate_limit") return null;
  const isUsingOverage = payload.is_using_overage === true ? true : undefined;
  const overageStatus = typeof payload.overage_status === "string" ? payload.overage_status : undefined;
  const overageDisabledReason = typeof payload.overage_disabled_reason === "string" ? payload.overage_disabled_reason : undefined;
  return { status: "rejected", rateLimitType: "interactive_detected", isUsingOverage, overageStatus, overageDisabledReason };
}

export function claudeHookToDeltas(h: Record<string, unknown>): StreamDelta[] {
  if (h.hook_event_name !== "PostToolUse") return [];
  const toolName = typeof h.tool_name === "string" ? h.tool_name : undefined;
  return [{
    type: "tool_result",
    content: String(h.tool_name ?? ""),
    toolName,
  }];
}

/**
 * Translate one parsed Anthropic SSE `data:` event into StreamDeltas. This is the
 * live streaming source (replacing the old transcript tailer): word-by-word text
 * in true order, tool markers positioned correctly relative to text, and live
 * context tokens from message_start.usage.
 *  - message_start.usage         → `context` (input + cache_read + cache_creation)
 *  - content_block_start tool_use → `tool_use` marker (in-order with text)
 *  - content_block_delta text_delta → incremental `text` (word-by-word)
 * tool_result is NOT in the assistant SSE stream (tools run between messages); the
 * PostToolUse hook supplies that completion marker. input_json_delta / thinking
 * deltas are intentionally not surfaced to the chat pane.
 */
export function sseEventToDeltas(e: SseDataEvent): StreamDelta[] {
  switch (e.type) {
    case "message_start": {
      const u = (e as any).message?.usage;
      if (!u) return [];
      const ctx = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      return ctx > 0 ? [{ type: "context", content: String(ctx) }] : [];
    }
    case "content_block_start": {
      const cb = (e as any).content_block;
      if (cb?.type === "tool_use") {
        return [{ type: "tool_use", content: String(cb.name ?? "tool"), toolName: String(cb.name ?? "tool"), toolId: String(cb.id ?? "") }];
      }
      return [];
    }
    case "content_block_delta": {
      const d = (e as any).delta;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
        return [{ type: "text", content: d.text }];
      }
      return [];
    }
    default:
      return [];
  }
}
