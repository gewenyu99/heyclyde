import {RemoveTask} from "./remove-task";
import { OpenChatButton } from "./open-chat";
import {scheme} from "./brand";
import {palette} from "./brand.generated";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import { answerRpc, type Ask, type Home, type TaskCard } from "../shared/clyde";
import { ago, Eyebrow, hue, Pill } from "./nodes";
import { formatRpcError, MIN_HIT_HEIGHT, safeHttpsUrl, STATUS_LABEL, tones } from "./palette";

type OpenTask = (kind: TaskCard["kind"], id: string) => void;

function Section({ theme, title, count }: { theme: PluginTheme; title: string; count: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 28, marginBottom: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, letterSpacing: 1.0, fontWeight: "700" }}>{title}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{count}</Text>
    </View>
  );
}

function AskCard({ theme, ask, open, openAgent }: { theme: PluginTheme; ask: Ask; open: OpenTask; openAgent?: (id: string) => void }) {
  const send = useRpc(answerRpc);
  const client = useQueryClient();
  const [reply, setReply] = useState("");
  const [showPlan, setShowPlan] = useState(false);
  const [fullQuestion, setFullQuestion] = useState(false);
  const [state, setState] = useState<{ busy: boolean; note?: string; error?: string }>({ busy: false });
  const submit = async (text: string, allowAntigravityFullAccess = false) => {
    if (!text.trim() || state.busy) {
      setState({ busy: false, error: "Write a reply first." });
      return;
    }
    setState({ busy: true });
    const r = await send({ kind: ask.kind, id: ask.id, askKey: ask.askKey, allowAntigravityFullAccess, text: text.trim() }).catch((err: Error) => ({ ok: false, error: formatRpcError(err) }));
    if (r.ok) {
      setReply("");
      setState({ busy: false, note: "Sent." });
      void client.invalidateQueries({ queryKey: ["clyde"] });
    } else setState({ busy: false, error: r.error ? formatRpcError(r.error) : "Clyde didn't take it." });
  };
  const paper = palette[scheme(theme)];
  const t = tones(theme);
  const amber = hue("asking", theme);
  const approveDisabled = state.busy || !!reply.trim();
  const replyDisabled = state.busy || !reply.trim();
  return (
    <View style={{ borderWidth: 1, borderColor: paper["sticky-edge"], backgroundColor: paper.sticky, borderRadius: 10, padding: 16, marginBottom: 10 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => open(ask.kind, ask.id)}
          style={{ flex: 1, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, minHeight: MIN_HIT_HEIGHT }}
        >
          <Text style={{ color: paper.ink, fontWeight: "700", fontSize: 14, flexShrink: 1 }}>{ask.task}</Text>
          <Text style={{ color: amber.ink, fontSize: 12 }}>waiting {ago(ask.askedAt)}</Text>
        </Pressable>
        <RemoveTask kind={ask.kind} id={ask.id} active name={ask.task} theme={theme} />
      </View>
      {ask.blockedStage ? <Text style={{ color: paper["ink-2"], marginTop: 6, fontSize: 12 }}>Blocked stage · {ask.blockedStage}</Text> : null}
      <View style={{ borderLeftWidth: 2, borderLeftColor: amber.ink, paddingLeft: 10, marginVertical: 12 }}>
        <Text numberOfLines={fullQuestion || (ask.question.length <= 120 && !ask.question.includes("\n")) ? undefined : 3} style={{ color: paper.ink, fontWeight: "500", fontSize: 14 }}>{ask.question}</Text>
        {(ask.question.length > 120 || ask.question.includes("\n")) && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: fullQuestion }}
            onPress={() => setFullQuestion(!fullQuestion)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
          >
            <Text style={{ color: t.blue.ink, fontSize: 12, fontWeight: "600" }}>{fullQuestion ? "Show less" : "Read full question"}</Text>
          </Pressable>
        )}
      </View>
      {ask.plan?.length ? (
        <View style={{ marginBottom: 12, gap: 3 }}>
          <Text style={{ color: paper["ink-2"], fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>THE PLAN · {ask.plan.length} SLICES</Text>
          {ask.plan.slice(0, showPlan ? undefined : 6).map((line) => (
            <Text key={line} numberOfLines={1} style={{ color: paper.ink, fontSize: 12 }}>{line}</Text>
          ))}
          {ask.plan.length > 6 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showPlan }}
              onPress={() => setShowPlan(!showPlan)}
              style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text style={{ color: t.blue.ink, fontSize: 12, fontWeight: "600" }}>{showPlan ? "Show less" : `Show all ${ask.plan.length}`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {ask.retryable ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: state.busy }}
            disabled={state.busy}
            onPress={() => void submit("retry", ask.fullAccess)}
            style={{
              backgroundColor: state.busy ? theme.colors.surface2 : theme.colors.accent,
              borderWidth: state.busy ? 1 : 0,
              borderColor: paper.edge,
              borderRadius: 6,
              minHeight: MIN_HIT_HEIGHT,
              justifyContent: "center",
              paddingHorizontal: 14,
            }}
          >
            <Text style={{ color: state.busy ? theme.colors.foregroundMuted : theme.colors.accentForeground, fontWeight: "700", fontSize: 13 }}>
              {state.busy ? "Retrying…" : ask.fullAccess ? "Allow full access for this run and retry" : "Retry"}
            </Text>
          </Pressable>
          <OpenChatButton theme={theme} kind={ask.kind} id={ask.id} openAgent={openAgent} onError={(error) => setState((s) => ({ ...s, error: error || undefined }))} />
        </View>
      ) : (
        <>
          <Eyebrow theme={theme}>Reply</Eyebrow>
          <TextInput
            accessibilityLabel={ask.approve ? "Request a change" : "Reply to question"}
            value={reply}
            onChangeText={setReply}
            onSubmitEditing={() => { if (!replyDisabled) void submit(reply); }}
            placeholder={ask.approve ? "Request a change…" : "Reply…"}
            placeholderTextColor={paper["ink-3"]}
            style={{ borderWidth: 1, borderColor: paper.edge, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, marginTop: 4, minHeight: MIN_HIT_HEIGHT, fontSize: 14, color: theme.colors.foreground, backgroundColor: theme.colors.surface1 }}
          />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            {ask.approve ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: approveDisabled }}
                disabled={approveDisabled}
                onPress={() => submit("yes")}
                style={{
                  backgroundColor: approveDisabled ? theme.colors.surface2 : theme.colors.accent,
                  borderWidth: approveDisabled ? 1 : 0,
                  borderColor: paper.edge,
                  borderRadius: 6,
                  minHeight: MIN_HIT_HEIGHT,
                  justifyContent: "center",
                  paddingHorizontal: 14,
                }}
              >
                <Text style={{ color: approveDisabled ? theme.colors.foregroundMuted : theme.colors.accentForeground, fontSize: 12, fontWeight: "700" }}>Approve plan</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: replyDisabled }}
              disabled={replyDisabled}
              onPress={() => submit(reply)}
              style={{
                borderWidth: 1,
                borderColor: paper.edge,
                backgroundColor: theme.colors.surface1,
                borderRadius: 6,
                minHeight: MIN_HIT_HEIGHT,
                justifyContent: "center",
                paddingHorizontal: 14,
              }}
            >
              <Text style={{ color: replyDisabled ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>{state.busy ? "Sending…" : "Send reply"}</Text>
            </Pressable>
            <OpenChatButton theme={theme} kind={ask.kind} id={ask.id} openAgent={openAgent} onError={(error) => setState((s) => ({ ...s, error: error || undefined }))} />
          </View>
        </>
      )}
      {state.note ? <Text accessibilityLiveRegion="polite" style={{ color: hue("passed", theme).ink, fontSize: 12, marginTop: 8 }}>{state.note}</Text> : null}
      {state.error ? <Text accessibilityRole="alert" style={{ color: hue("failed", theme).ink, fontSize: 12, marginTop: 8 }}>{state.error}</Text> : null}
    </View>
  );
}

