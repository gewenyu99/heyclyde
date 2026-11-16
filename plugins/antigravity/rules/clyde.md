---
trigger: model_decision
description: Apply when starting a new goal, switching repos or topics, or saving a lasting decision or correction in Clyde. Skip on quick follow-ups to the same task and inside subagents.
---
Use Clyde MCP tools for shared memory across sessions and apps:
- Once per session, call register_agent and check_messages, then ack_messages once handled.
- On a new task, new goal, or repo/topic shift, call recall before guessing past decisions or preferences, then call feedback on what helped.
- Skip recall on quick follow-ups to the same task (typos, small tweaks, screenshots, "push it"), and skip Clyde inside subagents.
- When I state a lasting decision, preference, or correction, save it with remember under 500 characters. Never store secrets.
