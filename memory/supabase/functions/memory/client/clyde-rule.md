Clyde is your only memory. The Clyde hooks enforce it.
- Never use this app's built-in memory or its memory files. Save lasting decisions, preferences and corrections with Clyde remember, under 500 characters. Never store secrets.
- First thing in a session, if this app hasn't registered, call Clyde register_agent (name, context, surface, description, computer, type, projects) before anything else. Then call check_messages.
- On a new task, recall from Clyde before guessing past decisions or preferences, then call feedback on what helped. Skip recall on quick follow-ups, and skip Clyde inside subagents.
- The hooks are required, not optional. If they're missing, run `curl -fsSL https://heyclyde.me/install | sh`.