// The same ten minutes the task view uses: a running task with no sign of life that long gets flagged.
const quiet = (c: TaskCard) => c.status === "running" && !!c.lastActivity && Date.now() - Date.parse(c.lastActivity) > 10 * 60_000;

function Card({ theme, card, open, openAgent }: { theme: PluginTheme; card: TaskCard; open: OpenTask; openAgent?: (id: string) => void }) {
  const featured = card.status === "running";
  const paper = palette[scheme(theme)];
  const t = tones(theme);
  const prUrl = safeHttpsUrl(card.pullRequest);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4, marginBottom: 10 }}>
      <View
        style={{
          flex: 1,
          borderWidth: 1,
          borderColor: featured ? paper["carbon-copy"] : theme.colors.border,
          backgroundColor: theme.colors.surface1,
          borderRadius: 10,
          padding: 14,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${card.name}, ${STATUS_LABEL[card.status]}`}
          onPress={() => open(card.kind, card.id)}
          style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 14, flexShrink: 1 }}>{card.name}</Text>
            <Pill theme={theme} status={card.status} />
          </View>
          <Text numberOfLines={2} style={{ color: theme.colors.foreground, marginTop: 6, fontSize: 13 }}>{card.current}</Text>
          {!!card.checkSummary && <Text style={{ color: theme.colors.foregroundMuted, marginTop: 5, fontSize: 12 }}>{card.checkSummary}</Text>}
          {quiet(card) ? (
            <Text style={{ color: t.amber.ink, fontSize: 12, fontWeight: "700", marginTop: 6 }}>No activity recorded for {ago(card.lastActivity)}.</Text>
          ) : null}
        </Pressable>
        {prUrl && (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open pull request ${prUrl}`}
            onPress={() => void Linking.openURL(prUrl)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", marginTop: 4 }}
          >
            <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: t.blue.ink, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
              Pull request · {prUrl} ↗
            </Text>
          </Pressable>
        )}
        {(card.status === "failed" || card.status === "asking") && openAgent ? (
          <View style={{ marginTop: 8 }}>
            <OpenChatButton theme={theme} kind={card.kind} id={card.id} openAgent={openAgent} />
          </View>
        ) : null}
      </View>
      <RemoveTask theme={theme} kind={card.kind} id={card.id} name={card.name} active={card.status === "running" || card.status === "asking" || card.status === "sent-back"} />
    </View>
  );
}

