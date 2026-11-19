import {RemoveTask} from "./remove-task";
import { OpenChatButton } from "./open-chat";
import { RunEvidence } from "./run-evidence";
import { WorkerPermissions } from "./worker-permissions";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, TextInput, Text, View } from "react-native";
import { answerRpc,steerRpc, stopRpc, transcriptRpc, type AttemptView, type TaskView } from "../shared/clyde";
import { palette } from "./brand.generated";
import { ago, duration, formatRpcError, MIN_HIT_HEIGHT, STATUS_LABEL, tones } from "./nodes";
import { groupAttempts, parseInline, parseTranscriptBlocks, type TranscriptBlock } from "./transcript-format";
import { scheme } from "./palette";

/** Attempts keep their evidence visible; verbose check output and past attempts are optional. */
function AttemptRow({ theme, a, compact = false, alreadyShown = [] }: { theme: PluginTheme; a: AttemptView; compact?: boolean; alreadyShown?: string[] }) {
  const [open, setOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const showEvidence = !compact || open;
  const uniqueEvidence = (text?: string) => !!text?.trim() && text !== "No result posted yet." && !alreadyShown.some(shown => shown?.trim() === text.trim());
  return <View style={{ gap: 7, paddingVertical: 5 }}>
    {compact ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
      <Text style={{ color: a.interrupted ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: 13 }}>{open ? "▾" : "▸"} Attempt {a.n} · {a.rung || "Worker"} · {a.outcome}</Text>
    </Pressable> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Attempt {a.n} · {a.rung || "Worker"} · {duration(a.startedAt, a.endedAt)}</Text>}
    {showEvidence && <>
      {uniqueEvidence(a.evidence) && <FormattedBody theme={theme} text={a.evidence} />}
      {a.criteria.filter(c => c.result === "fail").map((c, index) => <View key={index} style={{ gap: 3 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{c.criterion}</Text>
        {uniqueEvidence(c.evidence) && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{c.evidence}</Text>}
      </View>)}
      {(a.checks.length > 0 || a.criteria.some(c => c.result !== "fail") || a.judgeRung) && <View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: checksOpen }} onPress={() => setChecksOpen(!checksOpen)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
          <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{checksOpen ? "Hide checks" : "View checks"}</Text>
        </Pressable>
        {checksOpen && <View style={{ gap: 6 }}>
          {a.criteria.filter(c => c.result !== "fail").map((c, index) => <Text key={index} style={{ color: theme.colors.foreground, fontSize: 13 }}>{c.result === "pass" ? "✓" : "○"} {c.criterion}{c.evidence ? ` — ${c.evidence}` : ""}</Text>)}
          {a.checks.map((check, index) => <View key={index} style={{ gap: 3 }}>
            <Text style={{ color: check.code ? theme.colors.statusDanger : theme.colors.foreground, fontSize: 12, fontFamily: "Menlo" }}>$ {check.cmd} · exit {check.code}</Text>
            {!!check.output && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: "Menlo" }}>{check.output}</Text>}
          </View>)}
          {a.judgeRung && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Judged by {a.judgeRung}</Text>}
        </View>}
      </View>}
    </>}
  </View>;
}

function StageAttempts({ theme, tries, alreadyShown }: { theme: PluginTheme; tries: AttemptView[]; alreadyShown: string[] }) {
  const [showPast, setShowPast] = useState(false);
  const { past, latest, summary } = groupAttempts(tries);
  if (!latest) return null;
  return <View>
    <AttemptRow theme={theme} a={latest} alreadyShown={alreadyShown} />
    {past.length > 0 && <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPast }} onPress={() => setShowPast(!showPast)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
        <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{showPast ? "Hide past attempts" : summary}</Text>
      </Pressable>
      {showPast && past.map(a => <AttemptRow key={a.n} theme={theme} a={a} compact />)}
    </View>}
  </View>;
}

function InlineText({ theme, text, baseStyle }: { theme: PluginTheme; text: string; baseStyle: { color: string; fontSize: number; lineHeight: number; fontWeight?: "400" | "600" | "700" } }) {
  const runs = parseInline(text);
  return (
    <Text selectable style={baseStyle}>
      {runs.map((run, idx) =>
        run.kind === "bold" ? (
          <Text key={idx} style={{ fontWeight: "700" }}>{run.text}</Text>
        ) : run.kind === "code" ? (
          <Text key={idx} style={{ fontFamily: "Menlo", fontSize: 12, backgroundColor: theme.colors.surface2 }}>{` ${run.text} `}</Text>
        ) : (
          <Text key={idx}>{run.text}</Text>
        ),
      )}
    </Text>
  );
}

