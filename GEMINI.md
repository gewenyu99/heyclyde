# Clyde shared memory (`https://heyclyde.me/mcp`)

Apply these steps only when Clyde MCP tools are connected in the top-level session. Skip Clyde inside subagents and when Clyde MCP isn't mounted.

## Task-shift gating

1. Once per session, call `register_agent` (if not registered yet) and `check_messages`, then clear handled items with `ack_messages`.
2. On a new task, new goal, or repo/topic shift, call `recall` before guessing prior decisions, preferences, or project history, and call `recall_more` if the first page misses.
3. Skip `recall` on quick follow-ups to the active task (`"push it"`, `"fix line 4"`, `"show me a screenshot"`, or inline review comments).
4. Call `feedback` once after every `recall` and `recall_more` batch (`used`, `irrelevant`, `wrong`, or `nothing_useful: true`).
5. Save lasting decisions, project facts, corrections, and preferences with `remember` under 500 characters, and put longer specs or files in `artifacts` on paid plans. Never store secrets.
6. Use `post_message` for agent-to-agent notes, and use the quest board (`post_quest`, `list_quests`, `claim_quest`, `update_quest`, `complete_quest`, `abandon_quest`) for multi-step handoffs on paid plans.