export function HomeView({ theme, home, open, openAgent }: { theme: PluginTheme; home: Home; open: OpenTask; openAgent?: (id: string) => void }) {
  const [showDone, setShowDone] = useState(false);
  const [expandWork, setExpandWork] = useState(false);
  const working = home.tasks.filter((c) => !home.needsYou.some((a) => a.kind === c.kind && a.id === c.id));
  const failed = home.failedToday ?? [];
  const focus = home.needsYou.length + failed.length > 0;
  const listOpen = !focus || expandWork;
  return (
    <View>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700" }}>Work queue</Text>
      <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted, marginTop: 6, fontSize: 13 }}>
        {home.doneToday.length} finished today · {home.needsYou.length} awaiting your reply{failed.length ? ` · ${failed.length} failed today` : ""}
      </Text>
      {home.needsYou.length ? (
        <>
          <Section theme={theme} title="NEEDS YOU" count={`${home.needsYou.length}`} />
          {home.needsYou.map((a) => <AskCard key={`${a.kind}:${a.id}:${a.askKey ?? a.askedAt}`} theme={theme} ask={a} open={open} openAgent={openAgent} />)}
        </>
      ) : null}
      {failed.length > 0 && <Section theme={theme} title="FAILED TODAY" count={String(failed.length)} />}
      {failed.map((card) => <Card key={card.kind + ":" + card.id} theme={theme} card={card} open={open} openAgent={openAgent} />)}
      {working.length > 0 && (focus ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: listOpen }} onPress={() => setExpandWork(!expandWork)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
          <Section theme={theme} title={listOpen ? "▾ WORKING" : "▸ WORKING"} count={String(working.length)} />
        </Pressable>
      ) : <Section theme={theme} title="WORKING" count={String(working.length)} />)}
      {listOpen && working.map((c) => <Card key={c.kind + ":" + c.id} theme={theme} card={c} open={open} openAgent={openAgent} />)}
      {home.doneToday.length > 0 && (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDone }} onPress={() => setShowDone(!showDone)} style={{ marginTop: 20, minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, letterSpacing: 1.0, fontWeight: "700" }}>
            {showDone ? "▾" : "▸"} DONE TODAY · {home.doneToday.length}
          </Text>
        </Pressable>
      )}
      {showDone ? <View style={{ marginTop: 12 }}>{home.doneToday.map((c) => <Card key={`${c.kind}:${c.id}`} theme={theme} card={c} open={open} openAgent={openAgent} />)}</View> : null}
    </View>
  );
}
