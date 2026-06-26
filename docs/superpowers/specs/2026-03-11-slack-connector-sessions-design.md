# Slack Connector - Session Continuity, Channel Names & Reaction Sessions

## Summary

Three changes to the Slack connector:

1. **Per-message session keys** - each root message in a channel gets its own session, and thread replies continue that session
2. **Channel name resolution** - resolve Slack channel IDs to human-readable names so the agent knows where it was invoked
3. **Reaction-triggered sessions** - reacting to a bot message creates a new session with that message as context

## Change 1: Per-message session keys

### Problem

Root messages use key `slack:{channelId}`, but thread replies use `slack:{channelId}:{thread_ts}`. These never match, so every thread reply creates a new session instead of continuing the root message's session.

### Solution

Always include the message timestamp in the session key for non-DM messages:

```
DM           → slack:dm:{userId}              (unchanged)
Channel root → slack:{channelId}:{ts}          (was: slack:{channelId})
Thread reply → slack:{channelId}:{thread_ts}   (unchanged - now matches root)
```

This makes `shareSessionInChannel` obsolete - remove it.

### Files changed

- `packages/cuttlefish/src/connectors/slack/threads.ts`
  - `deriveSessionKey()`: For non-DM, non-thread messages, return `slack:${channel}:${ts}` instead of `slack:${channel}`
  - Remove `SlackThreadOptions` interface and `shareSessionInChannel` logic
  - `buildReplyContext()`: For channel root messages (not DMs), set `thread: ts` so the bot's reply starts a thread under the root message. Currently `thread` is only set for thread replies - change to always set it for channel messages so the first response threads correctly. DMs must NOT set `thread` (DMs don't support threading the same way).

- `packages/cuttlefish/src/connectors/slack/index.ts`
  - Remove `shareSessionInChannel` property and constructor logic
  - Remove `shareSessionInChannel` from `deriveSessionKey()` call

- `packages/cuttlefish/src/shared/types.ts`
  - Remove `shareSessionInChannel` from `SlackConnectorConfig` if present

- `packages/cuttlefish/src/connectors/slack/threads.test.ts`
  - Update tests to reflect new key format

### Behavior

1. User posts "help with X" in #general → session key `slack:C456:1710234567.001200`
2. Bot replies in a thread under that message
3. User replies in thread → thread_ts = `1710234567.001200` → key = `slack:C456:1710234567.001200` → same session
4. User posts a different root message in #general → new ts → new session
5. DMs unchanged - still one session per user

## Change 2: Channel name resolution

### Problem

The agent sees `Channel: C0ABC123XYZ` in its context - a raw Slack ID with no human meaning.

### Solution

Call `conversations.info` to resolve channel names. Cache results per channel ID to avoid repeated API calls.

### Files changed

- `packages/cuttlefish/src/connectors/slack/index.ts`
  - Add `private channelNameCache: Map<string, string>`
  - Add `private async resolveChannelName(channelId: string): Promise<string>` method
  - In the message handler, resolve channel name before building `IncomingMessage`
  - Add `channelName` to `transportMeta`

- `packages/cuttlefish/src/sessions/context.ts`
  - Add `channelName?: string` to the `buildContext` opts interface
  - Thread it through to `buildSessionContext()`
  - Display as `#general (C0ABC123XYZ)` when available, raw ID as fallback

- `packages/cuttlefish/src/sessions/manager.ts`
  - Pass `channelName` from `msg.transportMeta.channelName` into `buildContext()` opts

### Channel name format in context

```
## Current session
- Session ID: abc123
- Source: slack
- Channel: #general (C0ABC123XYZ)
- User: U12345
```

For DMs, show `Direct Message` instead of a channel name.

## Change 3: Reaction-triggered sessions

### Problem

The connector only sends reactions (eyes, checkmark). It doesn't listen for user reactions. There's no way to trigger an action by reacting to a message.

### Solution

Listen for `reaction_added` events. When a user reacts to a bot message, create a new session with the reacted-to message as context.

### Files changed

- `packages/cuttlefish/src/connectors/slack/index.ts`
  - Add `this.app.event('reaction_added', ...)` handler in `start()`
  - Filter: only process reactions from allowed users, skip bot self-reactions (use `auth.test` at startup to get bot user ID, compare against `event.user`)
  - Fetch the reacted-to message text: use `conversations.history` with `latest: item.ts`, `oldest: item.ts`, `inclusive: true`, `limit: 1` for root messages; use `conversations.replies` with `ts: thread_ts` for threaded messages
  - Route through `this.handler(msg)` - same callback as regular messages
  - Resolve channel name
  - Build `IncomingMessage` with prompt: `[Reaction :emoji: on message in #channel]\n\nOriginal message:\n"...message text..."\n\nThe user reacted with :emoji: to this message. Interpret and act on the reaction.`
  - Session key: `slack:reaction:{channelId}:{messageTs}` - unique per reacted message, multiple reactions on same message reuse session
  - Reply context: thread under the reacted-to message

### Reaction semantics

The agent receives the emoji name and the message text. It interprets the reaction contextually:
- A thumbs up might mean "approve this"
- A question mark might mean "explain this"
- A red flag might mean "something's wrong here"

The agent decides based on context - no hardcoded emoji-to-action mapping.

### Session key format

`slack:reaction:{channelId}:{messageTs}` - each reacted message gets its own session. If someone reacts multiple times to the same message, subsequent reactions go to the same session as follow-up messages.

## What's NOT changing

- DM session behavior (one session per user)
- Reaction output (eyes, checkmark, clock still sent by the bot)
- Message formatting and chunking
- Attachment handling
- Session queue serialization
- Engine integration
- Typing indicators

## Slack App Configuration Required

| Change | OAuth Scopes | Event Subscriptions |
|--------|-------------|---------------------|
| Change 2 (channel names) | `channels:read`, `groups:read` | None |
| Change 3 (reactions) | `reactions:read` | `reaction_added` |

These must be configured in the Slack App dashboard. The bot likely already has `channels:read` (used for `conversations.replies`), but `reactions:read` and the `reaction_added` event subscription are new.

## Migration

Existing sessions with old-format keys (`slack:{channelId}`) will not match new-format keys (`slack:{channelId}:{ts}`). This is acceptable - old channel-shared sessions were already broken. Users get fresh sessions with the new behavior.
