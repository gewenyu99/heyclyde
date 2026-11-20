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

export type TimelineItem = {
  type: string;
  text?: string;
  message?: string;
  level?: string;
  name?: string;
  callId?: string;
  messageId?: string;
  status?: string;
  detail?: Record<string, unknown>;
  items?: { text: string; completed?: boolean; status?: string; activeForm?: string }[];
  kind?: string;
  data?: Record<string, unknown>;
};

export type TimelineEntry = {
  seqStart?: number;
  turnId?: string;
  item: TimelineItem;
};

/** Merge a streamed text chunk (either cumulative snapshot or incremental delta) without clobbering prior text. */
export function mergeStreamText(prev: string, incoming: string): string {
  if (!prev) return incoming;
  if (!incoming || incoming === prev) return prev;
  if (incoming.startsWith(prev)) return incoming;
  if (prev.startsWith(incoming) && incoming.length > 24) return prev;
  return prev + incoming;
}

/** Apply one live Paseo timeline stream event cleanly, merging deltas and coalescing consecutive reasoning/assistant chunks. */
export function applyTimelineEvent(
  prev: TimelineEntry[],
  event: { type: string; turnId?: string; item?: TimelineItem },
): TimelineEntry[] {
  if (event.type !== "timeline" || !event.item) return prev;
  const item = event.item;
  if (item.type === "tool_call" && item.callId) {
    const idx = prev.findIndex((e) => e.item.type === "tool_call" && e.item.callId === item.callId);
    if (idx >= 0) {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], item: { ...copy[idx].item, ...item } };
      return copy;
    }
  }
  if ((item.type === "assistant_message" || item.type === "reasoning") && prev.length > 0) {
    const last = prev[prev.length - 1];
    const sameTurn = !event.turnId || !last.turnId || last.turnId === event.turnId;
    const sameMsg = !item.messageId || !last.item.messageId || last.item.messageId === item.messageId;
    if (last.item.type === item.type && sameTurn && sameMsg) {
      const mergedText = mergeStreamText(last.item.text ?? "", item.text ?? "");
      const copy = [...prev];
      copy[copy.length - 1] = {
        ...last,
        turnId: event.turnId ?? last.turnId,
        item: { ...last.item, ...item, text: mergedText },
      };
      return copy;
    }
  }
  return [...prev.slice(-120), { turnId: event.turnId, item }];
}

/** Coalesce adjacent reasoning blocks from stored timeline pages so thinking never stacks into repeated rows. */
export function normalizeTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    const item = entry.item;
    if (item.type === "reasoning") {
      const text = (item.text ?? "").trim();
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.item.type === "reasoning") {
        const prevText = (last.item.text ?? "").trim();
        last.item = {
          ...last.item,
          text: prevText === text ? prevText : text.startsWith(prevText) ? text : `${prevText}\n\n${text}`,
        };
        continue;
      }
      out.push({ ...entry, item: { ...item, text } });
      continue;
    }
    if (item.type === "assistant_message" && !item.text?.trim()) continue;
    out.push(entry);
  }
  return out;
}

/** Extract a concise 1-line summary from a reasoning block instead of showing opaque "Thinking…". */
export function reasoningHeadline(text: string): string {
  const cleaned = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^[\s#>*`_-]+/, "").replace(/\*\*/g, "").trim())
    .find(Boolean) ?? "";
  if (!cleaned) return "Working through the next step";
  const cut = cleaned.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? cleaned;
  return cut.length > 72 ? cut.slice(0, 71) + "…" : cut;
}

export type DisplayBlock =
  | { kind: "message"; entry: TimelineEntry; index: number }
  | { kind: "activity"; items: TimelineEntry[]; index: number; live: boolean };

/** Group consecutive reasoning, tool calls, and todo updates between chat messages into tight collapsible step groups. */
export function groupTimelineBlocks(entries: TimelineEntry[], isRunning: boolean): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  let pending: TimelineEntry[] = [];
  const flush = (live: boolean) => {
    if (!pending.length) return;
    blocks.push({ kind: "activity", items: pending, index: blocks.length, live });
    pending = [];
  };
  entries.forEach((entry, idx) => {
    const t = entry.item.type;
    if (t === "reasoning" || t === "tool_call" || t === "todo") {
      pending.push(entry);
    } else {
      flush(false);
      blocks.push({ kind: "message", entry, index: idx });
    }
  });
  flush(isRunning);
  return blocks;
}

function safeClip(value: unknown, max: number): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  } catch {
    return "";
  }
}

