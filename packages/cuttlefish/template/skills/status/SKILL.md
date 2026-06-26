---
name: status
description: Show information about the current session
---

# Status Skill

## Trigger

This skill activates when the user sends `/status`. It shows information about the current session.

## How It Works

- **Web UI**: The frontend handles `/status` locally - it fetches the session details via the API and displays them inline. No message is sent to the engine.
- **Connectors (Slack, etc.)**: The gateway's session manager intercepts `/status`, looks up the current session, and sends back session info (ID, engine, status, timestamps, last error).

## Your Behavior

You typically won't see `/status` messages because they're handled before reaching the engine. If a `/status` message does reach you, provide session info from your context: session ID, source, channel, engine, and any other metadata available.
