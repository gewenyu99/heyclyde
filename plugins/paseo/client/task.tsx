import {RemoveTask} from "./remove-task";
import { OpenChatButton } from "./open-chat";
import { RunEvidence } from "./run-evidence";
import { OrchestrationFlow } from "./orchestration-flow";
import { WorkerPermissions } from "./worker-permissions";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, TextInput, Text, View } from "react-native";
import { answerRpc, steerRpc, stopRpc, transcriptRpc, type AttemptView, type Status, type TaskView } from "../shared/clyde";
import { palette } from "./brand.generated";
import { ago, duration, formatRpcError, hue, MIN_HIT_HEIGHT, Pill, STATUS_LABEL, tones } from "./nodes";
import { groupAttempts, parseInline, parseTranscriptBlocks, type TranscriptBlock } from "./transcript-format";
import { scheme } from "./palette";

const QUIET_MS = 10 * 60_000;
const PHASE_GLYPH: Record<Status, string> = {
  passed: "✓",
  done: "✓",
  failed: "✕",
  running: "●",
  "sent-back": "↺",
  asking: "?",
  pending: "○",
  skipped: "–",
};

/** Attempts keep failed criteria, failed checks, worker, and retry evidence visible; stacked mode places Judge above Worker Evidence for the right inspector. */
function AttemptRow({ theme, a, compact = false, stacked = false, alreadyShown = [] }: { theme: PluginTheme; a: AttemptView; compact?: boolean; stacked?: boolean; alreadyShown?: string[] }) {
  const [open, setOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const showEvidence = !compact || open;
  const t = tones(theme);
  const tone: Status = a.interrupted
    ? "pending"
    : /passed|done/i.test(a.outcome)
    ? "passed"
    : /sent back|failed/i.test(a.outcome)
    ? "sent-back"
    : "running";
  const toneHue = hue(tone, theme);
  const fails = a.criteria.filter(c => c.result === "fail");
  const otherCriteria = a.criteria.filter(c => c.result !== "fail");
  const badChecks = a.checks.filter(c => c.code !== 0);
  const passedChecks = a.checks.filter(c => c.code === 0);
  const uniqueEvidence = (text?: string) => !!text?.trim() && text !== "No result posted yet." && !alreadyShown.some(shown => shown?.trim() === text.trim());
  const extraChecksCount = otherCriteria.length + passedChecks.length + (a.judgeRung ? 1 : 0);
  const judgeBlock = (
    <View style={stacked ? { backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" } : { flex: 1, minWidth: 220, gap: 5, borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: 12 }}>
      <View style={stacked ? { backgroundColor: theme.colors.surface2, paddingVertical: 7, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6 } : undefined}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>
          JUDGE{a.judgeRung ? ` · ${a.judgeRung}` : ""} · PER CRITERION
        </Text>
      </View>
      <View style={stacked ? { padding: 10, gap: 6 } : { gap: 5 }}>
        {a.criteria.length ? (
          <>
            {fails.map((c, index) => (
              <View key={`fail-${index}`} style={{ gap: 2 }}>
                <Text style={{ color: t.red.ink, fontSize: 13, fontWeight: "600" }}>✕ {c.criterion}</Text>
                {!!c.evidence?.trim() && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{c.evidence}</Text>}
              </View>
            ))}
            {otherCriteria.map((c, index) => (
              <Text key={`ok-${index}`} style={{ color: c.result === "pass" ? t.green.ink : theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
                {c.result === "pass" ? "✓" : "○"} {c.criterion}
              </Text>
            ))}
          </>
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Awaiting verdict.</Text>
        )}
      </View>
    </View>
  );
  const workerBlock = (
    <View style={stacked ? { backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" } : { flex: 1, minWidth: 220, gap: 5 }}>
      <View style={stacked ? { backgroundColor: theme.colors.surface2, paddingVertical: 7, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6 } : undefined}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>
          WORKER EVIDENCE{stacked ? ` · ATTEMPT ${a.n}` : ""}
        </Text>
        {stacked ? <Text style={{ color: toneHue.ink, fontSize: 12, fontWeight: "700" }}>{a.outcome}</Text> : null}
      </View>
      <View style={stacked ? { padding: 10, gap: 6 } : { gap: 5 }}>
        {uniqueEvidence(a.evidence) ? (
          <FormattedBody theme={theme} text={a.evidence} />
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{a.evidence || "No result posted yet."}</Text>
        )}
      </View>
    </View>
  );
  if (stacked && !compact) {
    return (
      <View style={{ gap: 10 }}>
        {judgeBlock}
        {workerBlock}
        {badChecks.map((check, index) => (
          <View key={`bad-check-${index}`} style={{ gap: 3, backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 }}>
            <Text selectable style={{ color: theme.colors.statusDanger, fontSize: 12, fontFamily: "Menlo", fontWeight: "600" }}>$ {check.cmd} · exit {check.code}</Text>
            {!!check.output && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: "Menlo" }}>{check.output}</Text>}
          </View>
        ))}
        {extraChecksCount > 0 && (
          <View>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: checksOpen }} onPress={() => setChecksOpen(!checksOpen)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
              <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>{checksOpen ? "Hide checks ▴" : `View checks (${passedChecks.length + otherCriteria.length}) ▸`}</Text>
            </Pressable>
            {checksOpen && (
              <View style={{ gap: 6, backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 }}>
                {otherCriteria.map((c, index) => (
                  <Text key={index} style={{ color: c.result === "pass" ? t.green.ink : theme.colors.foreground, fontSize: 12 }}>
                    {c.result === "pass" ? "✓" : "○"} {c.criterion}{c.evidence ? ` — ${c.evidence}` : ""}
                  </Text>
                ))}
                {passedChecks.map((check, index) => (
                  <View key={index} style={{ gap: 3 }}>
                    <Text style={{ color: t.green.ink, fontSize: 12, fontFamily: "Menlo" }}>$ {check.cmd} · exit {check.code}</Text>
                    {!!check.output && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: "Menlo" }}>{check.output}</Text>}
                  </View>
                ))}
                {a.judgeRung && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Judged by {a.judgeRung}</Text>}
              </View>
            )}
          </View>
        )}
      </View>
    );
  }
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderLeftWidth: 3, borderLeftColor: toneHue.ink, borderRadius: 8, overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
      {compact ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: MIN_HIT_HEIGHT, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, backgroundColor: theme.colors.surface2, paddingHorizontal: 12 }}>
          <Text style={{ color: a.interrupted ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: 12, fontWeight: "700", flexShrink: 1 }}>
            {open ? "▾" : "▸"} ATTEMPT {a.n} · {a.rung || "Worker"} · {duration(a.startedAt, a.endedAt)}
          </Text>
          <Text style={{ color: toneHue.ink, fontSize: 12, fontWeight: "700" }}>{a.outcome}</Text>
        </Pressable>
      ) : (
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", backgroundColor: theme.colors.surface2, paddingVertical: 8, paddingHorizontal: 12 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>
            ATTEMPT {a.n} · {a.rung || "Worker"} · {duration(a.startedAt, a.endedAt)}
          </Text>
          <Text style={{ color: toneHue.ink, fontSize: 12, fontWeight: "700" }}>{a.outcome}</Text>
        </View>
      )}
      {showEvidence && (
        <View style={{ padding: 12, gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {workerBlock}
            {judgeBlock}
          </View>
          {badChecks.map((check, index) => (
            <View key={`bad-check-${index}`} style={{ gap: 3, backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 }}>
              <Text selectable style={{ color: theme.colors.statusDanger, fontSize: 12, fontFamily: "Menlo", fontWeight: "600" }}>$ {check.cmd} · exit {check.code}</Text>
              {!!check.output && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: "Menlo" }}>{check.output}</Text>}
            </View>
          ))}
          {extraChecksCount > 0 && (
            <View>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: checksOpen }} onPress={() => setChecksOpen(!checksOpen)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{checksOpen ? "Hide checks" : `View checks (${passedChecks.length + otherCriteria.length})`}</Text>
              </Pressable>
              {checksOpen && (
                <View style={{ gap: 6, backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 }}>
                  {otherCriteria.map((c, index) => (
                    <Text key={index} style={{ color: c.result === "pass" ? t.green.ink : theme.colors.foreground, fontSize: 12 }}>
                      {c.result === "pass" ? "✓" : "○"} {c.criterion}{c.evidence ? ` — ${c.evidence}` : ""}
                    </Text>
                  ))}
                  {passedChecks.map((check, index) => (
                    <View key={index} style={{ gap: 3 }}>
                      <Text style={{ color: t.green.ink, fontSize: 12, fontFamily: "Menlo" }}>$ {check.cmd} · exit {check.code}</Text>
                      {!!check.output && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: "Menlo" }}>{check.output}</Text>}
                    </View>
                  ))}
                  {a.judgeRung && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Judged by {a.judgeRung}</Text>}
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function StageAttempts({ theme, tries, stacked = false, alreadyShown = [] }: { theme: PluginTheme; tries: AttemptView[]; stacked?: boolean; alreadyShown?: string[] }) {
  const [showPast, setShowPast] = useState(false);
  const [selectedAttempt, setSelectedAttempt] = useState<number | undefined>();
  const { past, latest, summary } = groupAttempts(tries);
  if (!latest) return null;
  const active = stacked && selectedAttempt !== undefined
    ? (tries.find(a => a.n === selectedAttempt) ?? latest)
    : latest;
  const t = tones(theme);
  const edge = palette[scheme(theme)].edge;
  return (
    <View style={{ gap: 8 }}>
      {stacked && tries.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[...tries].reverse().map(a => {
            const isSel = a.n === active.n;
            const dur = duration(a.startedAt, a.endedAt);
            return (
              <Pressable
                key={a.n}
                accessibilityRole="button"
                accessibilityState={{ selected: isSel }}
                onPress={() => setSelectedAttempt(a.n)}
                style={{
                  minHeight: MIN_HIT_HEIGHT,
                  justifyContent: "center",
                  paddingHorizontal: 10,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: isSel ? theme.colors.accent : edge,
                  backgroundColor: isSel ? t.blue.soft : "transparent",
                }}
              >
                <Text style={{ color: isSel ? t.blue.ink : theme.colors.foregroundMuted, fontSize: 12, fontWeight: isSel ? "700" : "600" }}>
                  #{a.n} · {a.outcome}{a.n === latest.n && dur ? ` · ${dur}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <AttemptRow theme={theme} a={active} stacked={stacked} alreadyShown={alreadyShown} />
      {!stacked && past.length > 0 && (
        <View>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPast }} onPress={() => setShowPast(!showPast)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
            <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{showPast ? "Hide past attempts" : summary}</Text>
          </Pressable>
          {showPast && past.map(a => <AttemptRow key={a.n} theme={theme} a={a} compact />)}
        </View>
      )}
    </View>
  );
}

function RunSummary({ theme, view }: { theme: PluginTheme; view: TaskView }) {
  const [showRouting, setShowRouting] = useState(false);
  const quiet = view.status === "running" && view.lastActivity && Date.now() - Date.parse(view.lastActivity) > QUIET_MS;
  const bits = [`Started ${timeAgo(view.startedAt)}`];
  if (view.total > 0) bits.push(`${view.passed} of ${view.total} pieces passed`);
  if (view.background > 0) bits.push(`${view.background} agent${view.background === 1 ? "" : "s"} working`);
  if (view.branch) bits.push(view.branch);
  const t = tones(theme);
  return (
    <View style={{ gap: 4 }}>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
        {bits.join("  ·  ")}
      </Text>
      {view.lastActivity ? (
        <Text style={{ color: quiet ? t.amber.ink : theme.colors.foregroundMuted, fontSize: 12, fontWeight: quiet ? "700" : "400" }}>
          {quiet ? `Quiet for ${ago(view.lastActivity)}. It may be stuck.` : `Last activity ${timeAgo(view.lastActivity)}`}
        </Text>
      ) : null}
      {!!view.routing?.length && (
        <View style={{ gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showRouting }} onPress={() => setShowRouting(!showRouting)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", alignSelf: "flex-start" }}>
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
              {showRouting ? "Hide worker routing ▴" : `Worker routing (${view.routing.length}) ▾`}
            </Text>
          </Pressable>
          {showRouting && (
            <View style={{ gap: 3, backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 }}>
              {view.routing.map(line => (
                <Text key={line} selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "Menlo", lineHeight: 18 }}>
                  {line}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
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

export function Steering({ id, theme, compact = false }: { id: string; theme: PluginTheme; compact?: boolean }) {
  const send=useRpc(steerRpc);
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit() {
    if (!note.trim() || busy) return;
    setBusy(true);
    try { await send({id,text:note}); setNote(""); setError(""); }
    catch(e) { setError(formatRpcError(e)); } finally { setBusy(false); }
  }
  if (compact) {
    const disabled = busy || !note.trim();
    return (
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextInput
            accessibilityLabel="Steer this run"
            placeholder="Steer this run or message the active worker…"
            placeholderTextColor={theme.colors.foregroundMuted}
            onSubmitEditing={() => void submit()}
            style={{
              flex: 1,
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: palette[scheme(theme)].edge,
              borderRadius: 7,
              paddingHorizontal: 10,
              paddingVertical: 8,
              minHeight: MIN_HIT_HEIGHT,
              fontSize: 13,
            }}
            value={note}
            onChangeText={setNote}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => void submit()}
            style={{
              minHeight: MIN_HIT_HEIGHT,
              justifyContent: "center",
              paddingHorizontal: 14,
              borderRadius: 7,
              backgroundColor: disabled ? theme.colors.surface1 : theme.colors.accent,
              borderWidth: disabled ? 1 : 0,
              borderColor: palette[scheme(theme)].edge,
            }}
          >
            <Text style={{ color: disabled ? theme.colors.foregroundMuted : theme.colors.accentForeground, fontSize: 13, fontWeight: "700" }}>
              {busy ? "Sending…" : "Steer"}
            </Text>
          </Pressable>
        </View>
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>}
      </View>
    );
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

export function resolveSelectedStage(view: TaskView, picked?: string) {
  const pieces = view.steps.flatMap(step => step.pieces);
  const stages = pieces.flatMap(piece => piece.phases.map(phase => ({ ...phase, piece })));
  return (
    stages.find(stage => stage.stage === picked) ||
    stages.find(stage => ["running", "asking", "sent-back", "failed"].includes(stage.status)) ||
    stages.find(stage => stage.piece.id === view.selected) ||
    stages[0]
  );
}

/** Contextual inspector for the selected graph piece (rendered in the right pane Details tab, or inline on standalone threads). */
export function TaskInspector({ theme, view, selectedStage, onSelectStage, stacked = true }: {
  theme: PluginTheme;
  view: TaskView;
  selectedStage?: string;
  onSelectStage?: (stage: string) => void;
  stacked?: boolean;
}) {
  const [localPicked, setLocalPicked] = useState<string | undefined>();
  const [showTranscript, setShowTranscript] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const t = tones(theme);
  const picked = selectedStage ?? localPicked;
  const setPicked = (stage: string) => {
    setLocalPicked(stage);
    setShowTranscript(false);
    onSelectStage?.(stage);
  };
  const selected = resolveSelectedStage(view, picked);
  const tries = selected ? view.attempts[selected.stage] || [] : [];
  const lastThread = tries[tries.length - 1]?.threadId;
  const activity = view.runActivity;
  const selectedChecks = selected ? selected.piece.doneWhen.filter(item => !view.completionCriteria?.includes(item)) : [];
  return (
    <View style={{ gap: 12 }}>
      {selected ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700", flexShrink: 1 }}>
              {selected.piece.id} · {selected.piece.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {selected.piece.handoff && (
                <View style={{ backgroundColor: t.green.soft, borderRadius: 5, paddingVertical: 4, paddingHorizontal: 8 }}>
                  <Text style={{ color: t.green.ink, fontSize: 12, fontWeight: "700" }}>Handed off via memory</Text>
                </View>
              )}
              <Pill
                theme={theme}
                status={selected.piece.status}
                label={
                  selected.piece.sentBack
                    ? selected.piece.status === "sent-back"
                      ? `SENT BACK · ${selected.piece.sentBack}×`
                      : `${STATUS_LABEL[selected.piece.status].toUpperCase()} · SENT BACK ${selected.piece.sentBack}`
                    : STATUS_LABEL[selected.piece.status].toUpperCase()
                }
              />
            </View>
          </View>
          {(selected.piece.rung || selected.piece.progress) && (
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              {!!selected.piece.rung && (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "Menlo" }}>
                  Worker · {selected.piece.rung}
                </Text>
              )}
              {!!selected.piece.progress && (
                <Text style={{ color: t.blue.ink, fontSize: 12, fontWeight: "600" }}>
                  Now: {selected.piece.progress}
                </Text>
              )}
            </View>
          )}
          {activity?.retryReason && (
            <View style={{ gap: 4, backgroundColor: t.amber.soft, borderWidth: 1, borderColor: theme.colors.border, borderLeftWidth: 3, borderLeftColor: t.amber.ink, borderRadius: 7, padding: 10 }}>
              <Text style={{ color: t.amber.ink, fontSize: 12, fontWeight: "700" }}>Why it was sent back</Text>
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 19 }}>{activity.retryReason}</Text>
            </View>
          )}
          {selected.piece.phases.length > 1 && <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {selected.piece.phases.map(phase => {
              const phaseTries = view.attempts[phase.stage] ?? [];
              const first = phaseTries[0], last = phaseTries[phaseTries.length - 1];
              const active = phase.stage === selected.stage;
              return <Pressable key={phase.stage} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={() => setPicked(phase.stage)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: active ? theme.colors.surface2 : "transparent" }}>
                <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" }}>
                  <Text style={{ color: hue(phase.status, theme).ink }}>{PHASE_GLYPH[phase.status]} </Text>
                  {phase.label}
                  {phaseTries.length ? ` · ${duration(first.startedAt, phase.status === "passed" ? last.endedAt : undefined)}` : ""}
                </Text>
              </Pressable>;
            })}
          </View>}
          {selectedChecks.length > 0 && (
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>DONE WHEN THESE PASS</Text>
              {selectedChecks.map((item, i) => (
                <Text key={i} selectable style={{ fontFamily: "Menlo", color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>$ {item}</Text>
              ))}
            </View>
          )}
          <StageAttempts key={selected.stage} theme={theme} tries={tries} stacked={stacked} />
          {!tries.length && selected.piece.rung && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{selected.piece.rung}</Text>}
          {!tries.length && selected.piece.progress && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{selected.piece.progress}</Text>}
          {lastThread && (
            <View>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTranscript }} onPress={() => setShowTranscript(!showTranscript)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>{showTranscript ? "Hide agent transcript ▴" : "View agent transcript ▸"}</Text>
              </Pressable>
              {showTranscript && <Transcript key={selected.stage} theme={theme} threadId={lastThread} tries={tries} />}
            </View>
          )}
        </View>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Select a piece in the flow graph to inspect its evidence and judge verdict.</Text>
      )}
      {view.savedPlanIntent && (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showPlan }} onPress={() => setShowPlan(!showPlan)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
            <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>{showPlan ? "Hide saved plan ▴" : "View saved plan ▸"}</Text>
          </Pressable>
          {showPlan && <FormattedBody theme={theme} text={view.savedPlanIntent} />}
        </View>
      )}
      {view.diff && (view.diff.commits > 0 || view.diff.files > 0) && (
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {view.diff.commits} commits · {view.diff.files} changed files · +{view.diff.insertions} −{view.diff.deletions}
        </Text>
      )}
      <RunEvidence view={view} theme={theme} />
    </View>
  );
}

export function TaskScreen({ theme, view, back, openAgent, embeddedSupervisor = false, externalPendingFor, selectedStage, onSelectStage }: {
  theme: PluginTheme;
  view: TaskView;
  back: () => void;
  openAgent?: (id: string) => void;
  embeddedSupervisor?: boolean;
  externalPendingFor?: string | null;
  selectedStage?: string;
  onSelectStage?: (stage: string) => void;
}) {
  const answer=useRpc(answerRpc), cache=useQueryClient();
  const [reply,setReply]=useState(""),[retryError,setRetryError]=useState(""),[retrying,setRetrying]=useState(false);
  const [localPicked, setLocalPicked] = useState<string | undefined>();
  const [showPrompt, setShowPrompt] = useState(false);
  const t = tones(theme);
  const edge = palette[scheme(theme)].edge;
  async function sendAnswer(text: string, allowFullAccess?: boolean){
    setRetrying(true);
    try{const r=await answer({kind:view.kind,id:view.id,text,askKey:view.askKey,...(allowFullAccess?{allowAntigravityFullAccess:true}:{})});if(!r.ok)throw Error(r.error);setReply("");setRetryError("");await cache.invalidateQueries({queryKey:["clyde"]});}
    catch(e){setRetryError(formatRpcError(e));}finally{setRetrying(false);}
  }
  const picked = selectedStage ?? localPicked;
  const setPicked = (stage: string) => {
    setLocalPicked(stage);
    onSelectStage?.(stage);
  };
  const selected = resolveSelectedStage(view, picked);
  const activity = view.runActivity;
  const [pendingFor, setPendingFor] = useState<string | null>();
  const effectivePendingFor = embeddedSupervisor ? externalPendingFor : pendingFor;
  const waiting = !!effectivePendingFor;
  const hasFullPrompt = Boolean(view.goal && view.goal !== view.name && !view.savedPlanIntent?.startsWith(view.goal.replace(/…$/, "")));
  const headline = waiting ? "Worker needs your permission" : effectivePendingFor === null && activity?.permissionAgentId ? "Worker is working on this task" : activity?.headline || view.summary || STATUS_LABEL[view.status];
  const stripTone = waiting || view.status === "asking" ? t.amber : view.status === "failed" ? t.red : view.status === "done" || view.status === "passed" ? t.green : t.blue;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <Pressable accessibilityRole="button" onPress={back} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
          <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>‹ {embeddedSupervisor ? "Back to board" : "Back"}</Text>
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {hasFullPrompt && (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showPrompt }}
              onPress={() => setShowPrompt(!showPrompt)}
              style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: edge }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
                {showPrompt ? "Hide prompt ▴" : "Show prompt ▾"}
              </Text>
            </Pressable>
          )}
          {(view.status === "running" || view.status === "asking") && <StopButton theme={theme} view={view} />}
          <RemoveTask theme={theme} kind={view.kind} id={view.id} name={view.name} active={["running", "asking", "sent-back"].includes(view.status)} onRemoved={back} />
        </View>
      </View>

      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700", flexShrink: 1 }}>{view.name}</Text>
        <Pill theme={theme} status={view.status} />
      </View>
      <RunSummary theme={theme} view={view} />
      {showPrompt && hasFullPrompt && (
        <View style={{ backgroundColor: theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 }}>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }}>{view.goal}</Text>
        </View>
      )}

      {/* Compact live status strip above the DAG */}
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          backgroundColor: theme.colors.surface2,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderLeftWidth: 3,
          borderLeftColor: stripTone.ink,
          borderRadius: 8,
          paddingVertical: 9,
          paddingHorizontal: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: stripTone.ink }} />
          <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 19, fontWeight: "600", flexShrink: 1 }}>
            {headline}
          </Text>
        </View>
        {!!selected?.piece.sentBack && (
          <View style={{ backgroundColor: t.amber.soft, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 }}>
            <Text style={{ color: t.amber.ink, fontSize: 12, fontWeight: "700" }}>Sent back {selected.piece.sentBack}×</Text>
          </View>
        )}
      </View>

      {/* Actionable questions / approvals sit directly above the DAG */}
      {view.question ? (
        <View style={{ borderLeftWidth: 3, borderLeftColor: t.amber.ink, backgroundColor: theme.colors.surface2, borderRadius: 8, padding: 12, gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14, lineHeight: 20 }}>{view.question}</Text>
          {view.retryable ? (
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {view.commitReview && view.agentId && openAgent && <Pressable accessibilityRole="button" onPress={() => openAgent(view.agentId!)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
                <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>Review worktree changes in Paseo</Text>
              </Pressable>}
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
              {(!embeddedSupervisor || /originating Paseo (agent|workspace)/i.test(view.question)) && !activity?.permissionAgentId && <OpenChatButton theme={theme} kind={view.kind} id={view.id} openAgent={openAgent} onError={setRetryError} />}
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
        <View style={{ gap: 8 }}>
          <OpenChatButton theme={theme} kind={view.kind} id={view.id} openAgent={openAgent} onError={setRetryError} />
          {!!retryError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{retryError}</Text>}
        </View>
      ) : null}

      <OrchestrationFlow theme={theme} view={view} selectedStage={selected?.stage} onSelect={stage => setPicked(stage)} onOpenAgent={openAgent} />

      {/* Non-embedded standalone threads keep inspector + permissions + steering inline */}
      {!embeddedSupervisor && view.kind === "run" && ["running", "asking", "sent-back"].includes(view.status) && (
        <WorkerPermissions key={view.id} theme={theme} runId={view.id} openAgent={openAgent} onPending={setPendingFor} expected={!!activity?.permissionAgentId} />
      )}
      {!embeddedSupervisor && (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 14, gap: 12 }}>
          <TaskInspector theme={theme} view={view} selectedStage={selected?.stage} onSelectStage={setPicked} stacked={false} />
          {view.kind === "run" && view.status === "running" && <Steering id={view.id} theme={theme} />}
        </View>
      )}
    </View>
  );
}
