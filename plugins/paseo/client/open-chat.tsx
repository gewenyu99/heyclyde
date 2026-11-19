import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openChatRpc } from "../shared/clyde";
import { palette } from "./brand.generated";
import { formatRpcError, MIN_HIT_HEIGHT, scheme } from "./palette";

export function OpenChatButton({
  theme,
  kind,
  id,
  openAgent,
  label = "Open chat",
  onError,
}: {
  theme: PluginTheme;
  kind: "run" | "thread";
  id: string;
  openAgent?: (id: string) => void;
  label?: string;
  onError?: (error: string) => void;
}) {
  const openChat = useRpc(openChatRpc);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  if (!openAgent) return null;
  const press = async () => {
    if (busy) return;
    setBusy(true);
    setLocalError("");
    onError?.("");
    try {
      const { agentId } = await openChat({ kind, id });
      openAgent(agentId);
    } catch (err) {
      const message = formatRpcError(err);
      if (onError) onError(message);
      else setLocalError(message);
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={() => void press()}
      style={{
        borderWidth: 1,
        borderColor: palette[scheme(theme)].edge,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        minHeight: MIN_HIT_HEIGHT,
        justifyContent: "center",
        paddingHorizontal: 14,
      }}
    >
      <Text style={{ color: busy ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {busy ? "Opening chat…" : label}
      </Text>
    </Pressable>
  );
  if (!onError && localError) {
    return (
      <View>
        {button}
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 12, marginTop: 4 }}>{localError}</Text>
      </View>
    );
  }
  return button;
}
