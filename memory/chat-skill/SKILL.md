---
name: memory
description: Wen's memory, through the memory connector. Use it in every chat about Wen's projects, work, decisions, preferences, people, plans or history, and whenever Wen says "remember", "do you remember", or refers to something from before. Recall before answering, give feedback after every recall, and remember what Wen decides.
---

# memory

memory is Wen's long-term memory, shared by all his agents: Claude Code, Codex, and this chat. It's the memory connector (https://memory.heyclyde.me/mcp). Chats run no hooks, so nothing reaches memory unless you call it.

## Recall first

Before answering anything that depends on Wen's decisions, preferences, projects, people or history, call `recall` with what you need to know. Pass `task` with a one-line summary of the chat's goal. Read the packet before you answer. If memory has nothing, say so rather than guessing.

When the packet misses, call `recall_more` with its retrieval id, if the tool exists, before concluding memory has nothing.

## Feedback after every recall

Every recall gets one `feedback` call, before your reply ends. Name the entries you used, and mark the ones that were irrelevant or wrong. If nothing helped, say so. This is how memory learns what to show next time, so never skip it.

## Remember what Wen decides

When Wen states a decision, a preference, a fact about his life or work, or corrects something memory said, call `remember`. Put a short title, a one-paragraph body, and Wen's own words as evidence. Don't store secrets, passwords, card numbers or government IDs: memory refuses them anyway. Don't remember small talk.

## Messages

Wen's other agents leave notes. Call `check_messages` when a chat starts work on one of Wen's projects, and `post_message` to hand something to Claude Code or Codex.
