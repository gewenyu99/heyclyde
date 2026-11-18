import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { type Resident, residentRpc, rosterRpc } from "../shared/clyde";

function Row({ agent, theme, refresh }: { agent: Resident; theme: PluginTheme; refresh: () => void }) {
  const change = useRpc(residentRpc);
  const [role, setRole] = useState(agent.role);
  const [areas, setAreas] = useState(agent.areas.join(", "));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(op: "confirm" | "pause" | "resume" | "start" | "pass") {
    setBusy(true);
    try {
      await change({
        id: agent.id,
        action: op,
        role,
        areas: areas.split(",").map((a) => a.trim()).filter(Boolean),
        questId: agent.offer?.id,
      });
      setError("");
      setEditing(false);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const button = (label: string, click: () => void) => (
    <Pressable accessibilityRole="button" disabled={busy} onPress={click}>
      <Text style={{ color: theme.colors.accent, paddingVertical: 5 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ borderTopColor: theme.colors.border, borderTopWidth: 1, paddingVertical: 8, gap: 4 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{agent.title}</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {agent.project} · {agent.provider} · {agent.memory} memory
      </Text>
      {editing
        ? (
          <>
            <TextInput
              accessibilityLabel="Role"
              value={role}
              onChangeText={setRole}
              style={{ color: theme.colors.foreground }}
            />
            <TextInput
              accessibilityLabel="Responsibility tags"
              value={areas}
              onChangeText={setAreas}
              style={{ color: theme.colors.foreground }}
            />
            {button("Confirm responsibilities", () => void action("confirm"))}
          </>
        )
        : (
          <>
            <Text style={{ color: theme.colors.foreground }}>{agent.role} · {agent.areas.join(", ")}</Text>
            {button(
              agent.confirmed ? "Edit responsibilities" : "Review suggested responsibilities",
              () => setEditing(true),
            )}
            {agent.confirmed &&
              button(
                agent.paused ? "Resume pickup" : "Pause pickup",
                () => void action(agent.paused ? "resume" : "pause"),
              )}
          </>
        )}
      {agent.offer && (
        <Text style={{ color: theme.colors.foreground }}>
          #{agent.offer.id} {agent.offer.title} · {agent.offer.priority}
          {agent.offer.run ? " · " + agent.offer.run : ""}
        </Text>
      )}
      {agent.offer && !agent.offer.assignment && (
        <View style={{ flexDirection: "row", gap: 16 }}>
          {button("Start", () => void action("start"))}
          {button("Pass", () => void action("pass"))}
        </View>
      )}
      {(error || agent.error) && <Text style={{ color: theme.colors.statusDanger }}>{error || agent.error}</Text>}
    </View>
  );
}
export function Roster({theme,workspaceId}:{theme:PluginTheme;workspaceId?:string}) {
  const read=useRpc(rosterRpc);
  const query=useQuery({queryKey:["clyde","roster",workspaceId??"all"],queryFn:()=>read({workspaceId}),refetchInterval:10000});
  return <View style={{gap:10}}>
    <Text accessibilityRole="header" style={{color:theme.colors.foreground,fontWeight:"700",fontSize:18}}>Agents</Text>
    {query.isPending && <Text style={{color:theme.colors.foregroundMuted}}>Loading agents…</Text>}
    {query.error && <Text style={{color:theme.colors.statusDanger}}>{String(query.error)}</Text>}
    {query.data?.length===0 && <Text style={{color:theme.colors.foregroundMuted}}>Open a project chat to register an agent.</Text>}
    {query.data?.map(agent=><Row key={agent.id} agent={agent} theme={theme} refresh={()=>void query.refetch()}/>)}
  </View>;
}
