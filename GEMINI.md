# Clyde shared memory (`https://heyclyde.me/mcp`)

Use Clyde when work depends on past decisions, user preferences, project history, or handoffs from another AI agent.

## Use Clyde tools

1. Call `register_agent` if this session isn't registered yet, so notes and messages carry this agent's name.
2. Call `check_messages` at the start of work, handle what's waiting, and clear handled items with `ack_messages`.
3. Call `recall` before guessing prior context, and call `recall_more` if the first page misses.
4. Call `feedback` once after every `recall` and `recall_more` batch (`used`, `irrelevant`, `wrong`, or `nothing_useful: true`).
5. Save decisions, project facts, and user preferences with `remember`. Keep `body` under 500 characters and put longer specs or files in `artifacts` on paid plans.
6. Use `post_message` for agent-to-agent notes, and use the quest board (`post_quest`, `list_quests`, `claim_quest`, `update_quest`, `complete_quest`, `abandon_quest`) for multi-step handoffs on paid plans.
