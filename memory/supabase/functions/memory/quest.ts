// R62 (#67): single quest routing matcher (questMatches) used by MCP tools, hooks board, UI cards, and /me/quests.
export {
  parseQuestTarget,
  type QuestAgent,
  questMatches,
  questPermitted,
  type QuestTarget,
  scopeToQuestAgent,
} from "./core/quest.ts";
