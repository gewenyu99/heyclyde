import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { type Resident, residentRpc, rosterRpc } from "../shared/clyde";
import { palette } from "./brand.generated";
import { formatRpcError, MIN_HIT_HEIGHT, scheme } from "./palette";

type RowProps = {
  agent: Resident;
  theme: PluginTheme;
  refresh: () => void;
  openAgent?: (id: string) => void;
};

function Row({ agent, theme, refresh, openAgent }: RowProps) {
  const change = useRpc(residentRpc);
  const [role, setRole] = useState("");
  const [areas, setAreas] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const colors = theme.colors;
  const configured = agent.confirmed || agent.areas.length > 0;
  const tags = areas.split(",").map(tag => tag.trim()).filter(Boolean);
  async function action(op: "confirm" | "pause" | "resume" | "start" | "pass") {
    setBusy(true);
    try {
      await change({
        id: agent.id,
        action: op,
        ...(op === "confirm" ? { role: role.trim() || undefined, areas: tags } : {}),
        questId: agent.offer?.id,
      });
      setError("");
      setEditing(false);
      refresh();
    } catch (e) {
      setError(formatRpcError(e));
    } finally {
      setBusy(false);
    }
  }
  function edit() {
    setRole(configured ? agent.role : "");
    setAreas(agent.areas.join(", "));
    setError("");
    setEditing(true);
  }
  const button = (label: string, click: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy || disabled }}
      disabled={busy || disabled}
      onPress={click}
      style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
    >
      <Text style={{ fontSize: 13, color: disabled ? colors.foregroundMuted : colors.accent, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  const project = agent.project.split("/").at(-1);
  const status = agent.status && agent.status.charAt(0).toUpperCase() + agent.status.slice(1);
  const metadata = [project, agent.model?.split("/").at(-1), status].filter(Boolean).join(" · ");
  const actions = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 16 } as const;
  const field = { color: colors.foreground, backgroundColor: colors.surface1, borderWidth: 1, borderColor: palette[scheme(theme)].edge, borderRadius: 4, padding: 10, minHeight: MIN_HIT_HEIGHT, fontSize: 14 };
  return (
    <View style={{ borderTopColor: colors.border, borderTopWidth: 1, paddingVertical: 10, gap: 4 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{agent.title}</Text>
      <Text style={{ color: colors.foregroundMuted }}>{metadata}</Text>
      {editing ? (
        <View style={{ gap: 6 }}>
          <TextInput accessibilityLabel="Role" placeholder="Role (optional)" placeholderTextColor={colors.foregroundMuted}
            value={role} maxLength={160} onChangeText={setRole} onSubmitEditing={() => { if (tags.length > 0 && !busy) void action("confirm"); }} style={field} />
          <TextInput accessibilityLabel="Responsibility tags" placeholder="Tags, separated by commas" placeholderTextColor={colors.foregroundMuted}
            value={areas} onChangeText={setAreas} onSubmitEditing={() => { if (tags.length > 0 && !busy) void action("confirm"); }} style={field} />
          <View style={actions}>
            {button("Confirm responsibilities", () => void action("confirm"), tags.length === 0)}
            {button("Cancel", () => setEditing(false))}
          </View>
        </View>
      ) : (
        <>
          {configured && (
            <Text style={{ color: colors.foreground }}>
              {[agent.role, agent.areas.join(", ")].filter(Boolean).join(" · ")}
            </Text>
          )}
          <View style={actions}>
            {openAgent && button("Open chat", () => openAgent(agent.id))}
            {button(agent.confirmed ? "Edit responsibilities" : configured ? "Review suggestion" : "Set responsibilities", edit)}
            {agent.confirmed && button(agent.paused ? "Resume pickup" : "Pause pickup",
              () => void action(agent.paused ? "resume" : "pause"))}
          </View>
        </>
      )}
      {agent.offer && (
        <Text style={{ color: colors.foreground }}>
          #{agent.offer.id} {agent.offer.title} · {agent.offer.priority}
          {agent.offer.run ? " · " + agent.offer.run : ""}
        </Text>
      )}
      {agent.offer && !agent.offer.assignment && (
        <View style={actions}>
          {button("Start", () => void action("start"))}
          {button("Pass", () => void action("pass"))}
        </View>
      )}
      {error && <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>{error}</Text>}
      {!editing && agent.pickupError && (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13 }}>Quest pickup unavailable. {agent.pickupError}</Text>
      )}
    </View>
  );
}

export function Roster({ theme, workspaceId, openAgent }: {
  theme: PluginTheme; workspaceId?: string; openAgent?: (id: string) => void;
}) {
  const read = useRpc(rosterRpc);
  const query = useQuery({
    queryKey: ["clyde", "roster", workspaceId ?? "all"],
    queryFn: () => read({ workspaceId }),
    refetchInterval: 10000,
  });
  return (
    <View style={{ gap: 10 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 18 }}>Agents</Text>
      {query.isPending && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Loading agents…</Text>}
      {query.error && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{formatRpcError(query.error)}</Text>}
      {query.data?.length === 0 && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Open a project chat to add an agent.</Text>}
      {query.data?.map(agent => (
        <Row key={agent.id} agent={agent} theme={theme} openAgent={openAgent} refresh={() => void query.refetch()} />
      ))}
    </View>
  );
}
