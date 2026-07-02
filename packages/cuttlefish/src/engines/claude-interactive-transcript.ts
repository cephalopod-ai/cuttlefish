import fs from "node:fs";

interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  assistantTurns: number;
  /** Most recent assistant line's input context (input + cache tokens). */
  lastContextTokens: number | undefined;
}

// $/million tokens. Conservative defaults.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 15, out: 75 };

function sumTranscriptUsage(content: string): TranscriptUsage {
  const u: TranscriptUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, assistantTurns: 0, lastContextTokens: undefined };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Context meter: the most recent usage line's input context (input +
    // cache-read + cache-creation) — recorded BEFORE the dedupe skip below,
    // matching the old lastTurnContextTokens (which did not dedupe).
    const ctx = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
    if (ctx > 0) u.lastContextTokens = ctx;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheTokens += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  }
  return u;
}

/** Last assistant text block from a Claude transcript — the turn's final
 *  message. Used to recover result text when the Stop hook (which normally
 *  carries last_assistant_message) was lost (gateway restart deleting
 *  gateway.json mid-turn, PTY crash, or SSE drop), so the parent-session
 *  callback shows real output instead of "(no output)". Exported for tests. */
function transcriptLineTimestampMs(msg: any): number | undefined {
  const raw = msg?.timestamp ?? msg?.created_at ?? msg?.createdAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function lastAssistantTextFromTranscript(transcriptPath: string, afterMs?: number): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      if (ts === undefined || ts < afterMs) continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
    if (text.trim()) last = text;
  }
  return last;
}

export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/```(?:thinking|reasoning|thought)\b[\s\S]*?```/gi, "")
    .trim();
}

/** Cost + context-meter stats for a settled turn from ONE read of the
 *  transcript. These .jsonl files grow monotonically for the life of a session
 *  (routinely multi-MB); the previous separate cost and context helpers each
 *  re-read and re-split the whole file, doubling the per-turn allocation burst. */
export function computeInteractiveTurnStats(
  transcriptPath: string,
  model?: string,
): { cost: { cost: number; turns: number } | null; contextTokens: number | undefined } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content);
  let cost: { cost: number; turns: number } | null = null;
  if (u.assistantTurns > 0) {
    const price = (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
    cost = {
      cost: (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out,
      turns: u.assistantTurns,
    };
  }
  return { cost, contextTokens: u.lastContextTokens };
}
