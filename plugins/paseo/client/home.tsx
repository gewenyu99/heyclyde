import {RemoveTask} from "./remove-task";
import {scheme} from "./brand";
import {palette} from "./brand.generated";
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
  const [fullQuestion,setFullQuestion]=useState(false);
  const [state, setState] = useState<{ busy: boolean; note?: string; error?: string }>({ busy: false });
  const submit = async (text: string, allowAntigravityFullAccess=false) => {
    if (!text.trim() || state.busy) {
      setState({ busy: false, error: "Write a reply first." });
      return;
    }
    setState({ busy: true });
    const r = await send({ kind: ask.kind, id: ask.id, askKey:ask.askKey, allowAntigravityFullAccess, text: text.trim() }).catch((err: Error) => ({ ok: false, error: err.message }));
    if (r.ok) {
      setReply("");
      setState({ busy: false, note: "Sent." });
      void client.invalidateQueries({ queryKey: ["clyde"] });
    } else setState({ busy: false, error: r.error ?? "Clyde didn't take it." });
  };
  const amber = hue("asking");
  return (
    <View style={{ borderWidth: 1, borderColor: palette[scheme(theme)]["sticky-edge"], backgroundColor: palette[scheme(theme)].sticky, borderRadius: 10, padding: 16, marginBottom: 10 }}>
      <View style={{flexDirection:"row",gap:8,alignItems:"center"}}><Pressable onPress={() => open(ask.kind, ask.id)} style={{ flex:1,flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "700", flexShrink: 1 }}>{ask.task}</Text>
        <Text style={{ color: amber.ink, fontSize: 11 }}>waiting {ago(ask.askedAt)}</Text>
      </Pressable>
      <RemoveTask kind={ask.kind} id={ask.id} active name={ask.task} theme={theme}/></View>
      {ask.blockedStage ? <Text style={{color:theme.colors.foregroundMuted,marginTop:6}}>Blocked stage · {ask.blockedStage}</Text> : null}
      <View style={{ borderLeftWidth: 2, borderLeftColor: amber.ink, paddingLeft: 10, marginVertical: 12 }}>
        <Text numberOfLines={fullQuestion || (ask.question.length<=120 && !ask.question.includes("\n")) ? undefined : 3} style={{ color: theme.colors.foreground, fontWeight: "500" }}>{ask.question}</Text>
        {(ask.question.length>120 || ask.question.includes("\n")) && <Pressable accessibilityRole="button" accessibilityState={{expanded:fullQuestion}} onPress={()=>setFullQuestion(!fullQuestion)}>
          <Text style={{color:theme.colors.accent,fontSize:12}}>{fullQuestion?"Show less":"Read full question"}</Text>
        </Pressable>}
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
      {ask.retryable ? <Pressable accessibilityRole="button" disabled={state.busy} onPress={()=>void submit("retry",ask.fullAccess)} style={{paddingVertical:8}}><Text style={{color:theme.colors.accent,fontWeight:"700"}}>{ask.fullAccess?"Allow full access for this run and retry":"Retry"}</Text></Pressable> : <>
      <Eyebrow theme={theme}>Reply</Eyebrow>
      <TextInput value={reply} onChangeText={setReply} placeholder={ask.approve ? "Request a change…" : "Reply…"} placeholderTextColor={theme.colors.foregroundMuted}
        style={{ borderWidth: 1, borderColor: palette[scheme(theme)].edge, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, marginTop: 4, color: theme.colors.foreground, backgroundColor:theme.colors.surface1 }} />
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        {ask.approve ? (
          <Pressable accessibilityRole="button" disabled={state.busy || !!reply.trim()} onPress={() => submit("yes")}
            style={{ backgroundColor: theme.colors.accent, opacity: state.busy || reply.trim() ? 0.45 : 1, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 }}>
            <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>Approve plan</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" disabled={state.busy || !reply.trim()} onPress={() => submit(reply)}
          style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "700" }}>{state.busy ? "Sending…" : "Send reply"}</Text>
        </Pressable>
      </View>
      </>}
      {state.note ? <Text style={{ color: hue("passed").ink, fontSize: 11, marginTop: 8 }}>{state.note}</Text> : null}
      {state.error ? <Text style={{ color: hue("failed").ink, fontSize: 11, marginTop: 8 }}>{state.error}</Text> : null}
    </View>
  );
}

