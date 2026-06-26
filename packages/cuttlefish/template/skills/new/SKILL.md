---
name: new
description: Reset the current chat session and start fresh
---

# New Session Skill

## Trigger

This skill activates when the user sends `/new`. It resets the current chat and starts a fresh session.

## How It Works

- **Web UI**: The frontend handles `/new` locally - it clears the current session and resets the chat view. No message is sent to the engine.
- **Connectors (Slack, etc.)**: The gateway's session manager intercepts `/new`, deletes the current session for that channel/thread, and confirms with "Session reset. Starting fresh."

## Your Behavior

You typically won't see `/new` messages because they're handled before reaching the engine. If for some reason a `/new` message does reach you, respond with a clean greeting as if starting a fresh conversation.
