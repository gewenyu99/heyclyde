import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { RecallSheet } from "./recall-sheet";
import { clydeTheme, Lockup } from "./brand";
import { formatRpcError, MIN_HIT_HEIGHT, MIN_LOCKUP_WIDTH } from "./palette";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { type Activity, feedbackRpc, ratingRpc, readNoteRpc, respondRpc } from "../shared/clyde";

export function InlineActivity({ agentId, item, theme }: PluginTimelineItemProps<Activity>) {
  const data = item.data, c = clydeTheme(theme).colors, feedback = useRpc(feedbackRpc), respond = useRpc(respondRpc);
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const readNote = useRpc(readNoteRpc);
  const rating = useRpc(ratingRpc), cache = useQueryClient();
  const rid = data.kind === "recall" ? data.retrieval : "";
  const key = ["clyde", "rating", agentId, rid];
  const local = useQuery({
    queryKey: key,
    queryFn: () => rating({ agent: agentId, retrieval: rid }),
    enabled: data.kind === "recall" && data.notes.length > 0,
    staleTime: 60000,
    refetchInterval: (q) =>
      q.state.data?.pendingSync ? 60000 : data.kind === "recall" && data.native && !q.state.data?.used ? 15000 : false,
  });
  if (data.kind === "recall" && !data.notes.length && !data.requested) return null;
  if (data.kind === "recall") {
    const canVote = !data.native || Boolean(data.receipt);
    return (
      <RecallSheet
        onOpen={(id) => readNote({ agent: agentId, id }).then((r) => r.text)}
        theme={theme}
        packet={{ ...data, ...(local.data?.choice ? local.data : {}), used: data.used ?? local.data?.used }}
        onVote={canVote ? async (verdict) => {
          const result = await feedback({ agent: agentId, retrieval: rid, verdict, receipt: data.receipt });
          cache.setQueryData(key, { choice: verdict, pendingSync: result.pendingSync });
          return result;
        } : undefined}
      />
    );
  }

  async function submit(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setError("");
    } catch (err) {
      setError(formatRpcError(err));
    } finally {
      setBusy(false);
    }
  }
  const button = (label: string, onPress: () => void, active = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={{
        minHeight: MIN_HIT_HEIGHT,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: active ? c.accent : c.border,
        borderRadius: 6,
      }}
    >
      <Text style={{ color: active ? c.accent : c.foreground, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: data.kind === "approval" ? c.statusWarning : c.accent,
        paddingLeft: 12,
        paddingVertical: 5,
        gap: 7,
      }}
    >
      {data.kind === "notice"
        ? <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{data.text}</Text>
        : data.kind === "saved"
        ? <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Saved to Clyde · {data.title}</Text>
        : (
          <>
            <Lockup theme={theme} width={MIN_LOCKUP_WIDTH} />
            <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 14 }}>{data.title}</Text>
            <Text style={{ color: c.foreground, fontSize: 13 }}>{data.question}</Text>
            {data.answer ? <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Answered · {data.answer}</Text> : (
              <>
                <TextInput
                  accessibilityLabel="Reply to Clyde"
                  placeholder="Reply or request changes"
                  placeholderTextColor={c.foregroundMuted}
                  value={text}
                  onChangeText={setText}
                  style={{ padding: 10, minHeight: MIN_HIT_HEIGHT, borderWidth: 1, borderColor: c.border, borderRadius: 6, color: c.foreground, backgroundColor: c.surface1, fontSize: 14 }}
                />
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {data.approve && button(
                    "Approve",
                    () =>
                      void submit(() => respond({ agent: agentId, run: data.run, key: data.key, text: "approved" })),
                    true,
                  )}
                  {text.trim().length > 0 &&
                    button(
                      "Send reply",
                      () => void submit(() => respond({ agent: agentId, run: data.run, key: data.key, text })),
                    )}
                </View>
              </>
            )}
          </>
        )}
      {error.length > 0 && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13 }}>{error}</Text>}
    </View>
  );
}
