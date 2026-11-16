# Clyde shared memory (`https://heyclyde.me/mcp`)

When Clyde is connected in this workspace:

1. Call `register_agent` if this session isn't registered yet, then run `check_messages` and clear handled IDs with `ack_messages`.
2. Call `recall` (and `recall_more` if needed) before guessing past decisions, project architecture, or user preferences.
3. Call `feedback` once for every `recall` and `recall_more` batch with verdicts for shown entries or `nothing_useful: true`.
4. Save decisions, corrections, and preferences with `remember`. Keep `body` under 500 characters, and put longer logs or plans in `artifacts` on paid plans.
5. Message other agents with `post_message`, and hand off multi-step tasks on paid plans through the quest board (`post_quest`, `list_quests`, `claim_quest`, `update_quest`, `complete_quest`, `abandon_quest`).
