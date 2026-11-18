import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { answerRpc, type Ask, type Home, type TaskCard } from "../shared/clyde";
import { ago, Eyebrow, hue, PALETTE, Pill } from "./nodes";

type OpenTask = (kind: TaskCard["kind"], id: string) => void;

function Section({ theme, title, count }: { theme: PluginTheme; title: string; count: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 32, marginBottom: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 11, letterSpacing: 1.2, fontWeight: "700" }}>{title}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{count}</Text>
    </View>
  );
}

function AskCard({ theme, ask, open }: { theme: PluginTheme; ask: Ask; open: OpenTask }) {
  const send = useRpc(answerRpc);
  const client = useQueryClient();
  const [reply, setReply] = useState("");
  const [showPlan, setShowPlan] = useState(false);
  const [state, setState] = useState<{ busy: boolean; note?: string; error?: string }>({ busy: false });
  const submit = async (text: string) => {
    if (!text.trim() || state.busy) {
      setState({ busy: false, error: "Write a reply first." });
      return;
    }
    setState({ busy: true });
    const r = await send({ kind: ask.kind, id: ask.id, text: text.trim() }).catch((err: Error) => ({ ok: false, error: err.message }));
    if (r.ok) {
      setReply("");
      setState({ busy: false, note: "Sent." });
      void client.invalidateQueries({ queryKey: ["clyde"] });
    } else setState({ busy: false, error: r.error ?? "Clyde didn't take it." });
  };
  const amber = hue("asking");
  return (
    <View style={{ borderWidth: 1, borderColor: "#f0d7bd", backgroundColor: "#fffcf8", borderRadius: 10, padding: 16, marginBottom: 10 }}>
      <Pressable onPress={() => open(ask.kind, ask.id)} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "700", flexShrink: 1 }}>{ask.task}</Text>
        <Text style={{ color: amber.ink, fontSize: 11 }}>waiting {ago(ask.askedAt)}</Text>
      </Pressable>
      {ask.why ? <Text style={{ color: theme.colors.foregroundMuted, marginTop: 8 }}>{ask.why}</Text> : null}
      <View style={{ borderLeftWidth: 2, borderLeftColor: amber.ink, paddingLeft: 10, marginVertical: 12 }}>
        <Text numberOfLines={ask.plan ? 3 : 8} style={{ color: theme.colors.foreground, fontWeight: "500" }}>{ask.question}</Text>
      </View>
      {ask.plan?.length ? (
        <View style={{ marginBottom: 12, gap: 3 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "700", letterSpacing: 0.6 }}>THE PLAN · {ask.plan.length} SLICES</Text>
          {ask.plan.slice(0, showPlan ? undefined : 6).map((line) => (
            <Text key={line} numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11 }}>{line}</Text>
          ))}
          {ask.plan.length > 6 ? (
            <Pressable onPress={() => setShowPlan(!showPlan)}>
              <Text style={{ color: PALETTE.blue.ink, fontSize: 11, fontWeight: "600" }}>{showPlan ? "Show less" : `Show all ${ask.plan.length}`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Eyebrow theme={theme}>Reply</Eyebrow>
      <TextInput value={reply} onChangeText={setReply} placeholder={ask.approve ? "Add a note to the plan…" : "Reply…"} placeholderTextColor={theme.colors.foregroundMuted}
        style={{ borderWidth: 1, borderColor: "#dadcd5", borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, marginTop: 4, color: theme.colors.foreground, backgroundColor: "#fff" }} />
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        {ask.approve ? (
          <Pressable accessibilityRole="button" onPress={() => submit("yes")}
            style={{ backgroundColor: "#253f7b", borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 }}>
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>Approve plan</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => submit(reply)}
          style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" }}>{state.busy ? "Sending…" : "Send reply"}</Text>
        </Pressable>
      </View>
      {state.note ? <Text style={{ color: hue("passed").ink, fontSize: 11, marginTop: 8 }}>{state.note}</Text> : null}
      {state.error ? <Text style={{ color: hue("failed").ink, fontSize: 11, marginTop: 8 }}>{state.error}</Text> : null}
    </View>
  );
}

// The same ten minutes the task view uses: a running task with no sign of life that long gets flagged.
const quiet = (c: TaskCard) => c.status === "running" && !!c.lastActivity && Date.now() - Date.parse(c.lastActivity) > 10 * 60_000;

function Pips({ pips }: { pips: TaskCard["pips"] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 10 }}>
      {pips.map((p, i) => (
        <View key={i} style={{ width: 14, height: 6, borderRadius: 3, backgroundColor: p === "pending" ? "#e2e4df" : hue(p).ink }} />
      ))}
    </View>
  );
}

function Card({ theme, card, open }: { theme: PluginTheme; card: TaskCard; open: OpenTask }) {
  const featured = card.status === "running";
  return (
    <Pressable accessibilityRole="button" onPress={() => open(card.kind, card.id)}
      style={{ borderWidth: 1, borderColor: featured ? "#bdd0fa" : theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 14, marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontWeight: "700", flexShrink: 1 }}>{card.name}</Text>
        <Pill status={card.status} />
      </View>
      {card.why ? <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, marginTop: 4 }}>{card.why}</Text> : null}
      <Pips pips={card.pips} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 6 }}>
        {card.passed} passed · {card.running} running · {card.sentBack} sent back · {card.pending} pending
      </Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
          {card.current}{card.rung ? `  ·  ${card.rung}` : ""}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{ago(card.startedAt)}</Text>
      </View>
      {quiet(card) ? (
        <Text style={{ color: PALETTE.amber.ink, fontSize: 11, fontWeight: "700", marginTop: 6 }}>Quiet for {ago(card.lastActivity)}. It may be stuck.</Text>
      ) : null}
    </Pressable>
  );
}

export function HomeView({ theme, home, open }: { theme: PluginTheme; home: Home; open: OpenTask }) {
  const [showDone, setShowDone] = useState(false);
  return (
    <View>
      <Text accessibilityRole="header" style={{color:theme.colors.foreground,fontSize:18,fontWeight:"700"}}>Work queue</Text>
      {home.needsYou.length ? (
        <>
          <Section theme={theme} title="NEEDS YOU" count={`${home.needsYou.length}`} />
          {home.needsYou.map((a) => <AskCard key={`${a.kind}:${a.id}`} theme={theme} ask={a} open={open} />)}
        </>
      ) : null}
      {home.tasks.length>0 && <Section theme={theme} title="ACTIVE" count={String(home.tasks.length)} />}
      {home.tasks.length ? home.tasks.map((c) => <Card key={`${c.kind}:${c.id}`} theme={theme} card={c} open={open} />)
        : <Text style={{ color: theme.colors.foregroundMuted }}>No active tasks.</Text>}
      {home.doneToday.length>0 && <Pressable onPress={() => setShowDone(!showDone)} style={{ marginTop: 24 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, letterSpacing: 1.2, fontWeight: "700" }}>
          {showDone ? "▾" : "▸"} DONE TODAY · {home.doneToday.length}
        </Text>
      </Pressable>}
      {showDone ? <View style={{ marginTop: 12 }}>{home.doneToday.map((c) => <Card key={`${c.kind}:${c.id}`} theme={theme} card={c} open={open} />)}</View> : null}
    </View>
  );
}
