# Slack Connector Sessions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Slack thread session continuity, add channel name resolution, and add reaction-triggered sessions.

**Architecture:** Three independent changes to the Slack connector: (1) session keys include message timestamp so threads reuse root sessions, (2) channel IDs resolved to names via Slack API with caching, (3) `reaction_added` event listener creates new sessions from emoji reactions on bot messages.

**Tech Stack:** TypeScript, Node.js native test runner, @slack/bolt, pnpm + Turborepo

**Spec:** `docs/superpowers/specs/2026-03-11-slack-connector-sessions-design.md`

---

## Chunk 1: Per-message session keys

### Task 1: Update `deriveSessionKey` and tests

**Files:**
- Modify: `packages/cuttlefish/src/connectors/slack/threads.ts`
- Modify: `packages/cuttlefish/src/connectors/slack/threads.test.ts`

- [ ] **Step 1: Update tests for new session key behavior**

Replace the existing test file content. The key changes:
- Root channel messages now include `ts` in the key: `slack:C123:1700000000.000100`
- Thread replies still use `thread_ts`: `slack:C123:1700000000.000100` (now matches root)
- `shareSessionInChannel` option is removed
- DMs unchanged

```typescript
// packages/cuttlefish/src/connectors/slack/threads.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";

test("deriveSessionKey keeps DM sessions per user", () => {
  const key = deriveSessionKey({
    channel: "D123",
    user: "U123",
    channel_type: "im",
    ts: "1700000000.000100",
  });
  assert.equal(key, "slack:dm:U123");
});

test("deriveSessionKey uses ts for channel root messages", () => {
  const key = deriveSessionKey({
    channel: "C123",
    user: "U123",
    ts: "1700000000.000100",
  });
  assert.equal(key, "slack:C123:1700000000.000100");
});

test("deriveSessionKey uses thread_ts for thread replies (matches root)", () => {
  const key = deriveSessionKey({
    channel: "C123",
    user: "U123",
    ts: "1700000100.000200",
    thread_ts: "1700000000.000100",
  });
  assert.equal(key, "slack:C123:1700000000.000100");
});

test("deriveSessionKey treats same-ts thread_ts as root message", () => {
  // When thread_ts === ts, this IS the root message
  const key = deriveSessionKey({
    channel: "C123",
    user: "U123",
    ts: "1700000000.000100",
    thread_ts: "1700000000.000100",
  });
  assert.equal(key, "slack:C123:1700000000.000100");
});

test("buildReplyContext sets thread for channel root messages", () => {
  const context = buildReplyContext({
    channel: "C123",
    ts: "1700000000.000100",
    channel_type: "channel",
  });
  assert.deepEqual(context, {
    channel: "C123",
    thread: "1700000000.000100",
    messageTs: "1700000000.000100",
  });
});

test("buildReplyContext sets thread_ts for thread replies", () => {
  const context = buildReplyContext({
    channel: "C123",
    ts: "1700000100.000200",
    thread_ts: "1700000000.000100",
  });
  assert.deepEqual(context, {
    channel: "C123",
    thread: "1700000000.000100",
    messageTs: "1700000100.000200",
  });
});

test("buildReplyContext does NOT set thread for DMs", () => {
  const context = buildReplyContext({
    channel: "D123",
    ts: "1700000000.000100",
    channel_type: "im",
  });
  assert.deepEqual(context, {
    channel: "D123",
    thread: null,
    messageTs: "1700000000.000100",
  });
});

test("isOldSlackMessage compares against boot time", () => {
  assert.equal(isOldSlackMessage("1700000000.000100", 1700000001000), true);
  assert.equal(isOldSlackMessage("1700000002.000100", 1700000001000), false);
});
```

- [ ] **Step 2: Run tests - verify new tests fail**

Run: `cd <repo> && npx tsx --test packages/cuttlefish/src/connectors/slack/threads.test.ts`
Expected: Several test failures (root key format, buildReplyContext for roots)

- [ ] **Step 3: Update `deriveSessionKey` and `buildReplyContext`**

```typescript
// packages/cuttlefish/src/connectors/slack/threads.ts
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

  // Thread reply - use thread_ts (which is the root message's ts)
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return `slack:${event.channel}:${event.thread_ts}`;
  }

  // Root channel message - use ts so thread replies will match
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
```

Note: Removed `SlackThreadOptions` interface and `shareSessionInChannel` parameter entirely.

- [ ] **Step 4: Run tests - verify all pass**

Run: `cd <repo> && npx tsx --test packages/cuttlefish/src/connectors/slack/threads.test.ts`
Expected: All 8 tests pass

- [ ] **Step 5: Update SlackConnector to remove `shareSessionInChannel`**

In `packages/cuttlefish/src/connectors/slack/index.ts`:

1. Remove the `private readonly shareSessionInChannel: boolean;` property
2. Remove `this.shareSessionInChannel = !!config.shareSessionInChannel;` from constructor
3. Change `deriveSessionKey(event as any, { shareSessionInChannel: this.shareSessionInChannel })` to just `deriveSessionKey(event as any)`

- [ ] **Step 6: Remove `shareSessionInChannel` from types**

