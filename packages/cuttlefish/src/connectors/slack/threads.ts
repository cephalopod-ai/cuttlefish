import type { ReplyContext } from "../../shared/types.js";

export interface SlackMessageEventLike {
  channel: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
}

export function deriveSessionKey(event: SlackMessageEventLike): string {
  if (event.channel_type === "im") {
    return `slack:dm:${event.user || "unknown"}`;
  }

  // Thread reply — use thread_ts (which is the root message's ts)
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return `slack:${event.channel}:${event.thread_ts}`;
  }

  // Root channel message — use ts so thread replies will match
  return `slack:${event.channel}:${event.ts}`;
}

export function buildReplyContext(event: SlackMessageEventLike): ReplyContext {
  // For DMs, don't set thread (DMs don't support threading the same way)
  if (event.channel_type === "im") {
    return {
      channel: event.channel,
      thread: null,
      messageTs: event.ts ?? null,
    };
  }

  // For channel messages, always set thread so bot replies in a thread
  // For root messages: thread = ts (starts a thread under the root)
  // For thread replies: thread = thread_ts (continues existing thread)
  const thread = event.thread_ts && event.thread_ts !== event.ts
    ? event.thread_ts
    : event.ts ?? null;

  return {
    channel: event.channel,
    thread,
    messageTs: event.ts ?? null,
  };
}

export function isOldSlackMessage(ts: string | undefined, bootTimeMs: number): boolean {
  if (!ts) return false;
  const secs = Number(ts.split(".")[0]);
  if (!Number.isFinite(secs)) return false;
  return secs * 1000 < bootTimeMs;
}
