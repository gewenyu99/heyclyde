// R67: Clyde's cards for chat apps, on the MCP Apps extension (io.modelcontextprotocol/ui, spec 2026-01-26) that claude.ai
// and ChatGPT render. A coding app sees none of this: its initialize, tools/list and tool results stay byte for byte what
// they were. A chat app that can render cards gets, on top of the same text:
//   - initialize: capabilities.resources and capabilities.extensions["io.modelcontextprotocol/ui"];
//   - tools/list: each tool with a card carries _meta.ui.resourceUri (plus the older ui/resourceUri and ChatGPT's
//     openai/outputTemplate aliases);
//   - resources/list and resources/read: the cards, as text/html;profile=mcp-app;
//   - tools/call: the result's _meta["clyde/card"] holds the card's data. _meta goes to the card, never to the model, so the
//     model reads exactly the text it always did.
// No Deno APIs, so node imports it in tests.
import { CARD_OF, CARDS, cardHtml } from "./cards.ts";

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const UI_MIME = "text/html;profile=mcp-app";
export const CARD_KEY = "clyde/card";
export const uriOf = (card: string) => `ui://clyde/${card}.html`;
/** The display modes a card takes, inline first: it shows in the conversation, open, and can go fullscreen (R78). The card
 * declares the same list in ui/initialize and asks for inline with ui/request-display-mode. */
export const DISPLAY_MODES = ["inline", "fullscreen"];

/** Chat apps known to render MCP Apps that may not say so in initialize. A coding app is never on this list, and anything
 * that declares the extension gets cards whatever its name. */
const CHAT_APPS = /^(claude-ai|anthropic|openai-mcp|chatgpt)/i;
const declares = (caps: any) => {
  const ui = caps?.extensions?.[UI_EXTENSION];
  return Boolean(ui) && (!Array.isArray(ui.mimeTypes) || ui.mimeTypes.includes(UI_MIME));
};

/** Whether this client renders cards: it declares the UI extension in initialize, or per request under the stateless
 * protocol's _meta, or it is a chat app by name. */
export function wantsUi(initParams: any): boolean {
  if (declares(initParams?.capabilities)) return true;
  const name = initParams?.clientInfo?.name;
  return typeof name === "string" && CHAT_APPS.test(name.trim());
}
/** The stateless protocol (2026-07-28) sends the client's capabilities with every request. */
export const requestWantsUi = (params: any) => declares(params?._meta?.["io.modelcontextprotocol/clientCapabilities"]);

/** What ChatGPT shows while a tool runs and after, at most 64 characters each. */
const INVOKING: Record<string, [string, string]> = {
  recall: ["Searching Clyde", "Searched Clyde"], recall_more: ["Digging deeper", "Dug deeper"], get_entry: ["Opening the memory", "Opened the memory"],
  get_blob: ["Opening the artifact", "Opened the artifact"], remember: ["Saving to Clyde", "Saved to Clyde"],
  list_quests: ["Reading the quest board", "Read the quest board"], post_quest: ["Posting the quest", "Posted the quest"],
  claim_quest: ["Claiming the quest", "Claimed the quest"], update_quest: ["Updating the quest", "Updated the quest"],
  complete_quest: ["Completing the quest", "Completed the quest"], abandon_quest: ["Letting the quest go", "Let the quest go"],
  register_agent: ["Registering", "Registered"],
};

/** The tool list a card-rendering client sees: the same tools, with a card linked in _meta. */
export function uiTools<T extends { name: string }>(tools: T[]): (T & { _meta?: Record<string, unknown> })[] {
  return tools.map((t) => {
    const card = CARD_OF[t.name];
    if (!card) return t;
    const uri = uriOf(card);
    return {
      ...t,
      _meta: {
        ui: { resourceUri: uri, visibility: ["model", "app"] }, "ui/resourceUri": uri,
        "openai/outputTemplate": uri, "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": INVOKING[t.name]?.[0], "openai/toolInvocation/invoked": INVOKING[t.name]?.[1],
      },
    };
  });
}

/** The cards as MCP resources. */
export const uiResources = () => Object.entries(CARDS).map(([card, description]) => ({
  uri: uriOf(card), name: `clyde-${card}`, title: `Clyde ${card} card`, description, mimeType: UI_MIME,
}));

/** resources/read for a card, or null for any other uri. `storage` is the origin a signed download link comes from, so an
 * image artifact can show inside the card. */
export function readUiResource(uri: unknown, storage: string | null) {
  const m = typeof uri === "string" ? /^ui:\/\/clyde\/([a-z]+)\.html$/.exec(uri) : null;
  if (!m || !(m[1] in CARDS)) return null;
  // Any card can open an artifact, so each may show an image from Storage.
  const domains = storage ? [storage] : [];
  return {
    contents: [{
      uri, mimeType: UI_MIME, text: cardHtml(m[1]),
      _meta: {
        ui: { prefersBorder: false, ...(domains.length ? { csp: { resourceDomains: domains } } : {}) },
        // Inline first (R78): ChatGPT opens a widget fullscreen when fullscreen is its only mode, so inline leads the list.
        "openai/ui": { availableDisplayModes: DISPLAY_MODES },
        "openai/widgetDescription": CARDS[m[1]], "openai/widgetPrefersBorder": false,
        ...(domains.length ? { "openai/widgetCSP": { connect_domains: [], resource_domains: domains } } : {}),
      },
    }],
  };
}

/** Everything a card-rendering client reads that a coding client doesn't, for the version guard's surface hash. */
export const uiSurface = <T extends { name: string }>(tools: T[]) => ({
  tools: uiTools(tools), resources: uiResources(), html: Object.keys(CARDS).map((c) => readUiResource(uriOf(c), "https://storage.example")),
});