function CodeBlock({ theme, block }: { theme: PluginTheme; block: Extract<TranscriptBlock, { kind: "code" }> }) {
  const collapsible = (block.isJson && block.lines > 14) || block.lines > 24;
  const [expanded, setExpanded] = useState(!collapsible);
  const label = block.isJson ? "JSON" : block.lang || "Code";
  return (
    <View style={{ backgroundColor: theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 10, borderBottomWidth: expanded ? 1 : 0, borderBottomColor: theme.colors.border }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", fontFamily: "Menlo" }}>
          {label} · {block.lines} lines
        </Text>
        {collapsible ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingLeft: 10 }}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
              {expanded ? `Hide ${label} ▴` : `Show ${label} ▾`}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <Text selectable style={{ fontFamily: "Menlo", fontSize: 12, lineHeight: 18, color: theme.colors.foreground, padding: 10 }}>
          {block.text}
        </Text>
      ) : null}
    </View>
  );
}

function FormattedBody({ theme, text }: { theme: PluginTheme; text: string }) {
  const blocks = parseTranscriptBlocks(text);
  const t = tones(theme);
  if (!blocks.length) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>(no text yet)</Text>;
  }
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const fontSize = b.level === 1 ? 16 : b.level === 2 ? 15 : 14;
          return (
            <InlineText
              key={i}
              theme={theme}
              text={b.text}
              baseStyle={{ color: theme.colors.foreground, fontSize, lineHeight: fontSize + 6, fontWeight: "700" }}
            />
          );
        }
        if (b.kind === "bullet") {
          return (
            <View key={i} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20, fontWeight: "700" }}>{b.marker}</Text>
              <View style={{ flex: 1 }}>
                <InlineText theme={theme} text={b.text} baseStyle={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }} />
              </View>
            </View>
          );
        }
        if (b.kind === "quote") {
          return (
            <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: t.blue.ink, paddingLeft: 10 }}>
              <InlineText theme={theme} text={b.text} baseStyle={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }} />
            </View>
          );
        }
        if (b.kind === "code") {
          return <CodeBlock key={i} theme={theme} block={b} />;
        }
        return (
          <InlineText key={i} theme={theme} text={b.text} baseStyle={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }} />
        );
      })}
    </View>
  );
}

function timeAgo(iso: string) { const age = ago(iso); return age === "just now" ? age : age + " ago"; }

function TurnCard({ theme, turn, rungLabel }: { theme: PluginTheme; turn: { n: number; at: string; prompt: string; text: string }; rungLabel?: string }) {
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
          Turn {turn.n} · {timeAgo(turn.at)}
        </Text>
        {rungLabel ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{rungLabel}</Text> : null}
      </View>
      {turn.prompt.trim() ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showPrompt }}
            onPress={() => setShowPrompt(!showPrompt)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
              {showPrompt ? "Hide prompt ▴" : "Show prompt ▾"}
            </Text>
          </Pressable>
          {showPrompt ? (
            <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "Menlo", fontSize: 12, lineHeight: 18, backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 }}>
              {turn.prompt}
            </Text>
          ) : null}
        </View>
      ) : null}
      <FormattedBody theme={theme} text={turn.text} />
    </View>
  );
}

function Transcript({ theme, threadId, tries = [] }: { theme: PluginTheme; threadId: string; tries?: AttemptView[] }) {
  const [pickedThread, setPickedThread] = useState<string | undefined>();
  const activeThread = tries.some((a) => a.threadId === pickedThread) ? pickedThread! : threadId;
  const read = useRpc(transcriptRpc);
  const q = useQuery({ queryKey: ["clyde", "transcript", activeThread], queryFn: () => read({ threadId: activeThread }) });
  const t = q.data?.data;
  const pal = tones(theme);
  return (
    <View style={{ padding: 12, gap: 10, backgroundColor: theme.colors.surface2 }}>
      {tries.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[...tries].reverse().map((a, idx) => {
            const selected = a.threadId === activeThread;
            return (
              <Pressable
                key={a.threadId}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setPickedThread(a.threadId)}
                style={{
                  minHeight: MIN_HIT_HEIGHT,
                  justifyContent: "center",
                  paddingHorizontal: 10,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: selected ? theme.colors.accent : palette[scheme(theme)].edge,
                  backgroundColor: selected ? theme.colors.surface1 : "transparent",
                }}
              >
                <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12, fontWeight: selected ? "700" : "500" }}>
                  #{a.n}{idx === 0 ? " (latest)" : ""} · {a.outcome}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {q.isPending ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Reading…</Text>
      ) : !t ? (
        <Text accessibilityRole="alert" style={{ color: pal.red.ink, fontSize: 13 }}>{formatRpcError(q.data?.error ?? q.error ?? "No transcript.")}</Text>
      ) : (
        <>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t.threadId} · {t.rung}</Text>
          {t.turns.map((turn) => (
            <TurnCard key={turn.n} theme={theme} turn={turn} rungLabel={t.rung} />
          ))}
        </>
      )}
    </View>
  );
}

