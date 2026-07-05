import { createHash } from "node:crypto";
import type {
  ContextDropRecord,
  ContextManagedHistoryMessage,
  ContextSlotUsage,
  ContextSummaryRecord,
} from "./block.js";
import { estimateMessageTokens, estimateTokens } from "./budget.js";

export interface SelectContextMessagesInput {
  systemPrompt: string;
  prompt: string;
  historyMessages: ContextManagedHistoryMessage[];
  availableInputTokens: number;
}

export interface SelectContextMessagesResult {
  messages: ContextManagedHistoryMessage[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  slots: ContextSlotUsage[];
  dropped: ContextDropRecord[];
  summarized: ContextSummaryRecord[];
}

const LONG_LOW_VALUE_CHARS = 4_000;
const TRUNCATED_LOW_VALUE_CHARS = 2_000;
const SUMMARY_EXCERPT_CHARS = 160;
const SUMMARY_MAX_CHARS = 1_200;

export function selectContextMessages(input: SelectContextMessagesInput): SelectContextMessagesResult {
  const dropped: ContextDropRecord[] = [];
  const summarized: ContextSummaryRecord[] = [];
  const baseTokens = estimateTokens(input.systemPrompt) + estimateTokens(input.prompt);
  const nonPartial = input.historyMessages.filter((message) => {
    if (!message.partial) return true;
    dropped.push({ reason: "partial_message", role: message.role, chars: message.content.length });
    return false;
  });
  const estimatedTokensBefore = baseTokens + estimateMessageTokens(nonPartial);
  let required = requiredMessageIndexes(nonPartial, input.prompt);

  let candidates = nonPartial;
  if (estimatedTokensBefore > input.availableInputTokens) {
    candidates = dropDuplicateLowValueMessages(candidates, required, dropped);
    required = requiredMessageIndexes(candidates, input.prompt);
    candidates = truncateLongLowValueMessages(candidates, required, summarized);
  }

  const selectedIndexes = selectNewestWithinBudget(candidates, required, input.availableInputTokens - baseTokens);
  const omitted = candidates.filter((_, index) => !selectedIndexes.has(index));
  for (const message of omitted) {
    dropped.push({ reason: "over_budget", role: message.role, chars: message.content.length });
  }

  const selected = candidates.filter((_, index) => selectedIndexes.has(index));
  if (omitted.length > 0) {
    const summary = buildExtractiveSummary(omitted);
    if (summary) {
      selected.unshift(summary);
      summarized.push({ reason: "older_messages_extract", originalMessages: omitted.length, summaryChars: summary.content.length });
    }
  }

  const estimatedTokensAfter = baseTokens + estimateMessageTokens(selected);
  const slots = slotUsage(input.systemPrompt, selected);
  return { messages: selected, estimatedTokensBefore, estimatedTokensAfter, slots, dropped, summarized };
}

function requiredMessageIndexes(messages: ContextManagedHistoryMessage[], prompt: string): Set<number> {
  const required = new Set<number>();
  const latestUserWithPrompt = lastIndexOf(messages, (message) => message.role === "user" && message.content.trim() === prompt.trim());
  const latestUser = latestUserWithPrompt >= 0 ? latestUserWithPrompt : lastIndexOf(messages, (message) => message.role === "user");
  if (latestUser >= 0) required.add(latestUser);
  const latestAssistant = lastIndexOf(messages, (message) => message.role === "assistant");
  if (latestAssistant >= 0) required.add(latestAssistant);
  return required;
}

function lastIndexOf<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

function dropDuplicateLowValueMessages(
  messages: ContextManagedHistoryMessage[],
  required: Set<number>,
  dropped: ContextDropRecord[],
): ContextManagedHistoryMessage[] {
  const seen = new Set<string>();
  const keep = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isLowValue(message)) {
      keep.add(i);
      continue;
    }
    const sig = signature(message);
    if (seen.has(sig) && !required.has(i)) {
      dropped.push({ reason: "duplicate_low_value", role: message.role, chars: message.content.length });
      continue;
    }
    seen.add(sig);
    keep.add(i);
  }
  return messages.filter((_, index) => keep.has(index));
}