export function formatToolSummary(item: TimelineItem): { line: string; body?: string } {
  const detail = item.detail ?? {};
  const type = typeof detail.type === "string" ? detail.type : "";
  if (type === "shell" || item.name?.toLowerCase() === "bash") {
    const rawCmd = typeof detail.command === "string"
      ? detail.command
      : typeof (detail.input as Record<string, unknown> | undefined)?.command === "string"
      ? String((detail.input as Record<string, unknown>).command)
      : item.name || "shell";
    const desc = typeof (detail.input as Record<string, unknown> | undefined)?.description === "string"
      ? String((detail.input as Record<string, unknown>).description).trim()
      : "";
    const shortCmd = rawCmd.replace(/^cd\s+\S+\s*&&\s*/, "").replace(/\s+/g, " ").trim();
    const out = typeof detail.output === "string"
      ? detail.output
      : typeof detail.stdout === "string"
      ? detail.stdout
      : undefined;
    const bodyParts = [`$ ${rawCmd}`];
    if (out?.trim()) bodyParts.push(out.trim().slice(0, 1400));
    return { line: desc || `$ ${shortCmd}`, body: bodyParts.join("\n\n") };
  }
  const rawName = item.name || "tool";
  const niceName = rawName
    .replace(/^mcp__paseo__clyde_/, "clyde · ")
    .replace(/^mcp__memory__/, "memory · ")
    .replace(/^mcp__([^_]+)__/, "$1 · ");
  if (type === "plain_text") {
    const label = typeof detail.label === "string" ? detail.label : niceName;
    const text = typeof detail.text === "string" ? detail.text : undefined;
    return { line: label, body: text?.trim() ? text.slice(0, 1200) : undefined };
  }
  const input = detail.input !== undefined ? safeClip(detail.input, 400) : undefined;
  const output = detail.output !== undefined ? safeClip(detail.output, 800) : undefined;
  return {
    line: niceName,
    body: [input ? `in: ${input}` : "", output ? `out: ${output}` : ""].filter(Boolean).join("\n") || undefined,
  };
}