In `packages/cuttlefish/src/shared/types.ts`, remove `shareSessionInChannel?: boolean;` from `SlackConnectorConfig` (line 223).

- [ ] **Step 7: Run full build and tests**

Run: `cd <repo> && pnpm typecheck && pnpm test`
Expected: No type errors, all tests pass

- [ ] **Step 8: Commit**

```bash
cd <repo>
git add packages/cuttlefish/src/connectors/slack/threads.ts packages/cuttlefish/src/connectors/slack/threads.test.ts packages/cuttlefish/src/connectors/slack/index.ts packages/cuttlefish/src/shared/types.ts
git commit -m "fix: per-message session keys for Slack thread continuity

Each root channel message now gets its own session key (slack:{channel}:{ts})
instead of sharing one per channel. Thread replies match via thread_ts.
Removes shareSessionInChannel option - no longer needed.
Root messages now set thread in replyContext so bot replies create threads."
```

---

## Chunk 2: Channel name resolution

### Task 2: Add channel name cache and resolution

**Files:**
- Modify: `packages/cuttlefish/src/connectors/slack/index.ts`
- Modify: `packages/cuttlefish/src/sessions/context.ts`
- Modify: `packages/cuttlefish/src/sessions/manager.ts`

- [ ] **Step 1: Add `channelNameCache` and `resolveChannelName` to SlackConnector**

In `packages/cuttlefish/src/connectors/slack/index.ts`, add after the `private lastError` property:

```typescript
private channelNameCache = new Map<string, { name: string; cachedAt: number }>();
private botUserId: string | null = null;
private static CHANNEL_CACHE_TTL_MS = 3600_000; // 1 hour
```

Add the `resolveChannelName` method to the class:

```typescript
private async resolveChannelName(channelId: string): Promise<string | undefined> {
  const cached = this.channelNameCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < SlackConnector.CHANNEL_CACHE_TTL_MS) {
    return cached.name;
  }
  try {
    const result = await this.app.client.conversations.info({ channel: channelId });
    const name = result.channel?.name;
    if (name) {
      this.channelNameCache.set(channelId, { name, cachedAt: Date.now() });
      return name;
    }
  } catch (err) {
    logger.debug(`Failed to resolve channel name for ${channelId}: ${err}`);
  }
  return undefined;
}
```

- [ ] **Step 2: Resolve channel name in message handler**

In the `start()` method's `this.app.message(async ({ event }) => { ... })` handler, after the `parentContext` block and before building the `IncomingMessage`, add:

```typescript
const channelName = await this.resolveChannelName((event as any).channel);
```

Then update the `transportMeta` in the `IncomingMessage` construction:

```typescript
transportMeta: {
  channelType: ((event as any).channel_type as string) || "channel",
  team: ((event as any).team as string) || null,
  channelName: channelName || null,
},
```

- [ ] **Step 3: Thread `channelName` through context builder**

In `packages/cuttlefish/src/sessions/context.ts`, update the `buildSessionContext` function's opts type and body:

```typescript
function buildSessionContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  sessionId?: string;
  channelName?: string;
}): string {
  let ctx = `## Current session\n`;
  if (opts.sessionId) ctx += `- Session ID: ${opts.sessionId}\n`;
  ctx += `- Source: ${opts.source}\n`;
  if (opts.channelName) {
    ctx += `- Channel: #${opts.channelName} (${opts.channel})\n`;
  } else if (opts.source === "slack" && opts.channel.startsWith("D")) {
    ctx += `- Channel: Direct Message (${opts.channel})\n`;
  } else {
    ctx += `- Channel: ${opts.channel}\n`;
  }
  if (opts.thread) ctx += `- Thread: ${opts.thread}\n`;
  ctx += `- User: ${opts.user}\n`;
  ctx += `- Working directory: ${CUTTLEFISH_HOME}`;
  return ctx;
}
```

Also update the `buildContext` call to `buildSessionContext` (around line 51) to pass `channelName`:

```typescript
sections.push(buildSessionContext({
  ...opts,
  sessionId: opts.sessionId,
  channelName: opts.channelName,
}));
```

And add `channelName?: string` to the `buildContext` function's opts type (line 13).

- [ ] **Step 4: Pass `channelName` from session manager**

In `packages/cuttlefish/src/sessions/manager.ts`, in the `runSession` method, update the `buildContext` call (around line 157):

```typescript
const systemPrompt = buildContext({
  source: session.source,
  channel: msg.channel,
  thread: msg.thread,
  user: msg.user,
  employee,
  connectors: this.connectorNames,
  config: this.config,
  sessionId: session.id,
  channelName: (msg.transportMeta?.channelName as string) || undefined,
});
```

- [ ] **Step 5: Run full build and tests**

Run: `cd <repo> && pnpm typecheck && pnpm test`
Expected: No type errors, all tests pass

- [ ] **Step 6: Commit**

```bash
cd <repo>
git add packages/cuttlefish/src/connectors/slack/index.ts packages/cuttlefish/src/sessions/context.ts packages/cuttlefish/src/sessions/manager.ts
git commit -m "feat: resolve Slack channel names for agent context

