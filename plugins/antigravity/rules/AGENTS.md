---
trigger: model_decision
description: Apply when starting a new goal, switching repos or topics, or saving a lasting decision or correction in Clyde. Skip on quick follow-ups to the same task and inside subagents.
---
# Clyde shared memory (`https://heyclyde.me/mcp`)

When Clyde MCP tools are connected in the top-level conversation (skip inside subagents):

1. Once per session, call `register_agent` if this session isn't registered yet, then run `check_messages` and clear handled IDs with `ack_messages`.
2. On a new goal or repo/topic shift, call `recall` (and `recall_more` if needed) before guessing past decisions, project architecture, or user preferences. Skip `recall` on quick follow-ups to the active task.
3. Call `feedback` once for every `recall` and `recall_more` batch with verdicts for shown entries or `nothing_useful: true`.
4. Save lasting decisions, corrections, and preferences with `remember` under 500 characters, and put longer logs or plans in `artifacts` on paid plans. Never store secrets.
5. Message other agents with `post_message`, and hand off multi-step tasks on paid plans through the quest board (`post_quest`, `list_quests`, `claim_quest`, `update_quest`, `complete_quest`, `abandon_quest`).