function truncateLongLowValueMessages(
  messages: ContextManagedHistoryMessage[],
  required: Set<number>,
  summarized: ContextSummaryRecord[],
): ContextManagedHistoryMessage[] {
  return messages.map((message, index) => {
    if (required.has(index) || !isLowValue(message) || message.content.length <= LONG_LOW_VALUE_CHARS) return message;
    const content = `${message.content.slice(0, TRUNCATED_LOW_VALUE_CHARS).trimEnd()}\n\n[truncated by context manager]`;
    summarized.push({ reason: "long_tool_output_truncated", originalMessages: 1, summaryChars: content.length });
    return { ...message, content };
  });
}

function selectNewestWithinBudget(messages: ContextManagedHistoryMessage[], required: Set<number>, availableHistoryTokens: number): Set<number> {
  const selected = new Set<number>(required);
  let used = [...selected].reduce((sum, index) => sum + estimateTokens(messages[index]?.content), 0);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (selected.has(i)) continue;
    const tokens = estimateTokens(messages[i].content);
    if (used + tokens <= availableHistoryTokens) {
      selected.add(i);
      used += tokens;
    }
  }
  return selected;
}

function buildExtractiveSummary(omitted: ContextManagedHistoryMessage[]): ContextManagedHistoryMessage | null {
  if (omitted.length === 0) return null;
  const roleCounts = omitted.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  const roleText = Object.entries(roleCounts).map(([role, count]) => `${role}: ${count}`).join(", ");
  const excerpts = omitted.slice(0, 4).map((message) => {
    const oneLine = message.content.replace(/\s+/g, " ").trim().slice(0, SUMMARY_EXCERPT_CHARS);
    return `- ${message.role}: ${oneLine}`;
  });
  const content = [
    "Older conversation omitted by context manager.",
    `Omitted messages: ${omitted.length} (${roleText}).`,
    "Extractive excerpts:",
    ...excerpts,
  ].join("\n").slice(0, SUMMARY_MAX_CHARS);
  return {
    role: "system",
    content,
    timestamp: Math.min(...omitted.map((message) => message.timestamp ?? Date.now())) - 1,
  };
}

function slotUsage(systemPrompt: string, messages: ContextManagedHistoryMessage[]): ContextSlotUsage[] {
  let recentConversation = 0;
  let olderConversationSummary = 0;
  let recentToolResults = 0;
  let summarizedToolResults = 0;
  for (const message of messages) {
    const tokens = estimateTokens(message.content);
    if (message.role === "system" && message.content.startsWith("Older conversation omitted")) {
      olderConversationSummary += tokens;
    } else if (message.content.includes("[truncated by context manager]")) {
      summarizedToolResults += tokens;
    } else if (isLowValue(message)) {
      recentToolResults += tokens;
    } else {
      recentConversation += tokens;
    }
  }
  return [
    { slot: "system_prompt", estimatedTokens: estimateTokens(systemPrompt) },
    { slot: "recent_conversation", estimatedTokens: recentConversation },
    { slot: "older_conversation_summary", estimatedTokens: olderConversationSummary },
    { slot: "recent_tool_results", estimatedTokens: recentToolResults },
    { slot: "summarized_tool_results", estimatedTokens: summarizedToolResults },
    { slot: "retrieved_memory", estimatedTokens: 0 },
  ];
}

function isLowValue(message: ContextManagedHistoryMessage): boolean {
  return message.role === "assistant" || message.role === "notification" || Boolean(message.toolCall);
}

function signature(message: ContextManagedHistoryMessage): string {
  return createHash("sha256").update(message.role).update("\0").update(message.content.trim()).digest("hex");
}
