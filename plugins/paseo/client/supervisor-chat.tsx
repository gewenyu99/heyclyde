import type { PluginTheme } from "@getpaseo/plugin";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { askSupervisorRpc, supervisorRpc } from "../shared/clyde";
import { formatRpcError, MIN_HIT_HEIGHT } from "./palette";
import { requestId } from "./request-id";

export function SupervisorChat({ theme, runId, draft: savedDraft, onDraftChange }: { theme: PluginTheme; runId: string; draft?: string; onDraftChange?: (text:string)=>void }) {
  const c = theme.colors;
  const read = useRpc(supervisorRpc), ask = useRpc(askSupervisorRpc);
  const conversation = useQuery({
    queryKey: ["clyde", "supervisor", runId],
    queryFn: () => read({ id: runId }),
    refetchInterval: query => query.state.data?.busy ? 1200 : 5000,
  });
  const [localDraft, setLocalDraft] = useState("");
  const draft = savedDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const pending = useRef<{ text: string; id: string } | null>(null);
  const locked = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const state = conversation.data;
  const disabled = !state || state.busy || sending || !draft.trim();

  async function send() {
    if (disabled || locked.current) return;
    locked.current = true;
    setSending(true);
    setSendError("");
    const text = draft.trim();
    if (pending.current?.text !== text) pending.current = { text, id: requestId() };
    try {
      await ask({ id: runId, text, requestId: pending.current.id });
      setDraft("");
      pending.current = null;
      await conversation.refetch();
    } catch (err) {
      setSendError(formatRpcError(err));
    } finally {
      locked.current = false;
      setSending(false);
    }
  }

  const error = sendError || (conversation.error && formatRpcError(conversation.error)) || state?.error;
  return (
    <View style={{ flex: 1, minHeight: 0, padding: 14, gap: 8 }}>
      <Text accessibilityRole="header" style={{ fontSize: 21, color: c.foreground, fontWeight: "700" }}>Chat with Clyde</Text>
      <ScrollView ref={scroll} nestedScrollEnabled style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 10 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        {state?.messages.map((message, index) => (
          <View key={index} style={{ padding: 10, gap: 4, borderRadius: 6, backgroundColor: message.role === "user" ? c.surface2 : c.surface0 }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: c.foregroundMuted }}>{message.role === "user" ? "You" : "Clyde"}</Text>
            {message.role === "assistant"
              ? <Markdown>{message.text}</Markdown>
              : <Text selectable style={{ fontSize: 14, lineHeight: 21, color: c.foreground }}>{message.text}</Text>}
          </View>
        ))}
      </ScrollView>
      {(!state && !error || state?.busy) && <Text accessibilityLiveRegion="polite" style={{ fontSize: 13, color: c.foregroundMuted }}>
        {state?.busy ? "Clyde is reading the task…" : "Opening conversation…"}
      </Text>}
      {error && <Text accessibilityRole="alert" selectable style={{ fontSize: 13, color: c.statusDanger }}>{error}</Text>}
      <TextInput multiline editable={!sending} maxLength={8000} accessibilityLabel="Question about this task"
        value={draft} onChangeText={setDraft} placeholder="Ask about this task…" placeholderTextColor={c.foregroundMuted}
        style={{ minHeight: 52, maxHeight: 96, padding: 10, textAlignVertical: "top", color: c.foreground, fontSize: 14, backgroundColor: c.surface0,
          borderWidth: 1, borderColor: c.border, borderRadius: 6 }} />
      <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => void send()}
        style={{ alignSelf: "flex-end", minHeight: MIN_HIT_HEIGHT, paddingHorizontal: 14, justifyContent: "center",
          backgroundColor: disabled ? c.surface2 : c.accent, borderRadius: 6 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: disabled ? c.foregroundMuted : c.accentForeground }}>Ask Clyde</Text>
      </Pressable>
    </View>
  );
}
