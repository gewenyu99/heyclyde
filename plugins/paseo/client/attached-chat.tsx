import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { formatRpcError, MIN_HIT_HEIGHT, tones } from "./palette";
import { WorkerPermissions } from "./worker-permissions";

function useOptionalPaseo() {
  try {
    return usePaseo();
  } catch {
    return null;
  }
}

type TimelineEntry = {
  seqStart?: number;
  turnId?: string;
  item: {
    type: string;
    text?: string;
    message?: string;
    level?: string;
    name?: string;
    callId?: string;
    status?: string;
    detail?: Record<string, unknown>;
    items?: { text: string; completed?: boolean; status?: string; activeForm?: string }[];
    kind?: string;
    data?: Record<string, unknown>;
  };
};

function toolSummary(item: TimelineEntry["item"]): { line: string; body?: string } {
  const detail = item.detail ?? {};
  const type = typeof detail.type === "string" ? detail.type : "";
  if (type === "shell" || item.name?.toLowerCase() === "bash") {
    const cmd = typeof detail.command === "string"
      ? detail.command
      : typeof (detail.input as Record<string, unknown> | undefined)?.command === "string"
      ? String((detail.input as Record<string, unknown>).command)
      : item.name || "shell";
    const out = typeof detail.output === "string"
      ? detail.output
      : typeof detail.stdout === "string"
      ? detail.stdout
      : undefined;
    return { line: `$ ${cmd}`, body: out?.trim() ? out.slice(0, 1200) : undefined };
  }
  if (type === "plain_text") {
    const label = typeof detail.label === "string" ? detail.label : item.name || "tool";
    const text = typeof detail.text === "string" ? detail.text : undefined;
    return { line: label, body: text?.trim() ? text.slice(0, 1200) : undefined };
  }
  const input = detail.input !== undefined ? safeClip(detail.input, 400) : undefined;
  const output = detail.output !== undefined ? safeClip(detail.output, 800) : undefined;
  return {
    line: item.name || "tool",
    body: [input ? `in: ${input}` : "", output ? `out: ${output}` : ""].filter(Boolean).join("\n") || undefined,
  };
}

function safeClip(value: unknown, max: number): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  } catch {
    return "";
  }
}

