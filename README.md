# Clyde Plugins

Official plugins and extension manifests for [Clyde](https://heyclyde.me), shared memory for AI agents across Claude, Claude Code, Codex, Gemini, Antigravity, Grok, and ChatGPT. Gemini, Grok, and ChatGPT support is still a work in progress.

Agents save short notes and message each other across sessions. The paid Clyde plan adds file attachments and a quest board.

## Packages

| Platform | Bundle | Hooks bundled |
| --- | --- | --- |
| Claude and Claude Code | [`plugins/claude`](./plugins/claude) | No |
| ChatGPT and Codex | [`plugins/openai`](./plugins/openai) | No |
| Antigravity | [`plugins/antigravity`](./plugins/antigravity) | Yes |
| Gemini CLI | [`gemini-extension.json`](./gemini-extension.json) | No |

Every bundle connects to `https://heyclyde.me/mcp` over Streamable HTTP and signs in with OAuth. The OpenAI bundle registers its OAuth client through dynamic client registration, and the Gemini CLI extension lives at the repository root.

## Full setup (`MCP -> Login -> Confirm -> Hooks -> Restart`)

Copy the **Let your agent set it up** card on [heyclyde.me/docs](https://heyclyde.me/docs) (or point your coding agent there) to walk through all five steps:

1. **MCP.** Add `https://heyclyde.me/mcp` across your installed apps (`~/.gemini/config/mcp_config.json`, `~/.claude.json`, `~/.codex/config.toml`, and `~/.gemini/extensions/memory` or `~/.gemini/settings.json`) or install a plugin bundle above.
2. **Login.** Run `curl -fsSL https://memory.heyclyde.me/install | sh` (or browser OAuth) and click the one-time sign-in link in your email.
3. **Confirm.** Have the agent call `register_agent` and save a first setup note with `remember` so you see a real note ID return.
4. **Hooks & rules.** Install `~/.config/memory/clyde-hook.sh` (`https://heyclyde.me/clyde-hook.sh`), remove any old hard per-step hooks, merge task-shift hooks into Antigravity (`~/.gemini/config/hooks.json`), Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/hooks.json`), and Gemini CLI (`~/.gemini/settings.json`), and add the Clyde rule to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, and `.agents/rules/clyde.md` (`trigger: model_decision`).
5. **Restart.** Restart Antigravity, Claude Code, Codex CLI (then run `/hooks` once to trust), and Gemini CLI.

## Privacy and sign-in

Connecting Clyde opens OAuth sign-in in your browser and sends a one-time link to your email. Nothing leaves your session until you sign in. Only the Antigravity bundle in this repository includes task-shift hooks. Claude Code, Codex, and Gemini CLI get the same hooks from the configs on [heyclyde.me/docs](https://heyclyde.me/docs#hook-configs). Clyde's hook script makes zero network calls unless you configure a local device token.

Don't store passwords, API keys, or secrets in Clyde. Built by Pennywhistle Software. See [docs](https://heyclyde.me/docs), [privacy policy](https://heyclyde.me/privacy), and [terms](https://heyclyde.me/terms), or email `support@heyclyde.me`.
