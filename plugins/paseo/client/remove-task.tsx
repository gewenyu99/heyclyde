import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { removeRpc } from "../shared/clyde";

export function RemoveTask(
  { theme, kind, id, active, name, onRemoved }: {
    theme: PluginTheme;
    kind: "run" | "thread";
    id: string;
    active: boolean;
    name: string;
    onRemoved?: () => void;
  },
) {
  const remove = useRpc(removeRpc), cache = useQueryClient(), lock = useRef(false);
  const [armed, setArmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function confirm() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await remove({ kind, id });
      await cache.invalidateQueries({ queryKey: ["clyde"] });
      onRemoved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const c = theme.colors;
  return (
    <View style={{ alignItems: "flex-end", gap: 4 }}>
      {armed
        ? (
          <View style={{ flexDirection: "row", gap: 9, alignItems: "center" }}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => setArmed(false)}>
              <Text style={{ fontSize: 12, color: c.foregroundMuted }}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void confirm()}
              style={{ padding: 6, borderRadius: 5, borderColor: c.statusDanger, borderWidth: 1 }}
            >
              <Text style={{ fontSize: 12, color: c.statusDanger, fontWeight: "600" }}>
                {busy ? "Removing…" : active ? "Stop and remove" : "Remove task"}
              </Text>
            </Pressable>
          </View>
        )
        : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={"Remove task " + name}
            onPress={() => setArmed(true)}
            style={{ padding: 8 }}
          >
            <Icon icon="Trash2" size={16} color={c.foregroundMuted} />
          </Pressable>
        )}
      {!!error && <Text style={{ color: c.statusDanger }}>{error}</Text>}
    </View>
  );
}
