import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Lockup, scheme } from "./brand";
import { palette } from "./brand.generated";
import type { Activity } from "../shared/clyde";

export type Packet = Extract<Activity, { kind: "recall" }>;
export type Vote = "helpful" | "nothing_useful";
export function RecallSheet(
  { theme, packet, onVote }: {
    theme: PluginTheme;
    packet: Packet;
    onVote?: (v: Vote) => Promise<{ pendingSync?: boolean }>;
  },
) {
  const p = palette[scheme(theme)];
  const [open, setOpen] = useState(true),
    [pending, setPending] = useState(false),
    [selected, setSelected] = useState<Vote>(),
    [error, setError] = useState("");
  const [queued, setQueued] = useState(packet.pendingSync ?? false);
  const choice = selected ?? packet.choice;
  async function vote(value: Vote) {
    if (!onVote || pending || choice === value) return;
    setPending(true);
    try {
      const result = await onVote(value);
      setQueued(result?.pendingSync ?? false);
      setSelected(value);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  const action = (label: string, value: Vote) => {
    const active = choice === value;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active, disabled: pending }}
        disabled={pending}
        onPress={() => void vote(value)}
        style={({ pressed }) => ({
          borderWidth: 1,
          borderRadius: 5,
          borderColor: active ? p.carbon : p.edge,
          backgroundColor: active ? p["carbon-wash"] : pressed ? p["paper-2"] : p["paper-1"],
          paddingHorizontal: 12,
          paddingVertical: 7,
        })}
      >
        <Text style={{ fontWeight: "600", fontSize: 13, color: active ? p["carbon-ink"] : p.ink }}>
          {active ? "✓ " : ""}
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View style={{ width: "100%", maxWidth: 700, alignSelf: "flex-start", paddingRight: 3, paddingBottom: 3 }}>
      <View
        style={{
          position: "absolute",
          top: 3,
          bottom: 0,
          left: 3,
          right: 0,
          borderRadius: 9,
          backgroundColor: p["carbon-copy"],
        }}
      />
      <View
        style={{
          backgroundColor: p["paper-1"],
          borderRadius: 9,
          borderWidth: 1,
          borderColor: p["rule-strong"],
          overflow: "hidden",
        }}
      >
        <View style={{ height: 4, backgroundColor: p["sticky-strip"] }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? "Collapse recall" : "Expand recall"}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 15,
            paddingVertical: 10,
            gap: 12,
            flexWrap: "wrap",
            backgroundColor: p.sticky,
          }}
        >
          <Lockup theme={theme} width={76} />
          <Text style={{ flexGrow: 1, color: p["ink-2"], fontFamily: "Menlo", fontSize: 11, fontWeight: "600" }}>
            RECALL · {packet.notes.length} {packet.notes.length === 1 ? "NOTE" : "NOTES"}
          </Text>
          <Text style={{ color: p.ink }}>{open ? "▴" : "▾"}</Text>
        </Pressable>
        {open && (
          <View style={{ paddingHorizontal: 15, paddingTop: 3, paddingBottom: 4, backgroundColor: p["paper-0"] }}>
            {packet.query && (
              <Text numberOfLines={2} style={{ paddingVertical: 9, color: p["ink-2"], fontSize: 13 }}>
                “{packet.query}”
              </Text>
            )}
            {!packet.notes.length && (
              <Text style={{ color: p["ink-2"], paddingVertical: 14 }}>Nothing in Clyde matches that yet.</Text>
            )}
            {packet.notes.map((n) => (
              <View
                key={n.id}
                style={{
                  backgroundColor: p["paper-1"],
                  borderWidth: 1,
                  borderColor: p.rule,
                  borderRadius: 6,
                  padding: 12,
                  marginVertical: 4,
                  gap: 4,
                }}
              >
                {n.kind && (
                  <Text style={{ color: p["carbon-ink"], fontFamily: "Menlo", fontSize: 10, letterSpacing: 1 }}>
                    {n.kind.toUpperCase()}
                  </Text>
                )}
                <Text style={{ color: p.ink, fontSize: 16, fontWeight: "700", lineHeight: 21 }}>{n.title}</Text>
                {n.body && <Text style={{ color: p["ink-2"], fontSize: 14, lineHeight: 21 }}>{n.body}</Text>}
                {n.provenance && (
                  <Text style={{ color: p["ink-3"], fontSize: 11, lineHeight: 16 }}>{n.provenance}</Text>
                )}
              </View>
            ))}
          </View>
        )}
        {onVote && (
          <View
            style={{
              paddingHorizontal: 15,
              paddingVertical: 10,
              borderTopWidth: 1,
              borderColor: p.rule,
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 7,
            }}
          >
            {action("That helped", "helpful")}
            {action("That didn’t", "nothing_useful")}
            {(pending || choice) && (
              <Text accessibilityLiveRegion="polite" style={{ color: p["ink-3"], fontSize: 12 }}>
                {pending
                  ? "Saving…"
                  : (packet.choice === choice ? packet.pendingSync : queued)
                  ? "Saved on this host"
                  : "Feedback recorded"}
              </Text>
            )}
          </View>
        )}
        {!!error && (
          <Text accessibilityRole="alert" style={{ color: p.bad, paddingHorizontal: 15, paddingBottom: 10 }}>
            {error}
          </Text>
        )}
      </View>
    </View>
  );
}
