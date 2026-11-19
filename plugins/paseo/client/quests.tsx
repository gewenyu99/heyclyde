import type { PluginTheme } from "@getpaseo/plugin";
import { scheme } from "./brand";
import { palette } from "./brand.generated";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import { boardRpc, rosterRpc, sharedBoardRpc, spawnQuestRpc } from "../shared/clyde";
import { formatRpcError, MIN_HIT_HEIGHT, tones } from "./palette";

export function Quests(
  { theme, agent: activeAgent, onStarted }: { theme: PluginTheme; agent?: string; onStarted: (id: string) => void },
) {
  const paper = palette[scheme(theme)];
  const [chosen, setChosen] = useState(""),
    [search, setSearch] = useState(""),
    [showFinished, setShowFinished] = useState(false);
  const [expanded, setExpanded] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lookup = useRpc(rosterRpc),
    read = useRpc(sharedBoardRpc),
    scoped = useRpc(boardRpc),
    spawn = useRpc(spawnQuestRpc),
    cache = useQueryClient();
  const c = theme.colors;
  const agent = chosen || activeAgent;
  const chats = useQuery({ queryKey: ["clyde", "roster", "all"], queryFn: () => lookup({}), enabled: !!expanded });
  const query = useQuery({
    queryKey: ["clyde", "shared-quests"],
    queryFn: () => read({}),
    refetchInterval: 30000,
    retry: false,
  });
  const matches = useQuery({
    queryKey: ["clyde", "eligible-quests", agent],
    queryFn: () => scoped({ agent: agent! }),
    enabled: !!agent,
    refetchInterval: 30000,
    retry: false,
  });
  const eligible = new Set(matches.data?.map((q) => q.id) ?? []);
  const term = search.trim().toLowerCase().replace(/^#/, "");
  const quests = (query.data?.quests ?? []).filter((q) =>
    (showFinished
      ? q.state === "done" || q.state === "abandoned"
      : !q.state || q.state === "open" || q.state === "claimed") &&
    (!term ||
      [String(q.id), q.title, q.project, ...(q.tags ?? [])].some((field) => field?.toLowerCase().includes(term)))
  );
  async function start(id: number) {
    if (!agent || busy) return;
    setBusy(true);
    try {
      const run = await spawn({ agent, quest: id });
      void cache.invalidateQueries({ queryKey: ["clyde"] });
      onStarted(run.id);
    } catch (e) {
      setError(formatRpcError(e));
    } finally {
      setBusy(false);
    }
  }
  const linkInk = tones(theme).blue.ink;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "700", fontSize: 18 }}>Quests</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh quests"
          onPress={() => {
            void query.refetch();
            if (agent) void matches.refetch();
          }}
          style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 8 }}
        >
          <Text style={{ fontSize: 13, color: c.accent, fontWeight: "600" }}>Refresh</Text>
        </Pressable>
      </View>
      <TextInput
        accessibilityLabel="Find a quest"
        placeholder="Find by title, project, tag or #…"
        placeholderTextColor={c.foregroundMuted}
        value={search}
        onChangeText={setSearch}
        style={{ color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 10, minHeight: MIN_HIT_HEIGHT, fontSize: 14 }}
      />
      <View style={{ flexDirection: "row", gap: 12 }}>
        {["Active", "Finished"].map((label, i) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: showFinished === !!i }}
            onPress={() => setShowFinished(!!i)}
            key={label}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 6 }}
          >
            <Text style={{ fontSize: 13, color: showFinished === !!i ? c.accent : c.foregroundMuted, fontWeight: "600" }}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {query.isPending
        ? <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Loading quests…</Text>
        : query.error
        ? <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{formatRpcError(query.error)}</Text>
        : quests.length === 0
        ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
            {term ? "No matching quests." : showFinished ? "No finished quests." : "No active quests."}
          </Text>
        )
        : quests.map((q) => {
          const startDisabled = busy || !agent || !eligible.has(q.id) || (!!q.state && q.state !== "open");
          return (
          <View
            key={q.id}
            style={{
              padding: 12,
              gap: 8,
              borderWidth: 1,
              borderTopWidth: 4,
              borderTopColor: paper["sticky-strip"],
              backgroundColor: paper.sticky,
              borderColor: paper["sticky-edge"],
              borderRadius: 6,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: expanded === q.id }}
              onPress={() => setExpanded(expanded === q.id ? 0 : q.id)}
              style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text
                style={{
                  color: paper["ink-2"],
                  fontFamily: "Menlo",
                  fontSize: 12,
                  letterSpacing: 0.8,
                  marginBottom: 7,
                }}
              >
                QUEST #{q.id} · {q.priority.toUpperCase()} ·{" "}
                {q.state === "claimed" ? "CLAIMED" : (q.state ?? "open").toUpperCase()}
                {q.project ? " · " + q.project : ""}
              </Text>
              <Text style={{ color: paper.ink, fontWeight: "600", fontSize: 15 }}>{q.title}</Text>
            </Pressable>
            {expanded === q.id && (
              <>
                <View
                  style={{ borderTopWidth: 1, borderStyle: "dashed", borderColor: paper["sticky-edge"], paddingTop: 9 }}
                >
                  <Text style={{ color: paper["ink-2"], fontSize: 13, lineHeight: 20 }}>{q.brief}</Text>
                </View>
                <Text style={{ color: paper["ink-2"], fontSize: 13 }}>Done when {q.done_when}</Text>
                {(!activeAgent || !eligible.has(q.id)) && (!q.state || q.state === "open") && (
                  <View style={{ gap: 4 }}>
                    <Text style={{ color: paper["ink-2"], fontSize: 12, fontWeight: "600" }}>Run in chat</Text>
                    {chats.data?.map((chat) => (
                      <Pressable
                        key={chat.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: chosen === chat.id }}
                        onPress={() => setChosen(chat.id)}
                        style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
                      >
                        <Text style={{ fontSize: 13, color: chosen === chat.id ? linkInk : paper.ink, fontWeight: chosen === chat.id ? "600" : "400" }}>
                          {chosen === chat.id ? "✓ " : ""}
                          {chat.title} · {chat.project}
                        </Text>
                      </Pressable>
                    ))}
                    {chats.data?.length === 0 && (
                      <Text style={{ color: paper["ink-2"], fontSize: 13 }}>Open a project chat to start this quest.</Text>
                    )}
                  </View>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: startDisabled }}
                  disabled={startDisabled}
                  onPress={() => void start(q.id)}
                  style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
                >
                  <Text style={{ color: startDisabled ? paper["ink-2"] : linkInk, fontSize: 13, fontWeight: "600" }}>
                    {q.state === "claimed"
                      ? "Claimed by " + (q.claimed_by ?? "another agent")
                      : q.state === "done"
                      ? "Completed"
                      : q.state === "abandoned"
                      ? "Withdrawn"
                      : !agent
                      ? "Choose a chat to start"
                      : !eligible.has(q.id)
                      ? "Requires a matching agent"
                      : busy
                      ? "Starting…"
                      : "Start task from quest"}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
          );
        })}
      {query.data?.legacy && (
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL("https://heyclyde.me/quests")}
          style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
        >
          <Text style={{ color: c.accent, fontSize: 13 }}>Full account history ↗</Text>
        </Pressable>
      )}
      {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{error}</Text>}
    </View>
  );
}