function ToolRow({ theme, item }: { theme: PluginTheme; item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const t = tones(theme);
  const { line, body } = formatToolSummary(item);
  const glyph = item.status === "completed" ? "✓" : item.status === "failed" ? "✕" : item.status === "canceled" ? "–" : "●";
  const ink = item.status === "completed" ? t.green.ink : item.status === "failed" ? t.red.ink : t.blue.ink;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        disabled={!body}
        onPress={() => body && setOpen(!open)}
        style={{ minHeight: MIN_HIT_HEIGHT, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}
      >
        <Text style={{ color: ink, fontFamily: "Menlo", fontSize: 12, fontWeight: "700" }}>{glyph}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, minWidth: 0, color: c.foregroundMuted, fontFamily: "Menlo", fontSize: 12 }}>
          {line}
        </Text>
        {!!body && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{open ? "▴" : "▾"}</Text>}
      </Pressable>
      {open && body ? (
        <Text selectable style={{ color: c.foreground, backgroundColor: c.surface0, padding: 8, borderRadius: 6, fontFamily: "Menlo", fontSize: 12, lineHeight: 17 }}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

function ReasoningRow({ theme, text, live }: { theme: PluginTheme; text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const t = tones(theme);
  const headline = reasoningHeadline(text);
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ minHeight: MIN_HIT_HEIGHT, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}
      >
        <Text style={{ color: live ? t.blue.ink : c.foregroundMuted, fontFamily: "Menlo", fontSize: 12, fontWeight: "700" }}>
          {live ? "●" : open ? "▾" : "▸"}
        </Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, minWidth: 0, color: live ? c.foreground : c.foregroundMuted, fontSize: 12 }}>
          <Text style={{ fontWeight: "700" }}>{live ? "Thinking · " : "Thought · "}</Text>
          {headline}
        </Text>
      </Pressable>
      {open ? (
        <Text selectable style={{ color: c.foregroundMuted, backgroundColor: c.surface0, padding: 8, borderRadius: 6, fontSize: 12, lineHeight: 18 }}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

function ActivityGroup({ theme, items, live }: { theme: PluginTheme; items: TimelineEntry[]; live: boolean }) {
  const [expanded, setExpanded] = useState(live);
  const c = theme.colors;
  const t = tones(theme);
  const tools = items.filter((e) => e.item.type === "tool_call");
  const thoughts = items.filter((e) => e.item.type === "reasoning");
  const failed = tools.some((e) => e.item.status === "failed");
  const runningTool = tools.findLast((e) => e.item.status === "running");
  const latestThought = thoughts.at(-1);
  const showBody = live || expanded;

  const counts = [
    tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : "",
    thoughts.length ? `${thoughts.length} thought${thoughts.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");
  const summary = runningTool
    ? `Running ${formatToolSummary(runningTool.item).line}`
    : live && latestThought?.item.text
    ? `Thinking · ${reasoningHeadline(latestThought.item.text)}`
    : counts
    ? `Activity · ${counts}`
    : "Activity";

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: failed ? t.red.ink : live ? t.blue.ink : c.border,
        borderLeftWidth: 3,
        borderLeftColor: failed ? t.red.ink : live ? t.blue.ink : t.green.ink,
        borderRadius: 6,
        backgroundColor: c.surface2,
        paddingHorizontal: 8,
        paddingVertical: 2,
        overflow: "hidden",
      }}
    >
      {!live && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showBody }}
          onPress={() => setExpanded(!expanded)}
          style={{ minHeight: MIN_HIT_HEIGHT, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}
        >
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, minWidth: 0, color: failed ? t.red.ink : c.foregroundMuted, fontFamily: "Menlo", fontSize: 12, fontWeight: "600" }}>
            {failed ? "✕ " : "✓ "}{summary}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{showBody ? "▴" : "▾"}</Text>
        </Pressable>
      )}
      {showBody && (
        <View style={{ gap: 2, paddingBottom: 4 }}>
          {items.map((entry, idx) => {
            const { item } = entry;
            if (item.type === "tool_call") return <ToolRow key={item.callId || idx} theme={theme} item={item} />;
            if (item.type === "reasoning" && item.text?.trim()) {
              return <ReasoningRow key={idx} theme={theme} text={item.text} live={live && idx === items.length - 1} />;
            }
            if (item.type === "todo" && item.items?.length) {
              return (
                <View key={idx} style={{ backgroundColor: c.surface0, borderRadius: 6, padding: 8, gap: 3, marginVertical: 2 }}>
                  {item.items.map((todo, j) => (
                    <Text key={j} numberOfLines={1} ellipsizeMode="tail" style={{ color: todo.completed || todo.status === "completed" ? t.green.ink : c.foregroundMuted, fontFamily: "Menlo", fontSize: 12 }}>
                      {todo.completed || todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"} {todo.activeForm || todo.text}
                    </Text>
                  ))}
                </View>
              );
            }
            return null;
          })}
        </View>
      )}
    </View>
  );
}

export function AttachedChat({
  theme,
  runId,
  agentId,
  agentLabel,
  placeholder,
  emptyHint,
  openAgent,
  showPermissions = false,
  expectedPermission = false,
  onPendingPermission,
}: {
  theme: PluginTheme;
  runId: string;
  agentId: string;
  agentLabel?: string;
  placeholder?: string;
  emptyHint?: string;
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
  const lastStreamAt = useRef(0);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    if (!paseo || !agentId) {
      setLoading(false);
      return;
    }
    let alive = true;
    const handle = paseo.agents.ref(agentId);
    let unsub: (() => void) | undefined;

    async function load(forceTimeline = false) {
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
        // Avoid overwriting active incremental stream deltas with an older stored snapshot mid-turn.
        if (!forceTimeline && Date.now() - lastStreamAt.current < 3500) return;
        const page = await handle.timeline.refetch({ direction: "tail", limit: 40, wholeTurns: true });
        if (alive) {
          setEntries(normalizeTimeline((page.entries ?? []) as TimelineEntry[]));
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

    void load(true);
    try {
      const sub = handle.timeline.subscribe((payload) => {
        const { agentId: evAgent, event } = payload as { agentId: string; event: { type: string; turnId?: string; item?: TimelineItem } };
        if (!alive || evAgent !== agentId) return;
        if (event.type === "timeline" && event.item) {
          lastStreamAt.current = Date.now();
          setEntries((prev) => applyTimelineEvent(prev, event));
          setLoading(false);
        } else if (event.type === "turn_started") {
          setAgentMeta((prev) => ({ ...prev, status: "running" }));
        } else if (["turn_completed", "turn_failed", "turn_canceled"].includes(event.type)) {
          lastStreamAt.current = 0;
          void load(true);
        }
      });
      unsub = typeof sub === "function" ? sub : undefined;
    } catch { /* Fall back to polling if subscribe is unavailable. */ }

    const poll = setInterval(() => {
      void load(false);
    }, 5000);

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
  const blocks = groupTimelineBlocks(entries, running);

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
            Live Paseo transcript attaches inside the Paseo desktop app.
          </Text>
        ) : !blocks.length ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
            {emptyHint || "No messages in this Paseo chat yet."}
          </Text>
        ) : (
          blocks.map((block) => {
            if (block.kind === "activity") {
              return <ActivityGroup key={`act-${block.index}`} theme={theme} items={block.items} live={block.live} />;
            }
            const { item } = block.entry;
            if (item.type === "user_message" && item.text?.trim()) {
              return (
                <View key={`msg-${block.index}`} style={{ padding: 10, gap: 4, borderRadius: 6, backgroundColor: c.surface2 }}>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: c.foregroundMuted }}>You</Text>
                  <Text selectable style={{ fontSize: 13, lineHeight: 20, color: c.foreground }}>{item.text}</Text>
                </View>
              );
            }
            if (item.type === "assistant_message" && item.text?.trim()) {
              return (
                <View key={`msg-${block.index}`} style={{ padding: 10, gap: 4, borderRadius: 6, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border }}>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: c.foregroundMuted }}>{agentLabel || "Agent"}</Text>
                  <Markdown>{item.text}</Markdown>
                </View>
              );
            }
            if (item.type === "error" && item.message) {
              return (
                <Text key={`err-${block.index}`} accessibilityRole="alert" selectable style={{ color: c.statusDanger, fontFamily: "Menlo", fontSize: 12, lineHeight: 18 }}>
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
            placeholder={placeholder || "Message this Paseo chat…"}
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
