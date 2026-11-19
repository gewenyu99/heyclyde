import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { TaskView } from "../shared/clyde";
import { MIN_HIT_HEIGHT, safeHttpsUrl, tones } from "./palette";

/** Show the latest attempt for each stage. Historical attempts stay in the flow inspector. */
export function RunEvidence({ view, theme }: { view: TaskView; theme: PluginTheme }) {
  const [expanded, setExpanded] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const c = theme.colors;
  const t = tones(theme);
  const prUrl = safeHttpsUrl(view.pullRequest);
  const checks = Object.entries(view.attempts).flatMap(([stage, attempts]) => {
    const latest = attempts.at(-1);
    return latest?.checks.map((check, i) => ({ ...check, stage, key: stage + "/" + latest.n + "/" + i })) ?? [];
  });
  const failed = checks.filter((check) => check.code !== 0);
  const visible = expanded ? checks : failed.slice(0, 2);
  return (
    <View style={{ gap: 7, marginTop: 12 }}>
      {prUrl && (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open pull request ${prUrl}`}
          onPress={() => void Linking.openURL(prUrl)}
          style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
        >
          <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: t.blue.ink, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
            Pull request · {prUrl} ↗
          </Text>
        </Pressable>
      )}
      {!!view.completionCriteria?.length &&
        !(view.completionCriteria.length === 1 && view.completionCriteria[0] === view.goal) && (
        <View style={{ gap: 3 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700" }}>DONE WHEN</Text>
          {view.completionCriteria.map((criterion, i) => (
            <Text key={i} style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>{criterion}</Text>
          ))}
        </View>
      )}
      <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700" }}>VERIFICATION</Text>
      {!!view.verifiedNotes?.length && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showNotes }}
            onPress={() => setShowNotes(!showNotes)}
            style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
          >
            <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>
              {view.verifiedNotes.length} verified memory indexes · {new Set(view.verifiedNotes.flatMap((n) => n.sources)).size} source notes {showNotes ? "▴" : "▾"}
            </Text>
          </Pressable>
          {showNotes && view.verifiedNotes.map((n) => (
            <View key={n.id} style={{ gap: 2 }}>
              <Text style={{ color: c.foreground, fontSize: 13 }}>{n.title}</Text>
              <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{n.id}</Text>
            </View>
          ))}
        </>
      )}
      {!!view.auditedHead && (
        <Text selectable style={{ color: c.foreground, fontSize: 13 }}>
          Audited revision · {view.auditedHead.slice(0, 12)}
        </Text>
      )}
      {checks.length
        ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded(!expanded)}
              style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}
            >
              <Text style={{ color: failed.length ? c.statusDanger : c.accent, fontWeight: "600", fontSize: 13 }}>
                {checks.length - failed.length} of {checks.length} stage checks passed {expanded ? "▴" : "▾"}
              </Text>
            </Pressable>
            {visible.map((check) => (
              <View key={check.key} style={{ padding: 8, backgroundColor: c.surface2, borderRadius: 5, gap: 3 }}>
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{check.stage} · exit {check.code}</Text>
                <Text selectable style={{ fontFamily: "Menlo", color: c.foreground, fontSize: 12 }}>{check.cmd}</Text>
                {!!check.output && (
                  <Text
                    selectable
                    numberOfLines={expanded ? undefined : 2}
                    style={{ color: c.foregroundMuted, fontSize: 12 }}
                  >
                    {check.output}
                  </Text>
                )}
              </View>
            ))}
          </>
        )
        : !view.verifiedNotes?.length && !prUrl && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>No stage check results recorded.</Text>}
    </View>
  );
}
