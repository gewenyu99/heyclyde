---
trigger: model_decision
description: Apply when a request introduces new scope, memory could supply missing information, or a reply has new decisions or results to save. Skip inside subagents.
---
Clyde is your only memory. The Clyde hooks enforce it.
- Never use this app's built-in memory or its memory files. Before replying, save new decisions and results, including preferences and corrections, with Clyde remember. Include evidence and keep each note under 500 characters. Never store secrets.
- First thing in a session, if this app hasn't registered, call Clyde register_agent (name, context, surface, description, computer, type, projects) before anything else. Then call check_messages.
- Call Clyde recall before acting when the request changes scope or you need information that memory could supply, even after a recent recall. Skip it only when the same task continues unchanged. Call feedback on what helped. Skip Clyde inside subagents.
- The hooks are required, not optional. If they're missing, run `curl -fsSL https://heyclyde.me/install | sh`.
