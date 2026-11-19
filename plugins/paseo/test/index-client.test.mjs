import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute contribution callbacks against the public host contract without a React Native renderer.
function loadClient() {
  const source = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const registered = { panels: [], agentPanels: [], slash: [], commands: [], screens: [], sidebar: [] };
  const opened = [];
  const jsx = (type, props) => ({ type, props });
  const theme = { colors: { surface0: "#fff", foreground: "#111", foregroundMuted: "#333" } };
  const panel = () => {}, sidecar = () => {};
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@getpaseo/plugin/client": {
      useRpc: () => async () => ({}),
    },
    "@getpaseo/plugin/client/ui": { SidebarRow: "SidebarRow" },
    "@tanstack/react-query": { useQuery: () => ({}) },
    "react-native": { Text: "Text", View: "View", Pressable: "Pressable", ScrollView: "ScrollView" },
    "./client/brand": { scheme: () => "light", clydeTheme: t => t },
    "./client/brand.generated": { artwork: { light: { mark: "mark" } } },
    "./client/icon": { clydeIcon: "icon" },
    "./client/screen": { ClydeScreen: () => {}, ClydeWorkspacePanel: panel },
    "./client/sidecar": { Sidecar: sidecar },
    "./client/nodes": { useLive() {}, tones: () => ({}) },
  };
  const exports = {};
  new Function("require", "exports", output)(name => modules[name] ?? {}, exports);
  exports.default({ addTimelineTransformer() {}, addTimelineRenderer() {},
    addWorkspacePanel: p => registered.panels.push(p), addAgentPanel: p => registered.agentPanels.push(p),
    addSlashCommand: p => registered.slash.push(p), addCommandCenterItem: p => registered.commands.push(p),
    addScreen: p => registered.screens.push(p), addSidebarHeaderItem: p => registered.sidebar.push(p),
    openPanel: (...args) => opened.push(args) });
  function sidebar() {
    const screens = [];
    const row = registered.sidebar[0].Component({ theme, host: { id: "host-1" }, currentScreen: null,
      openScreen: screen => screens.push(screen), openPopover: () => { throw new Error("Sidebar should open the central Board directly"); } });
    return { row, screens };
  }
  return { registered, opened, sidebar, panel, sidecar };
}

test("Clyde registers the full Board as a native workspace tab and retains Explorer sidecars", () => {
  const { registered, panel, sidecar } = loadClient();
  const board = registered.panels.find(p => p.id === "board");
  assert.equal(board.Component, panel);
  assert.deepEqual(board.locations, ["workspace"]);
  const explorer = registered.panels.find(p => p.id === "sidecar");
  assert.equal(explorer.Component, sidecar);
  assert.deepEqual(explorer.locations, ["explorer"]);
  assert.deepEqual(registered.agentPanels[0].locations, ["explorer"]);
});
test("/clyde and Command Center open the contextual workspace's native tab strip", () => {
  const { registered } = loadClient(), opened = [];
  const context = { workspace: { id: "current" }, openPanel: (...args) => opened.push(args) };
  const slash = registered.slash.find(c => c.name === "clyde");
  assert.equal(slash.context, "workspace", "available in existing chats and workspace drafts");
  slash.onSubmit(context);
  registered.commands.find(c => c.id === "beside-chat").onSelect(context);
  assert.deepEqual(opened, [["board", { location: "workspace" }], ["board", { location: "workspace" }]]);
});
test("sidebar opens Clyde's central command screen directly", () => {
  const { sidebar, opened } = loadClient();
  const item = sidebar();
  item.row.props.onPress();
  assert.deepEqual(item.screens, [{ screenId: "clyde" }]);
  assert.deepEqual(opened, [], "the central command point is independent of workspace tab navigation");
});
