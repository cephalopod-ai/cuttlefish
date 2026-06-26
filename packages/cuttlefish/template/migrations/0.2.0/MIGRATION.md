# Migration: 0.2.0 (Connectors Support)

## Summary

This release introduces a connector abstraction layer with capability declarations, unified message routing through SessionManager, and transport state tracking. The cron runner is refactored to route through SessionManager instead of directly managing engines.

## Template files changed

### `config.default.yaml`
- `cuttlefish.version` bumped from `"0.1.1"` to `"0.2.0"`
- Added `connectors.slack.shareSessionInChannel: false` — when true, all messages in a Slack channel share one session (ignores threads)
- Added `connectors.slack.ignoreOldMessagesOnBoot: true` — skip Slack messages sent before the gateway started

## New config keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connectors.slack.shareSessionInChannel` | boolean | `false` | Share a single session across all messages in a channel |
| `connectors.slack.ignoreOldMessagesOnBoot` | boolean | `true` | Ignore Slack messages older than gateway boot time |
| `connectors.slack.allowFrom` | string \| string[] | _(unset)_ | Whitelist of Slack user IDs allowed to interact with the bot |

## Database migration

The gateway automatically migrates the SQLite schema on startup. New columns added to the sessions table:
- `connector` — connector name (e.g. "slack", "web", "cron")
- `session_key` — routing key replacing the old `source_ref`
- `reply_context` — JSON blob with channel, thread, and message metadata
- `message_id` — platform message ID for edit/reaction targeting
- `transport_meta` — JSON blob with connector-specific transport data

Existing sessions are backfilled from `source_ref` and `source` fields. **No manual action needed.**

## Merge instructions

1. **Config**: Add the new `connectors.slack` keys to your `config.yaml` if not already present. Existing configs without these keys will use defaults.
2. **No template skill changes** in this release.
3. **Database**: Handled automatically on gateway start — no manual steps.

## Files

- `files/config.default.yaml` — updated default config for reference