Agents now see '#general (C0ABC123XYZ)' instead of raw channel IDs.
Channel names cached for 1 hour per channel ID.
DMs show 'Direct Message' in context."
```

---

## Chunk 3: Reaction-triggered sessions

### Task 3: Add `reaction_added` event handler

**Files:**
- Modify: `packages/cuttlefish/src/connectors/slack/index.ts`

- [ ] **Step 1: Fetch bot user ID on startup**

In the `start()` method, before `this.app.message(...)`, add:

```typescript
// Fetch bot's own user ID for filtering self-reactions
try {
  const authResult = await this.app.client.auth.test();
  this.botUserId = authResult.user_id ?? null;
  logger.info(`[slack] Bot user ID: ${this.botUserId}`);
} catch (err) {
  logger.warn(`[slack] Failed to get bot user ID: ${err}`);
}
```

- [ ] **Step 2: Add `reaction_added` event handler**

In the `start()` method, after the `this.app.message(...)` handler block and before `await this.app.start()`, add:

```typescript
this.app.event("reaction_added", async ({ event }) => {
  // Only handle reactions on messages (not files, etc.)
  if (event.item.type !== "message") return;

  // Skip bot's own reactions
  if (this.botUserId && event.user === this.botUserId) return;

  if (!this.handler) return;

  // Check allowed users
  if (this.allowedUsers && !this.allowedUsers.has(event.user)) {
    logger.debug(`Ignoring reaction from unauthorized user ${event.user}`);
    return;
  }

  const channelId = event.item.channel;
  const messageTs = event.item.ts;
  const emoji = event.reaction;

  logger.info(`[slack] Reaction :${emoji}: by ${event.user} on ${channelId}:${messageTs}`);

  // Skip old reactions replayed on boot
  if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(messageTs, this.bootTimeMs)) {
    logger.debug(`Ignoring old Slack reaction on ${messageTs}`);
    return;
  }

  // Fetch the reacted-to message text
  // Try conversations.history first (works for root messages),
  // fall back to conversations.replies (for threaded messages)
  let messageText = "";
  try {
    const histResult = await this.app.client.conversations.history({
      channel: channelId,
      latest: messageTs,
      oldest: messageTs,
      inclusive: true,
      limit: 1,
    });
    messageText = histResult.messages?.[0]?.text || "";

    // If not found in history, try as a threaded reply
    if (!messageText) {
      const replyResult = await this.app.client.conversations.replies({
        channel: channelId,
        ts: messageTs,
        limit: 1,
        inclusive: true,
      });
      messageText = replyResult.messages?.[0]?.text || "";
    }
  } catch (err) {
    logger.warn(`[slack] Failed to fetch reacted-to message: ${err}`);
    return;
  }

  if (!messageText) {
    logger.debug(`[slack] Reacted-to message has no text, skipping`);
    return;
  }

  // Resolve channel name
  const channelName = await this.resolveChannelName(channelId);
  const channelDisplay = channelName ? `#${channelName}` : channelId;

  // Build the prompt with reaction context
  const prompt = `[Reaction :${emoji}: on message in ${channelDisplay}]\n\nOriginal message:\n"${messageText}"\n\nThe user reacted with :${emoji}: to this message. Interpret and act on the reaction.`;

  const sessionKey = `slack:reaction:${channelId}:${messageTs}`;

  const msg: IncomingMessage = {
    connector: this.name,
    source: "slack",
    sessionKey,
    replyContext: {
      channel: channelId,
      thread: messageTs,
      messageTs,
    },
    messageId: messageTs,
    channel: channelId,
    thread: messageTs,
    user: event.user,
    userId: event.user,
    text: prompt,
    attachments: [],
    raw: event,
    transportMeta: {
      channelType: "channel",
      team: null,
      channelName: channelName || null,
    },
  };

  this.handler(msg);
});
```

- [ ] **Step 3: Run full build and tests**

Run: `cd <repo> && pnpm typecheck && pnpm test`
Expected: No type errors, all tests pass

- [ ] **Step 4: Commit**

```bash
cd <repo>
git add packages/cuttlefish/src/connectors/slack/index.ts
git commit -m "feat: reaction-triggered sessions in Slack connector

Reacting to a bot message creates a new session with the reacted-to
message as context. Agent interprets the emoji contextually.
Multiple reactions on the same message reuse the same session.
Requires reactions:read scope and reaction_added event subscription."
```

---

## Post-implementation

### Task 4: Final verification

- [ ] **Step 1: Run full build**

Run: `cd <repo> && pnpm build`
Expected: Clean build, no errors

- [ ] **Step 2: Run all tests**

Run: `cd <repo> && pnpm test`
Expected: All tests pass

- [ ] **Step 3: Document Slack app requirements**

Note for the user: the following must be configured in the Slack App dashboard:
1. Add `reactions:read` OAuth scope (Bot Token Scopes)
2. Subscribe to `reaction_added` event (Event Subscriptions)
3. Verify `channels:read` and `groups:read` scopes exist (for channel name resolution)
4. Reinstall the app to workspace after scope changes