function Steering({id,theme}:{id:string;theme:PluginTheme}) {
  const send=useRpc(steerRpc);
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit() {
    setBusy(true);
    try { await send({id,text:note}); setNote(""); setError(""); }
    catch(e) { setError(formatRpcError(e)); } finally { setBusy(false); }
  }
  return <View style={{marginTop:10,gap:6}}>
    <TextInput
      accessibilityLabel="Steer this run"
      placeholder="Steer this run"
      placeholderTextColor={theme.colors.foregroundMuted}
      onSubmitEditing={() => { if (note.trim() && !busy) void submit(); }}
      style={{
        color:theme.colors.foreground,
        backgroundColor:theme.colors.surface1,
        borderWidth:1,
        borderColor:palette[scheme(theme)].edge,
        borderRadius:6,
        paddingHorizontal:10,
        paddingVertical:8,
        minHeight:MIN_HIT_HEIGHT,
        fontSize:14,
      }}
      value={note}
      onChangeText={setNote}
    />
    {note.trim() && (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={()=>void submit()}
        style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
      >
        <Text style={{color:theme.colors.accent, fontSize:13, fontWeight:"600"}}>{busy ? "Sending…" : "Send instruction"}</Text>
      </Pressable>
    )}
    {error && <Text accessibilityRole="alert" style={{color:theme.colors.statusDanger, fontSize:13}}>{error}</Text>}
  </View>;
}

function StopButton({ theme, view }: { theme: PluginTheme; view: TaskView }) {
  const stop = useRpc(stopRpc);
  const client = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const t = tones(theme);
  const press = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 5000);
      return;
    }
    setArmed(false);
    const r = await stop({ kind: view.kind, id: view.id }).catch((err: Error) => ({ ok: false, error: formatRpcError(err) }));
    if (!r.ok) setError(r.error ? formatRpcError(r.error) : "Clyde didn't stop it.");
    void client.invalidateQueries({ queryKey: ["clyde"] });
  };
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Pressable accessibilityRole="button" onPress={press} style={{
        borderWidth: 1, borderColor: armed ? t.red.ink : palette[scheme(theme)].edge, backgroundColor: armed ? t.red.soft : "transparent",
        borderRadius: 6, minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 12,
      }}>
        <Text style={{ color: armed ? t.red.ink : theme.colors.foregroundMuted, fontSize: 12, fontWeight: armed ? "700" : "400" }}>{armed ? "Press again to stop" : "Stop"}</Text>
      </Pressable>
      {error ? <Text accessibilityRole="alert" style={{ color: t.red.ink, fontSize: 12, marginTop: 4 }}>{error}</Text> : null}
    </View>
  );
}