// The same ten minutes the task view uses: a running task with no sign of life that long gets flagged.
const quiet = (c: TaskCard) => c.status === "running" && !!c.lastActivity && Date.now() - Date.parse(c.lastActivity) > 10 * 60_000;

function Card({ theme, card, open }: { theme: PluginTheme; card: TaskCard; open: OpenTask }) {
  const featured = card.status === "running";
  return (
    <View style={{flexDirection:"row",alignItems:"flex-start",gap:4}}><Pressable accessibilityRole="button" onPress={() => open(card.kind, card.id)}
      style={{ flex:1,borderWidth: 1, borderColor: featured ? palette[scheme(theme)]["carbon-copy"] : theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 14, marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontWeight: "700", flexShrink: 1 }}>{card.name}</Text>
        <Pill status={card.status} />
      </View>
      <Text numberOfLines={2} style={{color:theme.colors.foreground,marginTop:6,fontSize:13}}>{card.current}</Text>
      {!!card.checkSummary && <Text style={{color:theme.colors.foregroundMuted,marginTop:5,fontSize:12}}>{card.checkSummary}</Text>}
      {quiet(card) ? (
        <Text style={{ color: PALETTE.amber.ink, fontSize: 11, fontWeight: "700", marginTop: 6 }}>No activity recorded for {ago(card.lastActivity)}.</Text>
      ) : null}
    </Pressable><RemoveTask theme={theme} kind={card.kind} id={card.id} name={card.name} active={card.status==="running"||card.status==="asking"||card.status==="sent-back"}/></View>
  );
}

export function HomeView({ theme, home, open }: { theme: PluginTheme; home: Home; open: OpenTask }) {
  const [showDone, setShowDone] = useState(false);
  const [expandWork,setExpandWork]=useState(false);
  const working = home.tasks.filter(c=>!home.needsYou.some(a=>a.kind===c.kind && a.id===c.id));
  const failed = home.failedToday ?? [];
  const focus = home.needsYou.length + failed.length > 0;
  const listOpen = !focus || expandWork;
  return (
    <View>
      <Text accessibilityRole="header" style={{color:theme.colors.foreground,fontSize:18,fontWeight:"700"}}>Work queue</Text>
      <Text accessibilityLiveRegion="polite" style={{color:theme.colors.foregroundMuted,marginTop:6}}>
        {home.doneToday.length} finished today · {home.needsYou.length} awaiting your reply{failed.length ? ` · ${failed.length} failed today` : ""}
      </Text>
      {home.needsYou.length ? (
        <>
          <Section theme={theme} title="NEEDS YOU" count={`${home.needsYou.length}`} />
          {home.needsYou.map((a) => <AskCard key={`${a.kind}:${a.id}:${a.askKey ?? a.askedAt}`} theme={theme} ask={a} open={open} />)}
        </>
      ) : null}
      {failed.length>0 && <Section theme={theme} title="FAILED TODAY" count={String(failed.length)}/>}
      {failed.map(card=><Card key={card.kind+":"+card.id} theme={theme} card={card} open={open}/>)}
      {working.length>0 && (focus ?
        <Pressable accessibilityRole="button" accessibilityState={{expanded:listOpen}} onPress={()=>setExpandWork(!expandWork)}><Section theme={theme} title={listOpen?"▾ WORKING":"▸ WORKING"} count={String(working.length)}/></Pressable>
        : <Section theme={theme} title="WORKING" count={String(working.length)}/>)}
      {listOpen && working.map(c=><Card key={c.kind+":"+c.id} theme={theme} card={c} open={open}/>)}
      {home.doneToday.length>0 && <Pressable onPress={() => setShowDone(!showDone)} style={{ marginTop: 24 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, letterSpacing: 1.2, fontWeight: "700" }}>
          {showDone ? "▾" : "▸"} DONE TODAY · {home.doneToday.length}
        </Text>
      </Pressable>}
      {showDone ? <View style={{ marginTop: 12 }}>{home.doneToday.map((c) => <Card key={`${c.kind}:${c.id}`} theme={theme} card={c} open={open} />)}</View> : null}
    </View>
  );
}
