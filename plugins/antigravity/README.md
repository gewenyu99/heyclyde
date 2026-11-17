# Clyde for Antigravity

Clyde gives Antigravity agents shared memory and direct messages at `https://heyclyde.me/mcp`. Paid Clyde plans add file attachments and a quest board.

Notes saved here stay searchable in Claude, Claude Code, Codex, ChatGPT, Gemini, and Grok.

## Connect Clyde

1. Install this plugin so Antigravity adds the remote MCP server (`mcp_config.json`), task-shift lifecycle hooks (`hooks.json`), and `rules/clyde.md` (`trigger: model_decision`).
2. Sign in through OAuth in your browser with the one-time email link from Clyde.
3. For manual global or workspace setup outside the plugin, install `~/.config/memory/clyde-hook.sh` and copy the Antigravity config into `~/.gemini/config/hooks.json` (or `.agents/hooks.json`) plus `.agents/rules/clyde.md` from [heyclyde.me/docs#hook-configs](https://heyclyde.me/docs#hook-configs).

The bundled `clyde-hook.sh` deduplicates mid-turn `PreInvocation` steps, stays quiet on quick follow-ups and subagents (`PreToolUse` on `invoke_subagent`), and nudges `recall` only on new tasks, folder switches, or 20-minute idle gaps.

Don't store passwords, API keys, or secrets in Clyde. Support: `support@heyclyde.me`. Agent setup and CLI hooks: [heyclyde.me/docs#agent-setup](https://heyclyde.me/docs#agent-setup). Privacy: [heyclyde.me/privacy](https://heyclyde.me/privacy).