function ToolRow({ theme, item }: { theme: PluginTheme; item: TimelineEntry["item"] }) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const t = tones(theme);
  const { line, body } = toolSummary(item);
  const glyph = item.status === "completed" ? "✓" : item.status === "failed" ? "✕" : item.status === "canceled" ? "–" : "●";
  const ink = item.status === "completed" ? t.green.ink : item.status === "failed" ? t.red.ink : t.blue.ink;
  return (
    <View style={{ borderLeftWidth: 2, borderLeftColor: ink, paddingLeft: 8, paddingVertical: 3, gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        disabled={!body}
        onPress={() => body && setOpen(!open)}
        style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
      >
        <Text numberOfLines={open ? undefined : 2} style={{ color: c.foregroundMuted, fontFamily: "Menlo", fontSize: 12, lineHeight: 17 }}>
          <Text style={{ color: ink, fontWeight: "700" }}>{glyph} </Text>
          {line}
          {body ? (open ? " ▴" : " ▾") : ""}
        </Text>
      </Pressable>
      {open && body ? (
        <Text selectable style={{ color: c.foreground, backgroundColor: c.surface0, padding: 8, borderRadius: 6, fontFamily: "Menlo", fontSize: 12, lineHeight: 17 }}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

function ReasoningRow({ theme, text }: { theme: PluginTheme; text: string }) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  return (
    <View style={{ paddingLeft: 6, gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
        <Text style={{ color: c.foregroundMuted, fontFamily: "Menlo", fontSize: 12 }}>
          {open ? "▾ Thinking" : "▸ Thinking…"}
        </Text>
      </Pressable>
      {open ? <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{text}</Text> : null}
    </View>
  );
}

export function AttachedChat({
  theme,
  runId,
  agentId,
  agentLabel,
  openAgent,
  showPermissions = false,
  expectedPermission = false,
  onPendingPermission,
}: {
  theme: PluginTheme;
  runId: string;
  agentId: string;
  agentLabel?: string;
  openAgent?: (id: string) => void;
  showPermissions?: boolean;
  expectedPermission?: boolean;
  onPendingPermission?: (id: string | null | undefined) => void;
}) {
  const c = theme.colors;
  const t = tones(theme);
  const paseo = useOptionalPaseo();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [agentMeta, setAgentMeta] = useState<{ status?: string; model?: string; provider?: string; title?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    if (!paseo || !agentId) {
      setLoading(false);
      return;
    }
    let alive = true;
    const handle = paseo.agents.ref(agentId);
    let unsub: (() => void) | undefined;

    async function load() {
      try {
        await handle.refresh();
        const cur = handle.current();
        if (alive && cur) {
          setAgentMeta({
            status: cur.status,
            model: cur.model ?? undefined,
            provider: cur.provider,
            title: cur.title ?? undefined,
          });
        }
        const page = await handle.timeline.refetch({ direction: "tail", limit: 40, wholeTurns: true });
        if (alive) {
          setEntries((page.entries ?? []) as TimelineEntry[]);
          setError("");
          setLoading(false);
        }
      } catch (err) {
        if (alive) {
          setError(formatRpcError(err));
          setLoading(false);
        }
      }
    }

    void load();
    try {
      const sub = handle.timeline.subscribe((payload) => {
        const { agentId: evAgent, event } = payload as { agentId: string; event: { type: string; turnId?: string; item?: TimelineEntry["item"] } };
        if (!alive || evAgent !== agentId) return;
        if (event.type === "timeline" && event.item) {
          setEntries((prev) => {
            const item = event.item!;
            if (item.type === "tool_call" && item.callId) {
              const idx = prev.findIndex((e) => e.item.type === "tool_call" && e.item.callId === item.callId);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], item };
                return copy;
              }
            }
            if (item.type === "assistant_message" && prev.length > 0 && prev[prev.length - 1].item.type === "assistant_message" && prev[prev.length - 1].turnId === event.turnId) {
              const copy = [...prev];
              copy[copy.length - 1] = { ...copy[copy.length - 1], item };
              return copy;
            }
            return [...prev.slice(-120), { turnId: event.turnId, item }];
          });
        } else if (["turn_started", "turn_completed", "turn_failed", "turn_canceled"].includes(event.type)) {
          void load();
        }
      });
      unsub = typeof sub === "function" ? sub : undefined;
    } catch { /* Fall back to polling if subscribe is unavailable. */ }

    const poll = setInterval(() => {
      void load();
    }, 4000);

    return () => {
      alive = false;
      clearInterval(poll);
      try { unsub?.(); } catch { /* ignore */ }
    };
  }, [paseo, agentId]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || !paseo || !agentId) return;
    setSending(true);
    setError("");
    try {
      await paseo.agents.ref(agentId).send(text);
      setDraft("");
    } catch (err) {
      setError(formatRpcError(err));
    } finally {
      setSending(false);
    }
  }

  const running = agentMeta?.status === "running";
  const statusHue = running ? t.blue : t.green;
  const headerSub = [agentMeta?.provider, agentMeta?.model].filter(Boolean).join(" / ") || agentLabel || agentId.slice(0, 8);

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusHue.ink }} />
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontFamily: "Menlo", fontSize: 12, flexShrink: 1 }}>
            {headerSub}
          </Text>
        </View>
        {openAgent && (
          <Pressable
            accessibilityRole="button"
            onPress={() => openAgent(agentId)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 8 }}
          >
            <Text style={{ color: c.accent, fontSize: 12, fontWeight: "700" }}>Open full Paseo chat ↗</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        ref={scroll}
        nestedScrollEnabled
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {loading && !entries.length ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Connecting to live Paseo chat…</Text>
        ) : !paseo ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
            Live Paseo transcript attaches inside the Paseo desktop app. Use Ask Clyde or open the agent directly.
          </Text>
        ) : !entries.length ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>No messages in this Paseo chat yet.</Text>
        ) : (
          entries.map((entry, idx) => {
            const { item } = entry;
            if (item.type === "user_message" && item.text?.trim()) {
              return (
                <View key={idx} style={{ padding: 10, gap: 4, borderRadius: 6, backgroundColor: c.surface2 }}>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: c.foregroundMuted }}>You</Text>
                  <Text selectable style={{ fontSize: 13, lineHeight: 20, color: c.foreground }}>{item.text}</Text>
                </View>
              );
            }
            if (item.type === "assistant_message" && item.text?.trim()) {
              return (
                <View key={idx} style={{ padding: 10, gap: 4, borderRadius: 6, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border }}>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: c.foregroundMuted }}>{agentLabel || "Agent"}</Text>
                  <Markdown>{item.text}</Markdown>
                </View>
              );
            }
            if (item.type === "tool_call") {
              return <ToolRow key={item.callId || idx} theme={theme} item={item} />;
            }
            if (item.type === "reasoning" && item.text?.trim()) {
              return <ReasoningRow key={idx} theme={theme} text={item.text} />;
            }
            if (item.type === "todo" && item.items?.length) {
              return (
                <View key={idx} style={{ backgroundColor: c.surface0, borderRadius: 6, padding: 8, gap: 3 }}>
                  {item.items.map((todo, j) => (
                    <Text key={j} style={{ color: todo.completed || todo.status === "completed" ? t.green.ink : c.foregroundMuted, fontFamily: "Menlo", fontSize: 12 }}>
                      {todo.completed || todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"} {todo.activeForm || todo.text}
                    </Text>
                  ))}
                </View>
              );
            }
            if (item.type === "error" && item.message) {
              return (
                <Text key={idx} accessibilityRole="alert" selectable style={{ color: c.statusDanger, fontFamily: "Menlo", fontSize: 12, lineHeight: 18 }}>
                  ✕ {item.message}
                </Text>
              );
            }
            return null;
          })
        )}
      </ScrollView>

      {showPermissions && (
        <WorkerPermissions
          key={runId}
          theme={theme}
          runId={runId}
          openAgent={openAgent}
          onPending={onPendingPermission ?? (() => {})}
          expected={expectedPermission}
          variant="chat"
        />
      )}

      {!!error && <Text accessibilityRole="alert" selectable style={{ fontSize: 13, color: c.statusDanger }}>{error}</Text>}

      {paseo && (
        <View style={{ gap: 6 }}>
          <TextInput
            multiline
            editable={!sending}
            maxLength={8000}
            accessibilityLabel="Message attached Paseo chat"
            value={draft}
            onChangeText={setDraft}
            placeholder="Message this Paseo chat…"
            placeholderTextColor={c.foregroundMuted}
            style={{
              minHeight: 48,
              maxHeight: 96,
              padding: 10,
              textAlignVertical: "top",
              color: c.foreground,
              fontSize: 14,
              backgroundColor: c.surface0,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 6,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: sending || !draft.trim() }}
            disabled={sending || !draft.trim()}
            onPress={() => void send()}
            style={{
              alignSelf: "flex-end",
              minHeight: MIN_HIT_HEIGHT,
              paddingHorizontal: 14,
              justifyContent: "center",
              backgroundColor: sending || !draft.trim() ? c.surface2 : c.accent,
              borderRadius: 6,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: sending || !draft.trim() ? c.foregroundMuted : c.accentForeground }}>
              {sending ? "Sending…" : "Send"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
