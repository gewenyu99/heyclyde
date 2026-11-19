import type { PluginTheme } from "@getpaseo/plugin";
import { scheme } from "./brand";
import { palette } from "./brand.generated";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { boardRpc, spawnQuestRpc } from "../shared/clyde";

export function Quests(
  { theme, agent, onStarted }: { theme: PluginTheme; agent?: string; onStarted: (id: string) => void },
) {
  const paper = palette[scheme(theme)];
  const c = theme.colors, read = useRpc(boardRpc), spawn = useRpc(spawnQuestRpc), cache = useQueryClient();
  const query = useQuery({
    queryKey: ["clyde", "quests", agent],
    queryFn: () => read({ agent: agent! }),
    enabled: !!agent,
    refetchInterval: 30000,
    retry: false,
  });
  const [expanded, setExpanded] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function start(id: number) {
    if (!agent || busy) return;
    setBusy(true);
    try {
      const run = await spawn({ agent, quest: id });
      void cache.invalidateQueries({ queryKey: ["clyde"] });
      onStarted(run.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "700", fontSize: 18 }}>Quests</Text>
        {agent && (
          <Pressable accessibilityRole="button" onPress={() => void query.refetch()}>
            <Text style={{ fontSize: 12, color: c.accent }}>Refresh</Text>
          </Pressable>
        )}
      </View>
      {!agent
        ? <Text style={{ color: c.foregroundMuted }}>Select a project chat to see its quests.</Text>
        : query.isPending
        ? <Text style={{ color: c.foregroundMuted }}>Loading quests…</Text>
        : query.error
        ? <Text style={{ color: c.statusWarning }}>{query.error.message}</Text>
        : query.data?.length === 0
        ? <Text style={{ color: c.foregroundMuted }}>No open quests for this agent.</Text>
        : query.data?.map((q) => (
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
              onPress={() => setExpanded(expanded === q.id ? 0 : q.id)}
            >
              <Text
                style={{
                  color: paper["ink-2"],
                  fontFamily: "Menlo",
                  fontSize: 11,
                  letterSpacing: 0.8,
                  marginBottom: 7,
                }}
              >
                QUEST #{q.id} · {q.priority.toUpperCase()}
              </Text>
              <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 15 }}>{q.title}</Text>
            </Pressable>
            {expanded === q.id && (
              <>
                <View
                  style={{ borderTopWidth: 1, borderStyle: "dashed", borderColor: paper["sticky-edge"], paddingTop: 9 }}
                >
                  <Text style={{ color: paper["ink-2"], lineHeight: 20 }}>{q.brief}</Text>
                </View>
                <Text style={{ color: c.foregroundMuted }}>Done when {q.done_when}</Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void start(q.id)}
                >
                  <Text style={{ color: c.accent, fontWeight: "600" }}>
                    {busy ? "Starting…" : "Start task from quest"}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        ))}
      {!!error && <Text style={{ color: c.statusDanger }}>{error}</Text>}
    </View>
  );
}