export function TaskScreen({ theme, view, back, openAgent, embeddedSupervisor = false }: { theme: PluginTheme; view: TaskView; back: () => void; openAgent?: (id: string) => void; embeddedSupervisor?: boolean }) {
  const answer=useRpc(answerRpc), cache=useQueryClient();
  const [reply,setReply]=useState(""),[retryError,setRetryError]=useState(""),[retrying,setRetrying]=useState(false);
  const t = tones(theme);
  const edge = palette[scheme(theme)].edge;
  async function sendAnswer(text: string, allowFullAccess?: boolean){
    setRetrying(true);
    try{const r=await answer({kind:view.kind,id:view.id,text,askKey:view.askKey,...(allowFullAccess?{allowAntigravityFullAccess:true}:{})});if(!r.ok)throw Error(r.error);setReply("");setRetryError("");await cache.invalidateQueries({queryKey:["clyde"]});}
    catch(e){setRetryError(formatRpcError(e));}finally{setRetrying(false);}
  }
  const [picked, setPicked] = useState<string | undefined>();
  const [showTranscript, setShowTranscript] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const pieces = view.steps.flatMap(step => step.pieces);
  const stages = pieces.flatMap(piece => piece.phases.map(phase => ({ ...phase, piece })));
  const selected = stages.find(stage => stage.stage === picked) || stages.find(stage => ["running", "asking", "sent-back", "failed"].includes(stage.status)) || stages.find(stage => stage.piece.id === view.selected) || stages[0];
  const tries = selected ? view.attempts[selected.stage] || [] : [];
  const lastThread = tries[tries.length - 1]?.threadId;
  const activity = view.runActivity;
  const [pendingFor, setPendingFor] = useState<string>();
  const waiting = !!activity?.permissionAgentId && activity.permissionAgentId === pendingFor;
  return (
    <View style={{ gap: 14 }}>
      {!embeddedSupervisor && <Pressable accessibilityRole="button" onPress={back} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
        <Text style={{ color: theme.colors.accent, fontSize: 13 }}>‹ Back</Text>
      </Pressable>}
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700" }}>{view.name}</Text>
      <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, lineHeight: 22, fontWeight: "600" }}>{activity?.headline || view.summary || STATUS_LABEL[view.status]}</Text>
        {activity?.latestResult && <View style={{ gap: 5 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Latest finding</Text>
          <FormattedBody theme={theme} text={activity.latestResult} />
        </View>}
        {activity?.retryReason && <View style={{ gap: 5 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Why it was sent back</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }}>{activity.retryReason}</Text>
        </View>}
      </View>
      {view.kind === "run" && activity?.permissionAgentId && <WorkerPermissions key={view.id} theme={theme} runId={view.id} openAgent={openAgent} onPending={setPendingFor} />}
        {view.question ? (
          <View style={{ borderLeftWidth: 2, borderLeftColor: t.amber.ink, paddingLeft: 12, marginTop: 12, gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "500", fontSize: 14 }}>{view.question}</Text>
            {view.retryable ? (
              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: retrying }}
                  disabled={retrying}
                  onPress={()=>void sendAnswer("retry",view.fullAccess)}
                  style={{
                    backgroundColor: retrying ? theme.colors.surface2 : theme.colors.accent,
                    borderWidth: retrying ? 1 : 0,
                    borderColor: edge,
                    borderRadius: 6,
                    paddingHorizontal: 14,
                    minHeight: MIN_HIT_HEIGHT,
                    justifyContent: "center",
                  }}
                >
                  <Text style={{color: retrying ? theme.colors.foregroundMuted : theme.colors.accentForeground, fontWeight:"700",fontSize:13}}>
                    {retrying ? "Retrying…" : view.fullAccess ? "Allow full access for this run and retry" : "Retry"}
                  </Text>
                </Pressable>
                {!embeddedSupervisor && !activity?.permissionAgentId && <OpenChatButton theme={theme} kind={view.kind} id={view.id} openAgent={openAgent} onError={setRetryError} />}
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                <TextInput
                  accessibilityLabel={view.approve ? "Request a change" : "Reply to question"}
                  placeholder={view.approve ? "Request a change…" : "Reply…"}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={reply}
                  onChangeText={setReply}
                  onSubmitEditing={() => { if (reply.trim() && !retrying) void sendAnswer(reply.trim()); }}
                  style={{
                    color: theme.colors.foreground,
                    backgroundColor: theme.colors.surface1,
                    borderWidth: 1,
                    borderColor: edge,
                    borderRadius: 6,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    minHeight: MIN_HIT_HEIGHT,
                    fontSize: 14,
                  }}
                />
                <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  {view.approve && (() => {
                    const approveDisabled = retrying || !!reply.trim();
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: approveDisabled }}
                        disabled={approveDisabled}
                        onPress={() => void sendAnswer("yes")}
                        style={{
                          backgroundColor: approveDisabled ? theme.colors.surface2 : theme.colors.accent,
                          borderWidth: approveDisabled ? 1 : 0,
                          borderColor: edge,
                          borderRadius: 6,
                          paddingHorizontal: 14,
                          minHeight: MIN_HIT_HEIGHT,
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: approveDisabled ? theme.colors.foregroundMuted : theme.colors.accentForeground, fontWeight: "700", fontSize: 13 }}>Approve plan</Text>
                      </Pressable>
                    );
                  })()}
                  {(() => {
                    const replyDisabled = retrying || !reply.trim();
                    const primary = !view.approve;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: replyDisabled }}
                        disabled={replyDisabled}
                        onPress={() => void sendAnswer(reply.trim())}
                        style={{
                          backgroundColor: primary && !replyDisabled ? theme.colors.accent : theme.colors.surface2,
                          borderWidth: primary && !replyDisabled ? 0 : 1,
                          borderColor: edge,
                          borderRadius: 6,
                          paddingHorizontal: 14,
                          minHeight: MIN_HIT_HEIGHT,
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: replyDisabled ? theme.colors.foregroundMuted : primary ? theme.colors.accentForeground : theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>
                          {retrying ? "Sending…" : view.approve ? "Request changes" : "Send reply"}
                        </Text>
                      </Pressable>
                    );
                  })()}
                  {!embeddedSupervisor && !activity?.permissionAgentId && <OpenChatButton theme={theme} kind={view.kind} id={view.id} openAgent={openAgent} onError={setRetryError} />}
                </View>
              </View>
            )}
            {!!retryError && <Text accessibilityRole="alert" style={{color:theme.colors.statusDanger, fontSize:13}}>{retryError}</Text>}
          </View>
        ) : null}
        {!embeddedSupervisor && !activity?.permissionAgentId && !view.question && view.status === "failed" && openAgent ? (
          <View style={{ marginTop: 12, gap: 8 }}>
            <OpenChatButton theme={theme} kind={view.kind} id={view.id} openAgent={openAgent} onError={setRetryError} />
            {!!retryError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{retryError}</Text>}
          </View>
        ) : null}

      {view.savedPlanIntent && <View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPlan }} onPress={() => setShowPlan(!showPlan)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
          <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>{showPlan ? "Hide saved plan" : "View saved plan"}</Text>
        </Pressable>
        {showPlan && <FormattedBody theme={theme} text={view.savedPlanIntent} />}
      </View>}
      <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 14, gap: 12 }}>
        {view.goal && view.goal !== view.name && !view.savedPlanIntent?.startsWith(view.goal.replace(/…$/, "")) &&
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{view.goal}</Text>}
        {view.diff && (view.diff.commits > 0 || view.diff.files > 0) &&
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            {view.diff.commits} commits · {view.diff.files} changed files · +{view.diff.insertions} −{view.diff.deletions}
          </Text>}
        <RunEvidence view={view} theme={theme} />
        {stages.map(stage => {
          const isSelected = stage.stage === selected?.stage;
          const waitingForPermission = stage.status === "running" && waiting && stage.piece.id === view.selected;
          const label = pieces.length === 1 || stage.label === stage.piece.title ? stage.label : `${stage.piece.title} · ${stage.label}`;
          return <View key={stage.stage} style={{ borderLeftWidth: 2, borderLeftColor: isSelected ? theme.colors.accent : theme.colors.border, paddingLeft: 10 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: isSelected }} onPress={() => { setPicked(stage.stage); setShowTranscript(false); }} style={{ minHeight: MIN_HIT_HEIGHT, flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>{label}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{waitingForPermission ? "Permission required" : STATUS_LABEL[stage.status]}</Text>
            </Pressable>
            {isSelected && <View style={{ gap: 6 }}>
              {stage.piece.doneWhen.filter(item => !view.completionCriteria?.includes(item)).map((item, i) =>
                <Text key={i} selectable style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{item}</Text>
              )}
              <StageAttempts key={stage.stage} theme={theme} tries={tries} alreadyShown={[activity?.latestResult || "", activity?.retryReason || ""]} />
              {!tries.length && stage.piece.rung && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{stage.piece.rung}</Text>}
              {!tries.length && stage.piece.progress && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{stage.piece.progress}</Text>}
              {lastThread && <View>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTranscript }} onPress={() => setShowTranscript(!showTranscript)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                  <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{showTranscript ? "Hide agent transcript" : "View agent transcript"}</Text>
                </Pressable>
                {showTranscript && <Transcript key={stage.stage} theme={theme} threadId={lastThread} tries={tries} />}
              </View>}
            </View>}
          </View>;
        })}
        {view.kind === "run" && view.status === "running" && <Steering id={view.id} theme={theme} />}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          {(view.status === "running" || view.status === "asking") && <StopButton theme={theme} view={view} />}
          <RemoveTask theme={theme} kind={view.kind} id={view.id} name={view.name} active={["running", "asking", "sent-back"].includes(view.status)} onRemoved={back} />
        </View>
      </View>
    </View>
  );
}
