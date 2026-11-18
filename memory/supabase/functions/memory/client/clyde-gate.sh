#!/bin/sh
# clyde-gate.sh prompt|pre|post: Clyde's gate for Claude Code. The gate is part of clyde-hook.sh now, so this hands each
# call to it: prompt is UserPromptSubmit, pre is PreToolUse, post is PostToolUse. Always exits 0.
hook="$HOME/.config/memory/clyde-hook.sh"
case ${1:-} in
  prompt) [ -x "$hook" ] && exec "$hook" claude UserPromptSubmit ;;
  pre) [ -x "$hook" ] && exec "$hook" claude PreToolUse ;;
  post) [ -x "$hook" ] && exec "$hook" claude PostToolUse ;;
esac
cat >/dev/null 2>&1
exit 0
