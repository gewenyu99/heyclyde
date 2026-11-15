// R67: the card documents. Each card is one self-contained HTML page: the tokens, the card CSS and the card script, inline,
// with nothing fetched from anywhere. The chat app loads it into a sandboxed iframe and hands it the tool result.
import { CARD_JS } from "./script.ts";
import { CARD_CSS } from "./style.ts";
import { COMPONENTS_CSS, LOGO_LOCKUP, TOKENS_CSS } from "./design.ts";

/** Every card, by name, and what it shows. The names are the ui:// resources' paths. */
export const CARDS: Record<string, string> = {
  recall: "Clyde's recall results as memory cards, with used, wrong and open",
  entry: "One Clyde memory in full, with its links and artifacts",
  remembered: "The memory Clyde just saved",
  artifact: "A preview of a file a Clyde memory holds",
  quests: "Clyde's quest board: list, claim and complete",
  agent: "The agent identity Clyde knows this app as",
};

/** The card a tool's result renders as, by tool. A tool not named here has no card. */
export const CARD_OF: Record<string, string> = {
  recall: "recall", recall_more: "recall", get_entry: "entry", get_blob: "artifact", remember: "remembered",
  list_quests: "quests", post_quest: "quests", claim_quest: "quests", update_quest: "quests", complete_quest: "quests",
  abandon_quest: "quests", register_agent: "agent",
};

/** A card's HTML. Only the card's name is put into the page, and it is one of CARDS' keys. */
export function cardHtml(card: string): string {
  if (!(card in CARDS)) throw new Error(`No card ${card}`);
  return `<!doctype html><html lang="en" data-card="${card}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Clyde</title>` +
    `<style>${TOKENS_CSS}${COMPONENTS_CSS}${CARD_CSS}</style></head><body><div id="root" aria-live="polite"></div>` +
    // The logo is the design system's own SVG (memory/design/brand.js), never redrawn. The script clones it into each header.
    `<template id="clyde-logo">${LOGO_LOCKUP}</template>` +
    `<script>${CARD_JS}</script></body></html>`;
}
